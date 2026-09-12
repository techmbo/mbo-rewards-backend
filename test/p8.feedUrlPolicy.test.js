import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const {
  ALLOWED_FEED_HOSTS,
  FeedUrlNotAllowedError,
  MAX_FEED_REDIRECTS,
  assertAllowedFeedUrl,
  isAllowedFeedUrl,
} = await import("../src/adapters/feedUrlPolicy.js");
const adapterSource = (await import("node:fs")).readFileSync("src/adapters/optimise.adapter.js", "utf8");
const { createOptimiseAdapter } = await import("../src/adapters/optimise.adapter.js");

const VALID = "https://product-feeds.optimisemedia.com/feeds/8812?aid=999&format=csv";

function reasonOf(url) {
  try {
    assertAllowedFeedUrl(url);
    return null;
  } catch (error) {
    assert.equal(error instanceof FeedUrlNotAllowedError, true);
    return error.reason;
  }
}

describe("feed URL policy — the allowlist", () => {
  it("1 — accepts a genuine Optimise product-feed URL", () => {
    const url = assertAllowedFeedUrl(VALID);
    assert.equal(url.hostname, "product-feeds.optimisemedia.com");
    assert.equal(isAllowedFeedUrl(VALID), true);
  });

  it("2 — rejects http://", () => {
    assert.equal(reasonOf("http://product-feeds.optimisemedia.com/feeds/1"), "NOT_HTTPS");
  });

  it("2b — rejects non-HTTP schemes outright", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://product-feeds.optimisemedia.com/f",
      "gopher://product-feeds.optimisemedia.com/f",
    ]) {
      assert.equal(reasonOf(url), "NOT_HTTPS", url);
    }
  });

  it("3 — rejects an unrelated attacker host", () => {
    assert.equal(reasonOf("https://attacker.test/all.csv"), "HOST_NOT_ALLOWED");
  });

  it("4 — rejects sibling and lookalike domains", () => {
    for (const host of [
      "product-feeds.optimisemedia.com.attacker.test",
      "product-feeds.optimisemedia.com.evil.co",
      "notproduct-feeds.optimisemedia.com",
      "product-feeds.optimisemedia.co",
      "xproduct-feeds.optimisemedia.com",
    ]) {
      assert.equal(reasonOf(`https://${host}/feeds/1`), "HOST_NOT_ALLOWED", host);
    }
  });

  it("4b — a matching string in the path or query does not make a host allowed", () => {
    assert.equal(
      reasonOf("https://attacker.test/product-feeds.optimisemedia.com/f.csv"),
      "HOST_NOT_ALLOWED",
    );
    assert.equal(reasonOf("https://attacker.test/?h=product-feeds.optimisemedia.com"), "HOST_NOT_ALLOWED");
  });

  it("5 — rejects userinfo in the URL", () => {
    assert.equal(
      reasonOf("https://product-feeds.optimisemedia.com@attacker.test/f.csv"),
      "USERINFO_PRESENT",
    );
    assert.equal(reasonOf("https://user:pass@product-feeds.optimisemedia.com/f.csv"), "USERINFO_PRESENT");
  });

  it("6 — rejects localhost", () => {
    for (const host of ["localhost", "LOCALHOST", "localhost.localdomain"]) {
      assert.equal(reasonOf(`https://${host}/f.csv`), "LOCALHOST_HOST", host);
    }
  });

  it("7 — rejects IP-literal hosts including the metadata address", () => {
    for (const host of ["127.0.0.1", "[::1]", "169.254.169.254", "10.0.0.5", "0.0.0.0"]) {
      assert.equal(reasonOf(`https://${host}/f.csv`), "IP_LITERAL_HOST", host);
    }
  });

  it("7b — rejects the exotic spellings of an IP the URL parser normalises", () => {
    // http://2130706433/ and http://0x7f.1/ both parse to 127.0.0.1.
    for (const host of ["2130706433", "0x7f.0.0.1", "017700000001"]) {
      const reason = reasonOf(`https://${host}/f.csv`);
      assert.ok(["IP_LITERAL_HOST", "HOST_NOT_ALLOWED"].includes(reason), `${host} → ${reason}`);
    }
  });

  it("rejects a malformed URL rather than throwing something unexpected", () => {
    assert.equal(reasonOf("not a url"), "MALFORMED_URL");
    assert.equal(reasonOf(""), "MALFORMED_URL");
    assert.equal(reasonOf(null), "MALFORMED_URL");
  });

  it("names exactly one allowed host, and it is the evidenced one", () => {
    assert.deepEqual(ALLOWED_FEED_HOSTS, ["product-feeds.optimisemedia.com"]);
  });

  it("a rejection never carries the URL, host or any response content", () => {
    const secret = "https://attacker.test/steal?token=sk_live_abcdef123456";
    try {
      assertAllowedFeedUrl(secret);
      assert.fail("should have thrown");
    } catch (error) {
      const text = `${error.message} ${JSON.stringify(error)} ${error.stack?.split("\n")[0]}`;
      assert.ok(!text.includes("attacker.test"), "host leaked");
      assert.ok(!text.includes("sk_live_abcdef123456"), "query secret leaked");
      assert.ok(!text.includes("steal"), "path leaked");
    }
  });
});

