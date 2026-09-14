import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { createAdmitadAdapter } = await import("../src/adapters/admitad.adapter.js");
const { SUPPLIER_CAPABILITIES, CAPABILITY_METHODS } = await import("../src/adapters/contract.js");
const { SUPPLIER_CAPABILITY_CATALOG } = await import("../src/adapters/registry.js");

const ADAPTER_SRC = readFileSync("src/adapters/admitad.adapter.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/admitadSupplierSync.js", "utf8");

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Code with the `notes: [...]` documentation arrays removed as well.
 *
 * Those notes are where a removed capability is RECORDED — "DEEP_LINK ... is now undeclared:
 * NO_ENDPOINT_IN_INTEGRATION" — so scanning them for the absence of the word would make writing
 * the finding down fail the test that checks the finding is true. Separate assertions below
 * require those very notes to exist.
 */
function implementationOf(source) {
  return codeOf(source).replace(/notes: \[[^\]]*\],?/g, "notes: [],");
}

const adapter = createAdmitadAdapter({ accessToken: "zztokenzz" });
const declared = adapter.getCapabilities().capabilities;
const registryDeclared = SUPPLIER_CAPABILITY_CATALOG.ADMITAD.capabilities;

/**
 * What Admitad must be able to SHOW for each capability it declares.
 *
 * CAPABILITY_METHODS covers the method-backed capabilities, and assertAdapterContract already
 * enforces those. The descriptive ones — DEEP_LINK, TRACKING_SUBID, REPORTING and the rest — carry
 * no method requirement, which is precisely the hole DEEP_LINK sat in for as long as it was
 * declared: nothing could ever have caught it.
 *
 * So every capability Admitad declares needs named evidence here, method-backed or not. A new
 * declaration with no entry fails; an entry whose evidence disappears from the code fails too.
 */
const ADMITAD_CAPABILITY_EVIDENCE = Object.freeze({
  [SUPPLIER_CAPABILITIES.CAMPAIGNS]: {
    method: "fetchCampaigns",
    adapterEvidence: ['"/advcampaigns/"'],
    callerEvidence: ["adapter.fetchCampaigns("],
  },
  [SUPPLIER_CAPABILITIES.COUPONS]: {
    method: "fetchCoupons",
    adapterEvidence: ['"/coupons/"'],
    callerEvidence: ["adapter.fetchCoupons("],
  },
  [SUPPLIER_CAPABILITIES.CONVERSIONS]: {
    method: "fetchConversions",
    adapterEvidence: ['"/statistics/actions/"'],
    callerEvidence: ["adapter.fetchConversions("],
  },
  [SUPPLIER_CAPABILITIES.TRACKING_SUBID]: {
    // Descriptive: no fetcher of its own. Its evidence is that an implemented fetcher genuinely
    // carries subids — filterable on the request, and preserved on every row that comes back.
    method: null,
    adapterEvidence: ['"subid1"', "subid1: input.subid1", "normalizeAdmitadActionEvidence"],
    callerEvidence: ["adapter.fetchConversions("],
  },
  [SUPPLIER_CAPABILITIES.REPORTING]: {
    method: null,
    adapterEvidence: ["async fetchPerformance"],
    callerEvidence: ["adapter.fetchConversions("],
  },
});

describe("Admitad declares no capability it cannot show evidence for", () => {
  it("has an evidence entry for every capability the adapter declares", () => {
    for (const capability of declared) {
      assert.ok(
        Object.hasOwn(ADMITAD_CAPABILITY_EVIDENCE, capability),
        `${capability} is declared with no evidence entry — add the evidence, not the exemption`,
      );
    }
  });

  it("declares nothing the evidence table does not cover, and covers nothing undeclared", () => {
    assert.deepEqual([...declared].sort(), Object.keys(ADMITAD_CAPABILITY_EVIDENCE).sort());
  });

  it("exposes a callable method for every method-backed capability", () => {
    for (const [capability, evidence] of Object.entries(ADMITAD_CAPABILITY_EVIDENCE)) {
      const method = evidence.method ?? CAPABILITY_METHODS[capability] ?? null;
      if (!method) continue;
      assert.equal(typeof adapter[method], "function", `${capability} → ${method}`);
    }
  });

  it("can point at real adapter code for every declared capability", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const [capability, evidence] of Object.entries(ADMITAD_CAPABILITY_EVIDENCE)) {
      for (const marker of evidence.adapterEvidence) {
        assert.ok(code.includes(marker), `${capability}: adapter evidence missing — ${marker}`);
      }
    }
  });

  it("can point at a production caller for every declared capability", () => {
    const code = codeOf(SYNC_SRC);
    for (const [capability, evidence] of Object.entries(ADMITAD_CAPABILITY_EVIDENCE)) {
      for (const marker of evidence.callerEvidence) {
        assert.ok(code.includes(marker), `${capability}: no production caller — ${marker}`);
      }
    }
  });

  it("keeps the adapter and the registry telling the same story", () => {
    assert.deepEqual([...declared].sort(), [...registryDeclared].sort());
  });
});

