import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertTrackingLinksIndependent,
  buildRedirectChain,
  formatRedirectChainSummary,
  REDIRECT_CHAIN_STEP,
  resolveMboTrackingLink,
  resolveSupplierTrackingLink,
  stripSupplierTrackingFields,
  toClientSafeTrackingDto,
  toInternalTrackingLinkDto,
  TRACKING_LINK_KIND,
} from "../src/modules/tracking/trackingLink.contract.js";

describe("tracking link (pointer 11)", () => {
  it("resolves supplier and MBO links independently", () => {
    const supplier = "https://network.example/click?cid=1";
    const mbo = "https://go.mbo.example/r/client/token-abc";
    assert.equal(
      resolveSupplierTrackingLink({ supplierTrackingLink: supplier, mboTrackingLink: mbo }),
      supplier,
    );
    assert.equal(
      resolveMboTrackingLink({ supplierTrackingLink: supplier, mboTrackingLink: mbo }),
      mbo,
    );
  });

  it("never substitutes MBO link for missing supplier link", () => {
    const mbo = "https://go.mbo.example/r/client/token-abc";
    assert.equal(resolveSupplierTrackingLink({ mboTrackingLink: mbo }), null);
    assert.equal(resolveMboTrackingLink({ mboTrackingLink: mbo }), mbo);
  });

  it("never substitutes supplier link for missing MBO link", () => {
    const supplier = "https://network.example/click?cid=1";
    assert.equal(resolveSupplierTrackingLink({ networkTrackingLink: supplier }), supplier);
    assert.equal(resolveMboTrackingLink({ networkTrackingLink: supplier }), null);
  });

  it("detects independent link pairs", () => {
    assert.equal(
      assertTrackingLinksIndependent(
        "https://network.example/a",
        "https://go.mbo.example/r/x/y",
      ),
      true,
    );
    assert.equal(
      assertTrackingLinksIndependent("https://same.example/x", "https://same.example/x"),
      false,
    );
  });

  it("builds the six-step runtime redirect chain", () => {
    const chain = buildRedirectChain({ supplier: "OPTIMISE", attributionParameter: "UID" });
    assert.equal(chain.length, 6);
    assert.equal(chain[0].step, REDIRECT_CHAIN_STEP.CLIENT);
    assert.equal(chain[1].step, REDIRECT_CHAIN_STEP.MBO_TRACKING_LINK);
    assert.equal(chain[2].step, REDIRECT_CHAIN_STEP.MBO_CLICK_ID);
    assert.equal(chain[3].step, REDIRECT_CHAIN_STEP.ATTRIBUTION_INJECTION);
    assert.equal(chain[3].detail, "UID");
    assert.equal(chain[4].step, REDIRECT_CHAIN_STEP.SUPPLIER_TRACKING_LINK);
    assert.equal(chain[5].step, REDIRECT_CHAIN_STEP.BRAND_DESTINATION);
    assert.ok(formatRedirectChainSummary(chain).includes("MBO Tracking Link"));
  });

  it("toInternalTrackingLinkDto exposes supplier link for ops", () => {
    const dto = toInternalTrackingLinkDto({
      id: "tl-1",
      supplier: "AWIN",
      trackingUrl: "https://awin.example/click",
      mboTrackingUrl: "https://go.mbo.example/r/slug/tok",
    });
    assert.equal(dto.supplierTrackingLink, "https://awin.example/click");
    assert.equal(dto.networkTrackingLink, dto.supplierTrackingLink);
    assert.equal(dto.mboTrackingLink, "https://go.mbo.example/r/slug/tok");
    assert.equal(dto.linkKind, "BOTH");
    assert.equal(dto.attributionParameter, "clickRef");
    assert.ok(dto.redirectChainSummary.includes("→"));
    assert.equal(dto.linksIndependent, true);
  });

  it("toClientSafeTrackingDto strips supplier URLs", () => {
    const dto = toClientSafeTrackingDto({
      supplierTrackingLink: "https://network.example/secret",
      mboTrackingLink: "https://go.mbo.example/r/a/b",
      trackingLinkId: "tl-9",
    });
    assert.equal(dto.mboTrackingLink, "https://go.mbo.example/r/a/b");
    assert.equal(dto.trackingLinkId, "tl-9");
    assert.equal("supplierTrackingLink" in dto, false);
  });

  it("stripSupplierTrackingFields removes internal supplier fields", () => {
    const cleaned = stripSupplierTrackingFields({
      mboTrackingLink: "https://go.mbo.example/r/a/b",
      supplierTrackingLink: "https://network.example/x",
      networkTrackingLink: "https://network.example/x",
      tracking: {
        supplierTrackingLink: "https://network.example/x",
        mboTrackingLink: "https://go.mbo.example/r/a/b",
      },
    });
    assert.equal(cleaned.supplierTrackingLink, undefined);
    assert.equal(cleaned.networkTrackingLink, undefined);
    assert.equal(cleaned.tracking.mboTrackingLink, "https://go.mbo.example/r/a/b");
    assert.equal(cleaned.tracking.supplierTrackingLink, undefined);
  });

  it("classifies link kind when only one side exists", () => {
    assert.equal(
      toInternalTrackingLinkDto({ trackingUrl: "https://net.example/a" }).linkKind,
      TRACKING_LINK_KIND.SUPPLIER,
    );
    assert.equal(
      toInternalTrackingLinkDto({ mboTrackingUrl: "https://go.mbo.example/r/x" }).linkKind,
      TRACKING_LINK_KIND.MBO,
    );
  });
});
