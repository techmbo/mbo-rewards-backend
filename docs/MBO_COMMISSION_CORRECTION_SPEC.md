# MBO Rewards — Commission Architecture Correction Specification

Status: LOCKED IMPLEMENTATION CONTRACT
Scope: PR 1 + PR 2 foundation
Base branch: `backend1`

## 1. Purpose

This specification corrects the current Supplier Commission architecture before additional network integrations or payout automation are trusted.

MBO canonical meaning is authoritative for MBO concepts. Network payloads remain authoritative source evidence. Do not invent mappings, conditions, statuses, rates, currencies, priorities, or financial events.

Runtime principle:

```text
NETWORK RAW COMMISSION DATA
→ preserve raw source group/rule
→ identify every distinct payable outcome
→ create SupplierCommissionRule 1...N
→ attach SupplierCommissionCondition records
→ derive campaign summaries only
→ later match an order to the correct SupplierCommissionRule
→ compare expected supplier commission with network actual commission
→ apply Client Commercial Rule
→ calculate Client Commission and MBO Margin
→ finance separately determines Client Payable eligibility
```

## 2. Non-negotiable rules

1. Every distinct supplier percentage, fixed payout, tier rate, or conditional payout outcome becomes one separate `SupplierCommissionRule`.
2. `Commission 1`, `Commission 2`, ... `Commission N` are UI sequence labels only. Do not create fixed database columns named `commission_1`, `commission_2`, etc.
3. One payout with multiple conditions remains one rule with multiple child conditions.
4. Source grouping is preserved as lineage (`sourceGroupId`, `sourceGroupName`, `sourceRuleId`, `sourceRuleName`) but must not hide individual payable outcomes.
5. Campaign Commission, Avg Commission, Min Commission and Max Commission are summaries only and must never be used for order-level payable calculation.
6. Historical supplier rules must not be overwritten when the effective rate changes.
7. Network actual commission is a source financial fact. Expected supplier commission must not overwrite it.
8. Ambiguous commission matching must become `REVIEW_REQUIRED`; never guess.

## 3. Current implementation problems to correct

### 3.1 Fan-out collision

Current `supplierCommissionRuleFanOut.js` can assign the same `sourceRuleId` to multiple facts extracted from one source entry, then dedupe by that ID. Example: a source entry such as `8.20% Or $17.50` can contain two payable outcomes but share one source rule identifier.

Required correction: generate a stable MBO outcome identity in addition to preserving the original source rule ID.

Example:

```text
sourceRuleId = ABC
outcome 1 = ABC:PERCENT:1
outcome 2 = ABC:FIXED:2
```

The original `ABC` remains source lineage; the two MBO outcomes remain independently persisted.

### 3.2 Condition collapse

The current convenience fields (`customerType`, `country`, `categoryProductGoal`, `couponOrTier`) cannot represent complete arbitrary source rule logic.

Required correction: add a child condition model. Convenience fields may remain for display/backward compatibility but are not authoritative for matching.

### 3.3 Country arrays

Do not reduce a source `countries` array to the first country. Preserve every source condition. If one payable outcome applies independently to multiple countries, represent the source semantics exactly rather than silently dropping values.

### 3.4 Avg Commission

Current mixed percentage + fixed outputs must not be presented as an arithmetic average. Mixed or otherwise non-comparable active rules must produce `Avg Commission = MIXED`.

## 4. Target database model

### 4.1 SupplierCommissionRule

Extend the existing model. Required target fields (existing names may be preserved where compatible):

```text
id
campaignSourceId
supplierCampaignId
supplier
sourceAccountLabel

sourceGroupId
sourceGroupName
sourceRuleId
sourceRuleName
outcomeKey
commissionSequence

commissionModel
commissionType
basis
ratePercent
fixedAmount
currency
actionType

priority
rank

effectiveFrom
effectiveUntil

networkSource
sourceObject
sourcePath
mappingStatus
fieldMappingOutcome
mappingVersion/ruleVersion
rawPayloadId
rawRuleReference
metadata
createdAt
updatedAt
```