describe("DEEP_LINK is undeclared, because nothing implements it", () => {
  it("is absent from the adapter's declared capabilities", () => {
    assert.ok(!declared.includes(SUPPLIER_CAPABILITIES.DEEP_LINK));
  });

  it("is absent from the registry capability catalog", () => {
    assert.ok(!registryDeclared.includes(SUPPLIER_CAPABILITIES.DEEP_LINK));
  });

  it("has no builder, endpoint, method or path anywhere in the Admitad adapter", () => {
    const code = implementationOf(ADAPTER_SRC);
    for (const absent of [
      "DEEP_LINK",
      "deeplink",
      "deepLink",
      "buildDeepLink",
      "fetchDeepLink",
      "gotolink",
      "goto_link",
      "trackingUrl",
      "tracking_url",
    ]) {
      assert.ok(!code.includes(absent), absent);
    }
  });

  it("has no Admitad deeplink implementation anywhere in src/", () => {
    // The capability was declared and never built. Nothing in the tree contradicts removing it.
    //
    // Scoped to ADMITAD's own code, not to any file that happens to mention Admitad: registry.js
    // carries every supplier's declarations, and Awin, CJ and Impact legitimately declare
    // DEEP_LINK there. A file-level scan would read their truth as Admitad's.
    const DEEPLINK = /deep_?link|gotolink|goto_link/i;
    const ADMITAD_OWN_FILES = new Set([
      "src/adapters/admitad.adapter.js",
      "src/jobs/admitadSupplierSync.js",
      "src/modules/integrations/admitadCredentials.js",
      "src/modules/integrations/admitadTokenProvider.js",
    ]);

    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".js")) continue;
        const code = implementationOf(readFileSync(full, "utf8"));

        if (ADMITAD_OWN_FILES.has(full)) {
          // Every line of these files is Admitad's, so any deeplink token is Admitad's.
          if (DEEPLINK.test(code)) hits.push(full);
          continue;
        }

        // Elsewhere, a hit counts only where the deeplink token and Admitad are the same line —
        // an Admitad-specific deeplink branch in shared code.
        for (const line of code.split("\n")) {
          if (/admitad/i.test(line) && DEEPLINK.test(line)) hits.push(`${full}: ${line.trim()}`);
        }
      }
    };
    walk("src");
    assert.deepEqual(hits, []);
  });

  it("covers every Admitad-owned source file in that scan", () => {
    // If an Admitad file is added and not listed, the scan above silently weakens to a per-line
    // check for it. This fails instead.
    const owned = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (/^admitad/i.test(entry.name) && entry.name.endsWith(".js")) owned.push(full);
      }
    };
    walk("src");
    assert.deepEqual(owned.sort(), [
      "src/adapters/admitad.adapter.js",
      "src/jobs/admitadSupplierSync.js",
      "src/modules/integrations/admitadCredentials.js",
      "src/modules/integrations/admitadTokenProvider.js",
    ]);
  });

  it("does not let allow_deeplink stand in for an implementation", () => {
    // allow_deeplink is a field on a programme row: supplier permission, not MBO capability.
    // It must not appear in the adapter as anything that gates or justifies a capability. The
    // registry note that explains this is documentation and is asserted separately.
    const code = implementationOf(ADAPTER_SRC);
    assert.ok(!code.includes("allow_deeplink"));
  });

  it("records the removal as NO_ENDPOINT_IN_INTEGRATION in the registry notes", () => {
    const notes = SUPPLIER_CAPABILITY_CATALOG.ADMITAD.notes.join(" ");
    assert.match(notes, /NO_ENDPOINT_IN_INTEGRATION/);
    assert.match(notes, /allow_deeplink/);
  });

  it("records it on the adapter's own notes too, not only in the registry", () => {
    // Both declarations were wrong, so both carry the finding. A reader holding only the adapter
    // must be able to see why DEEP_LINK is absent rather than assume it was never considered.
    const notes = adapter.getCapabilities().notes.join(" ");
    assert.match(notes, /NO_ENDPOINT_IN_INTEGRATION/);
    assert.match(notes, /allow_deeplink/);
  });
});

