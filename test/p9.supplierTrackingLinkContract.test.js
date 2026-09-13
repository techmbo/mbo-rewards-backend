import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_DESTINATION_FALLBACK_SUPPLIERS,
  NEEDS_TRACKING_HOST_EVIDENCE,
  SUPPLIER_TRACKING_HOST_ALLOWLIST,
  SUPPLIER_TRACKING_LINK_PROVENANCE,
  SUPPLIER_TRACKING_LINK_REQUIRED,
  SUPPLIER_TRACKING_LINK_STATE,
  SUPPLIER_TRACKING_LINK_STATES,
  SupplierTrackingLinkValidationError,
  TRACKING_HOST_EVIDENCE,
  classifyTrackingUrlForAudit,
  hostMatchesAllowlist,
  isSupplierTrackingLinkUsable,
  mergeSupplierTrackingLinkOnSync,
  supplierAllowsDestinationTrackingFallback,
  trackingHostPolicyFor,
  validateSupplierTrackingUrl,
} from "../src/modules/tracking/supplierTrackingLink.contract.js";

const PARTNERIZE_LINK = "https://prf.hn/click/camref:1101lAbCd";
const DESTINATION = "https://www.merchant-example.com/offers/spring";

/* ---------------------------------------------------------------- states */

test("the four required states exist and are distinct", () => {
  assert.deepEqual(SUPPLIER_TRACKING_LINK_STATES, [
    "TRACKING_LINK_NOT_GENERATED",
    "TRACKING_LINK_AVAILABLE",
    "TRACKING_LINK_NEEDS_REVIEW",
    "TRACKING_LINK_REVOKED",
  ]);
  assert.equal(new Set(SUPPLIER_TRACKING_LINK_STATES).size, 4);
});

test("state is not derivable from trackingUrl == null alone", () => {
  // Three records all have a null URL but three different, meaningful states.
  const never = { trackingUrl: null, supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.NOT_GENERATED };
  const revoked = { trackingUrl: null, supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.REVOKED };
  const review = { trackingUrl: null, supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.NEEDS_REVIEW };
  const states = new Set([
    never.supplierTrackingLinkState,
    revoked.supplierTrackingLinkState,
    review.supplierTrackingLinkState,
  ]);
  assert.equal(states.size, 3, "null trackingUrl must not collapse to a single state");
  for (const record of [never, revoked, review]) {
    assert.equal(isSupplierTrackingLinkUsable(record), false);
  }
});

test("only AVAILABLE with a stored URL is usable for monetized traffic", () => {
  assert.equal(
    isSupplierTrackingLinkUsable({
      trackingUrl: PARTNERIZE_LINK,
      supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
    }),
    true,
  );
  // A URL present but state REVOKED must not be usable.
  assert.equal(
    isSupplierTrackingLinkUsable({
      trackingUrl: PARTNERIZE_LINK,
      supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.REVOKED,
    }),
    false,
  );
  assert.equal(
    isSupplierTrackingLinkUsable({
      trackingUrl: "   ",
      supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
    }),
    false,
  );
});

test("SUPPLIER_API provenance is declared but never implied to be active", () => {
  assert.equal(SUPPLIER_TRACKING_LINK_PROVENANCE.SUPPLIER_API, "SUPPLIER_API");
  assert.equal(SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN, "MANUAL_ADMIN");
});

/* ------------------------------------------------------------ validation */

test("REQUIRED 10: non-https schemes are rejected", () => {
  const cases = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "blob:https://prf.hn/abc",
    "about:blank",
    "ftp://prf.hn/x",
    "http://prf.hn/click/camref:1",
  ];
  for (const value of cases) {
    assert.throws(
      () => validateSupplierTrackingUrl(value, { supplier: "PARTNERIZE" }),
      (error) => {
        assert.ok(error instanceof SupplierTrackingLinkValidationError, value);
        assert.equal(error.code, "TRACKING_URL_SCHEME_REJECTED", value);
        return true;
      },
      value,
    );
  }
});

test("REQUIRED 10: a scheme outside the explicit denylist is still rejected", () => {
  // The denylist alone is not sufficient: only an https allowlist closes the set.
  for (const value of ["ws://prf.hn/click", "wss://prf.hn/click", "gopher://prf.hn/1"]) {
    assert.throws(
      () => validateSupplierTrackingUrl(value, { supplier: "PARTNERIZE" }),
      (error) => {
        assert.equal(error.code, "TRACKING_URL_SCHEME_REJECTED", value);
        return true;
      },
      value,
    );
  }
});

