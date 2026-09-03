import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCjAdapter, extractCjAdvertisers, extractCjLinks } from "../src/adapters/cj.adapter.js";
import { listSourceObjectCatalog } from "../src/modules/networkOps/sourceObjects.catalog.js";

describe("CJ publisher discovery adapter", () => {
  it("parses Advertiser Lookup XML without promoting default program terms into finance fields", () => {
    const rows = extractCjAdvertisers(`
      <cj-api>
        <advertisers total-matched="1" records-returned="1" page-number="1">
          <advertiser>
            <advertiser-id>129899</advertiser-id>
            <account-status>Active</account-status>
            <seven-day-epc>7.81</seven-day-epc>
            <three-month-epc>9.66</three-month-epc>
            <language>en</language>
            <advertiser-name>BOOKSAMILLION.COM</advertiser-name>
            <program-url>https://example.com</program-url>
            <relationship-status>joined</relationship-status>
            <network-rank>4</network-rank>
            <primary-category><parent>Books/Media</parent><child>Books</child></primary-category>
            <performance-incentives>false</performance-incentives>
            <actions>
              <action><name>Sale</name><type>sale</type><id>266</id><commission><default>5.00%</default></commission></action>
            </actions>
            <link-types><link-type>Text Link</link-type><link-type>DeepLink</link-type></link-types>
          </advertiser>
        </advertisers>
      </cj-api>
    `);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].advertiser_id, "129899");
    assert.equal(rows[0].advertiser_name, "BOOKSAMILLION.COM");
    assert.equal(rows[0].relationship_status, "joined");
    assert.equal(rows[0].primary_category.child, "Books");
    assert.equal(rows[0].actions[0].commission.default, "5.00%");
    assert.equal(rows[0].supplierCommission, undefined);
    assert.equal(rows[0].approvedCommission, undefined);
  });

  it("parses Link Search XML including coupon and tracking evidence", () => {
    const rows = extractCjLinks(`
      <cj-api>
        <links total-matched="1" records-returned="1" page-number="1">
          <link>
            <advertiser-id>15058</advertiser-id>
            <advertiser-name>CJ Demo</advertiser-name>
            <category>Home Appliances</category>
            <link-id>11470088</link-id>
            <link-name>Autumn Coupon</link-name>
            <link-type>Text Link</link-type>
            <description>Save now</description>
            <destination>https://merchant.example/sale</destination>
            <clickUrl>https://tracking.example/click</clickUrl>
            <promotion-type>coupon</promotion-type>
            <coupon-code>SAVE10</coupon-code>
            <relationship-status>joined</relationship-status>
            <sale-commission>10.00%</sale-commission>
            <allow-deep-linking>true</allow-deep-linking>
            <targeted-countries>US</targeted-countries>
          </link>
        </links>
      </cj-api>
    `);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].link_id, "11470088");
    assert.equal(rows[0].coupon_code, "SAVE10");
    assert.equal(rows[0].click_url, "https://tracking.example/click");
    assert.equal(rows[0].allow_deep_linking, true);
    assert.equal(rows[0].sale_commission, "10.00%");
  });

  it("declares only verified discovery capabilities and keeps Commission Detail gated", () => {
    const adapter = createCjAdapter({
      accessToken: "token",
      requestorCid: "123",
      websiteId: "456",
    });
    const caps = adapter.getCapabilities();
    assert.equal(caps.capabilities.includes("CAMPAIGNS"), true);
    assert.equal(caps.capabilities.includes("COUPONS"), true);
    assert.equal(caps.capabilities.includes("CONVERSIONS"), false);
    assert.equal(caps.capabilities.includes("PAYMENTS"), false);
    assert.equal(caps.capabilities.includes("PRODUCTS"), false);
    assert.match(caps.notes.join(" "), /Commission Detail GraphQL remains VERIFY_LIVE/i);
  });

  it("activates Advertiser Lookup and Link Search but keeps product and commission GraphQL declared", () => {
    const byKey = new Map(listSourceObjectCatalog("cj").map((row) => [row.sourceObject, row]));
    assert.equal(byKey.get("advertisers")?.live, true);
    assert.equal(byKey.get("links")?.live, true);
    assert.equal(byKey.get("products")?.live, false);
    assert.equal(byKey.get("commission_detail")?.live, false);
  });
});