`outcomeKey` must be stable enough to distinguish multiple payable outcomes under one network/source rule.

`commissionSequence` is stable display ordering only and is not financial identity.

### 4.2 SupplierCommissionCondition

Create a child relation:

```text
id
commissionRuleId
conditionType
operator
value
sourceConditionType
sourceConditionValue
metadata
createdAt
updatedAt
```

Recommended condition types:

```text
DEFAULT
CATEGORY
PRODUCT
PRODUCT_ID
SKU
SKU_LIST
COUNTRY
REGION
CUSTOMER_TYPE
COUPON
VOUCHER
ORDER_VALUE
QUANTITY
ACTION_TYPE
DEVICE
DATE
PUBLISHER
PUBLISHER_GROUP
TRAFFIC_TYPE
PERFORMANCE_THRESHOLD
COMMISSION_TIER
CUSTOM_FIELD
OTHER_SOURCE_CONDITION
```

Do not constrain the model only to dimensions already seen in Boostiny/Optimise/etc.

## 5. Multi-condition semantics

Example network rule:

```text
15%
WHEN Category = Shoes
AND Country = UAE
AND Customer Type = New
```

MBO representation:

```text
SupplierCommissionRule
  commissionSequence = 4
  ratePercent = 15

SupplierCommissionCondition
  CATEGORY = SHOES
SupplierCommissionCondition
  COUNTRY = UAE
SupplierCommissionCondition
  CUSTOMER_TYPE = NEW
```

This is ONE commission rule, not three independent 15% rules.

## 6. Commission 1...N fan-out behavior

For each campaign:

```text
Campaign
├── Commission 1
├── Commission 2
├── Commission 3
├── ...
└── Commission N
```

Examples:

```text
Fashion 10%
Electronics 4%
Beauty 12%
Home 7%
```

→ four SupplierCommissionRule rows.

```text
India 8%
UAE 12%
KSA 10%
Kuwait 11%
```

→ four SupplierCommissionRule rows when the source defines four distinct payable outcomes.

```text
Qualified Lead = INR 300
Credit Card Approval = INR 1000
App Install = INR 40
```

→ three SupplierCommissionRule rows.

```text
0–100 sales = 5%
101–500 sales = 7%
501+ sales = 10%
```

→ three SupplierCommissionRule rows with tier conditions/ranges.

## 7. Percentage and fixed support

Both must be first-class values. Do not force a fixed payout into a percentage field or vice versa.

Supported financial forms should be able to represent:

```text
PERCENTAGE
FIXED
FIXED_PER_ORDER
FIXED_PER_ITEM
CPC
CPL
CPA
CPI
CPS
CPM
HYBRID
OTHER
```

Do not infer a form when the source semantics are unverified. Use `VERIFY_LIVE`/`REVIEW_REQUIRED`.

## 8. Campaign summary rules

Derived campaign fields:

```text
commissionCount
avgCommission
avgCommissionType
minCommission
maxCommission
campaignCommissionSummary
```

Rules:

- only currently active rules participate;
- all comparable percentage rules → arithmetic mean of percentage values;
- all comparable fixed rules, same currency AND same payout basis → arithmetic mean;
- percentage + fixed → `MIXED`;
- fixed values in different currencies → `MIXED`;
- incompatible bases such as CPA + CPI → `MIXED` unless an explicit future contract defines otherwise;
- expired/superseded historical rules do not participate in the current average.

Examples:

```text
5%, 10%, 15% → Avg 10%
INR 200 CPA, INR 300 CPA, INR 400 CPA → Avg INR 300
10% + USD 20 → MIXED
INR 100 CPA + INR 50 CPI → MIXED
```

Summary values are never financial inputs to client commission calculation.

## 9. Rule history/versioning

Never overwrite a historical supplier rate in a way that destroys the rate that applied to old orders.

