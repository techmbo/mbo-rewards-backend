# Phase 7B — product schema migration proposal (NOT APPLIED)

No migration is applied in this patch. Everything below is a proposal for review.

Each item exists because a field is required by the product contract the admin UI needs, and is
absent from the schema today. Nothing here is needed for the pure-read and DTO-safety fixes in
this patch, which work against the current schema.

## 1. Global trade identifiers on `Product`

| Column | Type | Nullable | Default | Index |
|---|---|---|---|---|
| `gtin` | `String?` `@db.VarChar(14)` | yes | none | `@@index([gtin])` |
| `ean` | `String?` `@db.VarChar(13)` | yes | none | none |
| `upc` | `String?` `@db.VarChar(12)` | yes | none | none |

**Why.** The product contract asks for GTIN/EAN/UPC. No such column exists on any model, so the
admin DTO cannot report them and the frontend must show them as unavailable. Impact and Optimise
catalog payloads carry these identifiers; the mapping files do not currently target them.

**Backfill.** None at migration time. Values arrive on the next feed/catalog ingest once
`products.mapping.json` gains the target fields. Existing rows stay null, which is truthful.

**Uniqueness.** None. A GTIN is shared across merchants and suppliers, so a unique constraint would
reject legitimate rows. Identity stays `ProductSource[supplier, sourceAccountLabel,
supplierProductId]`.

**Rollout impact.** Additive and nullable — no downtime, no rewrite of existing rows.

## 2. Stock quantity on `Product`

| Column | Type | Nullable | Default | Index |
|---|---|---|---|---|
| `stockQuantity` | `Int?` | yes | none | none |

**Why.** `ProductAvailability` is an enum (IN_STOCK / OUT_OF_STOCK / PREORDER / UNKNOWN) and carries
no quantity. The contract asks for stock separately from availability, and the two must never be
inferred from one another. Without a column the honest answer is "not available", which is what the
DTO reports today.

**Backfill.** None. Null means "not reported by the supplier", which is distinct from zero.

**Rollout impact.** Additive and nullable.

## 3. Campaign-link provenance on `Product`

| Column | Type | Nullable | Default | Index |
|---|---|---|---|---|
| `campaignLinkProvenance` | `ProductCampaignLinkProvenance?` (new enum) | yes | none | none |

New enum: `NATIVE_CAMPAIGN_SOURCE_FK`, `DERIVED_BY_TRACKING_URL_PID_MATCH`.

**Why.** `enrichMissingCampaignLinks()` infers an Optimise product's campaign by matching the
publisher PID inside `SupplierCampaign.trackingUrl`. Before this patch it wrote that inference back
to `Product.campaignSourceId` from inside a GET, after which a derived link was indistinguishable
from a stored one. This patch stops the write and returns the provenance in the DTO instead, computed
per request. Persisting it needs this column plus a write performed by a job, never by the read path.

**Backfill.** Set `NATIVE_CAMPAIGN_SOURCE_FK` for every row where `campaignSourceId IS NOT NULL` at
migration time — but note that this would mislabel any link written by the old GET-time enrichment,
which cannot now be distinguished from a genuine one. The honest option is to leave the column null
for existing rows and let the next ingest stamp it.

**Rollout impact.** Additive and nullable. Requires a Prisma enum addition.

## 4. Source lifecycle on `ProductSource`

| Column | Type | Nullable | Default | Index |
|---|---|---|---|---|
| `firstSeenAt` | `DateTime?` | yes | none | none |
| `lastSeenAt` | `DateTime?` | yes | none | none |
| `lastSyncedAt` | `DateTime?` | yes | none | `@@index([supplier, lastSyncedAt])` |
| `sourceStatus` | `String?` | yes | none | none |
| `sourcePath` | `String?` | yes | none | none |
| `originalAvailability` | `String?` | yes | none | none |

**Why.** `ProductSource` currently has `createdAt`/`updatedAt` only. The contract asks to keep
supplier-side evidence — when a product was first and last seen in a feed, the supplier's own
availability string before normalization, and where in the payload it came from — separate from the
canonical values. `updatedAt` cannot answer "was this row in the latest feed", which is what a
disappeared-product check needs.

**Backfill.** `firstSeenAt = createdAt`, `lastSeenAt = updatedAt` for existing rows. Safe and
monotonic. `sourceStatus`, `sourcePath` and `originalAvailability` stay null until the next ingest.

**Rollout impact.** Additive and nullable; the backfill is a single `UPDATE` over `product_sources`
and should be run in batches if the table is large.

## 5. Not proposed

- **No unique constraint on `Product.sku`.** SKUs collide across merchants; identity belongs to
  `ProductSource`.
- **No `discountPercent` column.** Derivable from `price` and `salePrice`, and the contract says not
  to derive it. Storing it would create a second source of truth that can drift.
- **No merge of `ProductFeedItem` into `Product`.** They are deliberately different truth levels:
  the item is the feed-row snapshot, the product is the normalized record.