test("relative and malformed values are rejected", () => {
  for (const value of ["/click/camref:1", "prf.hn/click", "not a url"]) {
    assert.throws(() => validateSupplierTrackingUrl(value, { supplier: "PARTNERIZE" }));
  }
  assert.throws(
    () => validateSupplierTrackingUrl("", { supplier: "PARTNERIZE" }),
    (e) => e.code === "TRACKING_URL_REQUIRED",
  );
  assert.throws(
    () => validateSupplierTrackingUrl(`https://prf.hn/${"a".repeat(2100)}`, { supplier: "PARTNERIZE" }),
    (e) => e.code === "TRACKING_URL_TOO_LONG",
  );
});

test("embedded credentials are rejected", () => {
  assert.throws(
    () => validateSupplierTrackingUrl("https://user:pass@prf.hn/click/camref:1", { supplier: "PARTNERIZE" }),
    (e) => e.code === "TRACKING_URL_CREDENTIALS_REJECTED",
  );
});

test("REQUIRED 11: non-allowlisted hosts are rejected for Partnerize", () => {
  const rejected = [
    DESTINATION,
    "https://www.merchant-example.com/prf.hn",
    "https://prf.hn.evil.com/click",
    "https://notprf.hn/click",
    "https://api.partnerize.com/user/publisher",
  ];
  for (const value of rejected) {
    assert.throws(
      () => validateSupplierTrackingUrl(value, { supplier: "PARTNERIZE" }),
      (error) => {
        assert.equal(error.code, "TRACKING_HOST_NOT_ALLOWLISTED", value);
        return true;
      },
      value,
    );
  }
});

test("an evidenced Partnerize tracking host is accepted, subdomains included", () => {
  const result = validateSupplierTrackingUrl(PARTNERIZE_LINK, { supplier: "PARTNERIZE" });
  assert.equal(result.url, PARTNERIZE_LINK);
  assert.equal(result.hostname, "prf.hn");
  assert.equal(result.evidence, TRACKING_HOST_EVIDENCE.EVIDENCED_IN_REPO);

  assert.equal(
    validateSupplierTrackingUrl("https://uk.prf.hn/click/camref:1", { supplier: "PARTNERIZE" }).hostname,
    "uk.prf.hn",
  );
});

test("a supplier with no in-repo host evidence returns NEEDS_TRACKING_HOST_EVIDENCE, not a guessed allowlist", () => {
  for (const supplier of ["OPTIMISE", "AWIN", "BOOSTINY", "TRACKIER", "", null, undefined]) {
    assert.throws(
      () => validateSupplierTrackingUrl("https://prf.hn/click/camref:1", { supplier }),
      (error) => {
        assert.equal(error.code, NEEDS_TRACKING_HOST_EVIDENCE, String(supplier));
        return true;
      },
    );
  }
  assert.equal(trackingHostPolicyFor("OPTIMISE").evidence, TRACKING_HOST_EVIDENCE.NONE);
  assert.deepEqual(trackingHostPolicyFor("OPTIMISE").hosts, []);
});

test("the allowlist is evidence-graded and does not claim supplier confirmation", () => {
  const policy = SUPPLIER_TRACKING_HOST_ALLOWLIST.PARTNERIZE;
  assert.equal(policy.evidence, "EVIDENCED_IN_REPO");
  assert.deepEqual([...policy.hosts], ["prf.hn"]);
  // The REST API host is not a click host and must never be allowlisted.
  assert.ok(!policy.hosts.includes("api.partnerize.com"));
});

test("host matching is dot-bounded and case/trailing-dot insensitive", () => {
  assert.equal(hostMatchesAllowlist("PRF.HN", ["prf.hn"]), true);
  assert.equal(hostMatchesAllowlist("prf.hn.", ["prf.hn"]), true);
  assert.equal(hostMatchesAllowlist("evilprf.hn", ["prf.hn"]), false);
  assert.equal(hostMatchesAllowlist("prf.hn.attacker.net", ["prf.hn"]), false);
  assert.equal(hostMatchesAllowlist("", ["prf.hn"]), false);
});

test("validation is not implemented as 'is not the destination url'", () => {
  // A URL that is neither the destination nor a Partnerize host must still be rejected.
  assert.throws(
    () => validateSupplierTrackingUrl("https://some-other-network.example/click", {
      supplier: "PARTNERIZE",
    }),
    (e) => e.code === "TRACKING_HOST_NOT_ALLOWLISTED",
  );
});

/* ----------------------------------------------------------- merge rule */