Example:

```text
Shoes 10% — effective until 2026-08-31
Shoes 12% — effective from 2026-09-01
```

Order matching must use the rule effective for the relevant approved order/action date according to verified source/MBO logic.

## 10. Required extraction behavior

`src/modules/commercial/supplierCommissionRuleFanOut.js` must:

1. preserve source group/rule identifiers and raw evidence;
2. enumerate every distinct payable outcome from a source entry;
3. generate a stable outcome identity that cannot collide merely because two values share one source rule ID;
4. extract all supported conditions without dropping array values;
5. preserve unrecognized source conditions as `OTHER_SOURCE_CONDITION` rather than discard them when evidence exists;
6. assign deterministic display sequence per campaign;
7. never manufacture missing dimensions.

## 11. Required persistence behavior

`SupplierCommissionRuleService` / sync must:

- upsert using the MBO outcome identity + source scope, not only sourceRuleId when sourceRuleId can contain multiple outcomes;
- persist all child conditions transactionally with the rule;
- retain raw payload lineage;
- keep historical effective versions;
- never silently overwrite an old effective rule merely because the source currently reports a new rate;
- be idempotent under repeated syncs.

## 12. PR 1 acceptance criteria — schema + persistence

PR 1 is complete only when:

- Prisma model includes `SupplierCommissionCondition` relation;
- supplier rule can represent source group lineage, outcome identity, sequence, priority/rank, action/basis and raw rule lineage;
- migration is included;
- repeated sync of the same fixture does not create duplicates;
- a source rule with two payable outcomes persists two rule rows;
- one three-condition outcome persists one rule + three conditions;
- historical effective windows are retained;
- no client commercial/payable logic is moved into network adapters.

## 13. PR 2 acceptance criteria — fan-out + summary

PR 2 is complete only when tests prove:

1. `8.20% Or $17.50` yields two distinct SupplierCommissionRule outcomes;
2. two outcomes sharing one source rule ID do not overwrite each other;
3. multiple countries are not truncated to the first country;
4. Category + Country + Customer Type remain attached to one rule;
5. percentage-only Avg Commission is correct;
6. comparable fixed/same-currency/same-basis average is correct;
7. percentage + fixed returns MIXED;
8. fixed different currencies returns MIXED;
9. fixed different payout bases returns MIXED;
10. expired rules are excluded from current summaries;
11. campaign summary remains display-only;
12. raw source group/rule lineage remains available.

## 14. Tests required

Add/adjust tests for at least:

```text
single default percentage
single fixed payout
multiple percentages
percent + fixed in one source string
multiple source groups
same sourceRuleId with multiple outcomes
country rule
multiple-country source condition
category rule
customer-type rule
coupon/voucher rule
tier rule
multi-condition rule
expired rule
historical rate replacement
mixed average
same-currency fixed average
different-currency fixed average
idempotent re-sync
```

## 15. Do not change in PR 1 / PR 2

Do not redesign the following in these first two PRs:

- client commission calculation;
- client payable state machine;
- order attribution priority;
- finance receipt separation;
- network-specific status registry;
- reconciliation source fallback logic;
- CJ/Admitad/Rakuten adapters.

Those belong to subsequent correction PRs after this supplier commission foundation is stable.

## 16. Next PR sequence after PR 1 / PR 2

```text
PR 3 — Supplier Commission Matcher + expected-vs-actual tests
PR 4 — Network/source-object-specific status mapping + reconciliation source corrections
PR 5 — Client Commercial Rule Matcher + commercial integration
PR 6 — Payable safeguards + negative-margin approval + order-item identity corrections
```

## 17. Golden implementation rule

If a field, source path, condition, transform, status meaning, priority, payout basis, finance event, or relation cannot be proven from a sanitized live fixture, an approved MBO mapping/rule, or verified network documentation, do not assume it. Preserve the raw source value and mark the mapping `VERIFY_LIVE` or `REVIEW_REQUIRED`.