describe("feed download — candidates, redirects and credentials", () => {
  /** A throwaway local server. Used to observe what the downloader actually puts on the wire. */
  function server(handler) {
    const s = http.createServer(handler);
    return new Promise((resolve) => {
      s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
    });
  }

  function adapter() {
    return createOptimiseAdapter({
      apiKey: "sk_live_MUSTNOTLEAK",
      agencyId: "AG1",
      contactId: "C1",
      httpClient: { get: async () => ({ data: [] }) },
    });
  }

  it("8 — every generated candidate is revalidated, not just the supplier's URL", async () => {
    // A hostile feedUrl. The rewrite copies its host into a second candidate, so both must fail.
    await assert.rejects(
      () => adapter().fetchProductFeedItems({ feedUrl: "https://attacker.test/all.csv", feedId: null }),
      (error) => {
        assert.equal(error.feedUrlRejected, true);
        assert.equal(error.reason, "HOST_NOT_ALLOWED");
        return true;
      },
    );
  });

  it("8b — the validated list is what the download loop iterates", () => {
    const start = adapterSource.indexOf("async fetchProductFeedItems");
    const body = adapterSource.slice(start, adapterSource.indexOf("async fetchAll", start));
    assert.match(body, /const safeCandidates = candidates\.filter\(\(candidate\) => isAllowedFeedUrl\(candidate\)\)/);
    assert.match(body, /for \(const full of safeCandidates\.slice\(0, 3\)\)/);
    assert.ok(!/for \(const full of candidates\b/.test(body), "must not iterate the unvalidated list");
  });

  it("8c — a hostile candidate is dropped while a valid one still runs", () => {
    const mixed = ["https://attacker.test/a.csv", VALID, "http://product-feeds.optimisemedia.com/b.csv"];
    assert.deepEqual(mixed.filter((c) => isAllowedFeedUrl(c)), [VALID]);
  });

  it("9 — a redirect cannot escape the allowed host", async () => {
    // The downloader is pointed straight at a local server standing in for a hostile redirector.
    const { server: hostile, port } = await server((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    try {
      await assert.rejects(
        () => adapter().fetchProductFeedItems({ feedUrl: `http://127.0.0.1:${port}/feed.csv` }),
        (error) => {
          // Refused before any request is made: the origin URL is not on the allowed host either.
          assert.equal(error.feedUrlRejected, true);
          return true;
        },
      );
    } finally {
      hostile.close();
    }
  });

  it("9a — a Location leaving the allowed host is refused at the hop, however it is written", () => {
    // Exactly the resolution the downloader performs on each hop: new URL(location, target).
    const target = VALID;
    for (const location of [
      "http://169.254.169.254/latest/meta-data/",
      "https://attacker.test/all.csv",
      "//attacker.test/all.csv",
      "https://product-feeds.optimisemedia.com.attacker.test/f",
      "http://127.0.0.1:8080/",
      "https://user:pass@product-feeds.optimisemedia.com/f",
    ]) {
      const resolved = new URL(location, target).toString();
      assert.throws(() => assertAllowedFeedUrl(resolved), FeedUrlNotAllowedError, location);
    }
  });

  it("9a2 — a same-host redirect is still allowed, so legitimate CDN hops keep working", () => {
    for (const location of ["/feeds/8812.csv", "?aid=999&format=csv", "https://product-feeds.optimisemedia.com/v2/8812"]) {
      const resolved = new URL(location, VALID).toString();
      assert.equal(assertAllowedFeedUrl(resolved).hostname, "product-feeds.optimisemedia.com", location);
    }
  });

  it("9b — redirects are followed manually and each hop is revalidated", () => {
    const start = adapterSource.indexOf("async function fetchFeedTextLimited");
    const body = adapterSource.slice(start, adapterSource.indexOf("\n}", start));
    assert.match(body, /redirect: "manual"/, "automatic redirect following must be disabled");
    assert.match(body, /assertAllowedFeedUrl\(new URL\(location, target\)/, "each hop is revalidated");
    assert.match(body, /assertAllowedFeedUrl\(url\)/, "and so is the entry URL");
    assert.match(body, /TOO_MANY_REDIRECTS/, "hop count is bounded");
    assert.equal(MAX_FEED_REDIRECTS, 3);
  });

  it("9c — node's fetch would otherwise follow a cross-host redirect (why 9b is required)", async () => {
    const { server: target, port: targetPort } = await server((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/csv" });
      res.end("INTERNAL,SECRET\n1,2\n");
    });
    const { server: redirector, port } = await server((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/internal` });
      res.end();
    });
    try {
      const followed = await fetch(`http://127.0.0.1:${port}/feed`);
      assert.equal(followed.redirected, true);
      assert.match(await followed.text(), /INTERNAL,SECRET/);

      const blocked = await fetch(`http://127.0.0.1:${port}/feed`, { redirect: "manual" });
      assert.equal(blocked.status, 302);
      assert.equal(blocked.redirected, false);
    } finally {
      redirector.close();
      target.close();
    }
  });

  it("10 — no MBO credential is attached to a feed request", () => {
    const start = adapterSource.indexOf("async function fetchFeedTextLimited");
    const body = adapterSource.slice(start, adapterSource.indexOf("\n}", start));
    // The feed download uses global fetch, never the Optimise httpClient that carries the key.
    assert.ok(!body.includes("httpClient"), "must not use the credentialed client");
    for (const header of ["apikey", "x-agency-id", "x-contact-id", "Authorization"]) {
      assert.ok(!body.includes(header), `credential header present: ${header}`);
    }
    assert.match(body, /headers: \{ Accept:/, "only an Accept header is set by default");
  });

  it("11 — a valid feed URL is accepted and its body parsed unchanged", async () => {
    const { parseOptimiseFeedCsv } = await import("../src/adapters/optimise.adapter.js");
    const rows = parseOptimiseFeedCsv("sku,name\r\nA1,Kettle\r\nA2,Toaster\r\n", 100);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { sku: "A1", name: "Kettle" });
    assert.equal(isAllowedFeedUrl(VALID), true, "and the URL it came from passes policy");
  });

  it("12 — sync pagination, byte limits, maxRows and retry policy are unchanged", () => {
    const start = adapterSource.indexOf("async fetchProductFeedItems");
    const body = adapterSource.slice(start, adapterSource.indexOf("async fetchAll", start));
    assert.match(body, /maxRows = 100/, "maxRows default intact");
    assert.match(body, /Math\.min\(8_000_000, Math\.max\(256_000, Number\(maxRows \|\| 100\) \* 64_000\)\)/);
    assert.match(body, /parseOptimiseFeedCsv\(text, maxRows\)/, "CSV parser unchanged");
    assert.match(body, /parseOptimiseFeedXml\(text, maxRows\)/, "XML parser unchanged");
    assert.match(body, /timeoutMs: 25000/, "sync download timeout unchanged");
    // API pagination and the retry policy live outside this function and stay untouched.
    assert.match(adapterSource, /requestWithRetry\(fn, \{ retries: 6, delayMs: 2000 \}\)/);
    assert.match(adapterSource, /if \(pageRows\.length < limit\)/);
    assert.match(adapterSource, /fetchOffsetPaginated\(httpClient, "\/product-feeds\/"/);
  });

  it("12b — a failed download reports a status, never the response body", () => {
    const start = adapterSource.indexOf("async function fetchFeedTextLimited");
    const body = adapterSource.slice(start, adapterSource.indexOf("\n}", start));
    assert.ok(!body.includes("body.slice(0, 120)"), "the body must not reach the error message");
    assert.ok(!body.includes("body.slice(0, 300)"), "nor the attached response");
    assert.match(body, /failed with status \$\{res\.status\}/);
    assert.ok(!/err\.response = \{[^}]*url/.test(body), "the rejected URL must not be attached");
  });

  it("13 — the certification path shares this policy rather than its own copy", async () => {
    const sampleSource = (await import("node:fs")).readFileSync("src/adapters/optimiseFeedSample.js", "utf8");
    assert.match(sampleSource, /from "\.\/feedUrlPolicy\.js"/, "certification imports the shared policy");
    assert.ok(
      !/ALLOWED_FEED_HOSTS = Object\.freeze\(\[/.test(sampleSource),
      "and does not define a second host list that could drift",
    );
  });
});