describe("TRACKING_SUBID is kept, because the read path genuinely carries subids", () => {
  it("stays declared in both the adapter and the registry", () => {
    assert.ok(declared.includes(SUPPLIER_CAPABILITIES.TRACKING_SUBID));
    assert.ok(registryDeclared.includes(SUPPLIER_CAPABILITIES.TRACKING_SUBID));
  });

  it("accepts every subid as a request filter", async () => {
    const { buildAdmitadActionParams } = await import("../src/adapters/admitad.adapter.js");
    const params = buildAdmitadActionParams({
      subid: "zzsubidzz",
      subid1: "zzonezz",
      subid2: "zztwozz",
      subid3: "zzthreezz",
      subid4: "zzfourzz",
    });
    assert.equal(params.subid, "zzsubidzz");
    for (const n of [1, 2, 3, 4]) {
      assert.equal(params[`subid${n}`], `zz${["one", "two", "three", "four"][n - 1]}zz`);
    }
  });

  it("preserves every subid on an action row", async () => {
    const { normalizeAdmitadActionEvidence } = await import("../src/adapters/admitad.adapter.js");
    const row = normalizeAdmitadActionEvidence({
      action_id: 1,
      subid: "zzsubidzz",
      subid1: "zzonezz",
      subid2: "zztwozz",
      subid3: "zzthreezz",
      subid4: "zzfourzz",
    });
    assert.equal(row.subid, "zzsubidzz");
    assert.equal(row.subid1, "zzonezz");
    assert.equal(row.subid4, "zzfourzz");
  });

  it("returns null rather than inventing a subid that was absent", async () => {
    const { normalizeAdmitadActionEvidence } = await import("../src/adapters/admitad.adapter.js");
    const row = normalizeAdmitadActionEvidence({ action_id: 1 });
    for (const key of ["subid", "subid1", "subid2", "subid3", "subid4"]) {
      assert.equal(row[key], null, key);
    }
  });

  it("runs every fetched action row through the evidence normaliser", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchConversions")[1]
      .split("async fetchPerformance")[0];
    assert.match(production, /\.map\(normalizeAdmitadActionEvidence\)/);
  });

  it("records the read-only gap rather than overclaiming", () => {
    // No outbound injection exists, and both declarations say so instead of leaving a reader to
    // assume TRACKING_SUBID means MBO can stamp a subid onto an Admitad link.
    for (const [where, notes] of [
      ["registry", SUPPLIER_CAPABILITY_CATALOG.ADMITAD.notes.join(" ")],
      ["adapter", adapter.getCapabilities().notes.join(" ")],
    ]) {
      assert.match(notes, /read evidence only|read-only/i, where);
      assert.match(notes, /inject/i, where);
    }
    assert.ok(!codeOf(ADAPTER_SRC).includes("injectSubid"));
  });
});

describe("the rest of the Admitad integration is untouched", () => {
  it("keeps every other declared capability", () => {
    for (const kept of [
      SUPPLIER_CAPABILITIES.CAMPAIGNS,
      SUPPLIER_CAPABILITIES.COUPONS,
      SUPPLIER_CAPABILITIES.CONVERSIONS,
      SUPPLIER_CAPABILITIES.REPORTING,
    ]) {
      assert.ok(declared.includes(kept), kept);
      assert.ok(registryDeclared.includes(kept), kept);
    }
  });

  it("keeps every data path exactly as it was", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const path of [
      '"/websites/v2/"',
      '"/advcampaigns/"',
      '"/coupons/"',
      '"/statistics/actions/"',
    ]) {
      assert.ok(code.includes(path), path);
    }
  });

  it("changes no auth, sync or commission behaviour", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /apiKey: `Bearer \$\{accessToken\}`/);
    assert.match(code, /networkRawStatus: input\.status \?\? null/);
    assert.match(codeOf(SYNC_SRC), /buildAdmitadIncrementalActionParams/);
  });

  it("leaves other suppliers' DEEP_LINK declarations alone", () => {
    // Those are other suppliers' truth to establish; this task audited Admitad only.
    for (const supplier of ["AWIN", "CJ", "IMPACT"]) {
      assert.ok(
        SUPPLIER_CAPABILITY_CATALOG[supplier].capabilities.includes(
          SUPPLIER_CAPABILITIES.DEEP_LINK,
        ),
        supplier,
      );
    }
  });
});