test("REQUIRED 6: sync with no incoming link cannot erase a MANUAL_ADMIN link", () => {
  const existing = {
    trackingUrl: PARTNERIZE_LINK,
    supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
    supplierTrackingLinkProvenance: SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN,
  };
  for (const incoming of [null, undefined, "", "   "]) {
    const merged = mergeSupplierTrackingLinkOnSync({ incomingTrackingUrl: incoming, existing });
    assert.equal(merged.trackingUrl, PARTNERIZE_LINK);
    assert.equal(merged.state, SUPPLIER_TRACKING_LINK_STATE.AVAILABLE);
    assert.equal(merged.provenance, SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN);
    assert.equal(merged.retained, true);
  }
});

test("REQUIRED 7: sync cannot overwrite a manual link with a destination URL", () => {
  // The merge only ever receives mapped.trackingUrl. destinationUrl is a different field and is
  // never routed here; a payload carrying only a destination yields no incoming link.
  const existing = {
    trackingUrl: PARTNERIZE_LINK,
    supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
    supplierTrackingLinkProvenance: SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN,
  };
  const merged = mergeSupplierTrackingLinkOnSync({ incomingTrackingUrl: null, existing });
  assert.equal(merged.trackingUrl, PARTNERIZE_LINK);
  assert.notEqual(merged.trackingUrl, DESTINATION);
});

test("a campaign that never had a link stays NOT_GENERATED", () => {
  const merged = mergeSupplierTrackingLinkOnSync({ incomingTrackingUrl: null, existing: null });
  assert.equal(merged.trackingUrl, null);
  assert.equal(merged.state, SUPPLIER_TRACKING_LINK_STATE.NOT_GENERATED);
  assert.equal(merged.provenance, null);
  assert.equal(merged.retained, false);
});

test("a REVOKED link is not silently reset to NOT_GENERATED by a sync", () => {
  const merged = mergeSupplierTrackingLinkOnSync({
    incomingTrackingUrl: null,
    existing: {
      trackingUrl: null,
      supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.REVOKED,
      supplierTrackingLinkProvenance: SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN,
    },
  });
  assert.equal(merged.state, SUPPLIER_TRACKING_LINK_STATE.REVOKED);
});

test("a non-manual stored link is not protected from sync", () => {
  const merged = mergeSupplierTrackingLinkOnSync({
    incomingTrackingUrl: null,
    existing: {
      trackingUrl: PARTNERIZE_LINK,
      supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
      supplierTrackingLinkProvenance: null,
    },
  });
  assert.equal(merged.trackingUrl, null);
  assert.equal(merged.retained, false);
});

test("a real incoming supplier link is stored and marks the campaign AVAILABLE", () => {
  const merged = mergeSupplierTrackingLinkOnSync({
    incomingTrackingUrl: "  https://prf.hn/click/camref:9  ",
    existing: null,
  });
  assert.equal(merged.trackingUrl, "https://prf.hn/click/camref:9");
  assert.equal(merged.state, SUPPLIER_TRACKING_LINK_STATE.AVAILABLE);
});

/* --------------------------------------------- destination fallback ban */

test("REQUIRED 9: Partnerize forbids destinationUrl as a tracking fallback", () => {
  assert.deepEqual([...NO_DESTINATION_FALLBACK_SUPPLIERS], ["PARTNERIZE"]);
  assert.equal(supplierAllowsDestinationTrackingFallback("PARTNERIZE"), false);
  assert.equal(supplierAllowsDestinationTrackingFallback("partnerize"), false);
  assert.equal(supplierAllowsDestinationTrackingFallback(" Partnerize "), false);
});

test("REQUIRED 15: unrelated suppliers keep their existing fallback behaviour", () => {
  for (const supplier of ["OPTIMISE", "AWIN", "BOOSTINY", "TRACKIER", "IMPACT", "VCOMMISSION", null]) {
    assert.equal(supplierAllowsDestinationTrackingFallback(supplier), true, String(supplier));
  }
});

test("SUPPLIER_TRACKING_LINK_REQUIRED is a stable operational code", () => {
  assert.equal(SUPPLIER_TRACKING_LINK_REQUIRED, "SUPPLIER_TRACKING_LINK_REQUIRED");
});

/* ------------------------------------------------------------ audit safety */

test("REQUIRED 14: audit classification exposes host only, never attribution parameters", () => {
  const host = classifyTrackingUrlForAudit("https://prf.hn/click/camref:1101lAbCd?adref=client-9&pubref=a-7");
  assert.equal(host, "prf.hn");
  assert.ok(!host.includes("camref"));
  assert.ok(!host.includes("adref"));
  assert.ok(!host.includes("pubref"));
  assert.ok(!host.includes("1101lAbCd"));
  assert.equal(classifyTrackingUrlForAudit(null), null);
  assert.equal(classifyTrackingUrlForAudit("   "), null);
  assert.equal(classifyTrackingUrlForAudit("garbage"), "unparseable");
});
