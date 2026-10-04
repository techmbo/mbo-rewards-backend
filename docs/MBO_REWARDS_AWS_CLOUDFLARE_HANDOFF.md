# MBO Rewards — AWS / Cloudflare handoff

Prepared 2026-09-28 for the infrastructure team taking MBO Rewards from Vercel to AWS + Cloudflare.
Updated 2026-09-28 with the confirmed production state below.
Updated 2026-10-04: the standalone admin is added as the third application component.

**The move contains three application components:**
1. **Backend**: API, workers and cron routes (`techmbo/mbo-rewards-backend`).
2. **Main frontend / Integrated Platform**: marketing site plus the Integrated Platform's staff
   admin and client portal (`techmbo/mbo-rewards-frontend`).
3. **Standalone admin**: a separate admin app that is still actively used on Vercel
   (`techmbo/mborewards`, Vercel project `mbo-rewards-admin`). See §3.1 for its migration
   requirements.

**Production state at handoff (confirmed by MBO):**
- Backend production is deployed at `bd2af1f` (Vercel, 2026-09-28 14:36 UTC).
- The production database is Supabase (PostgreSQL), confirmed by the production Prisma
  migration connection.
- Migration `20260930090000_network_connection_control_plane` has been applied to production
  successfully. No migration is pending.
- Supplier registry: AWIN, BOOSTINY, OPTIMISE and TRACKIER are ENABLED; PARTNERIZE and IMPACT are
  PLANNED; ADMITAD, CJ and RAKUTEN have no row.

**This is a lift-and-shift.** Move the running system as it is. Do not redesign the application,
change business logic, run database migrations, or enable anything this document lists as disabled.
Every behaviour change is a separate, later decision.

> These repositories are **public**. This document names environment variables, routes and
> commits only. It contains no secret values, connection strings or internal hostnames of data
> stores, and nothing added to it later may contain them either.

---

## 1. Repositories and exact commits

| Surface | Repository | Frozen handoff branch | Commit (code) | Production branch today |
|---|---|---|---|---|
| Backend API, workers, cron routes | `techmbo/mbo-rewards-backend` | `handoff/aws-backend-2026-09` | `bd2af1f8da289951a52cc15eef86877878c90feb` | `fix/mbo-rewards-backend-final-corrections` (at `bd2af1f`, deployed to production 2026-09-28 14:36 UTC) |
| Marketing site + Integrated Platform (staff admin and client portal) | `techmbo/mbo-rewards-frontend` | `handoff/aws-frontend-2026-09` | `0d6515ec57818bbd2a83a86892308c85c5764533` | `fix/mbo-rewards-frontend-final-corrections` (at `0d6515e`) |
| Standalone admin | `techmbo/mborewards` | `handoff/aws-admin-2026-10` | `8ed815d4ada8dcbff92713203d0084ad65b595f9` | Source branch `fix/admin-current-backend-integration` (at `8ed815d`); Vercel project `mbo-rewards-admin` |

- The backend handoff branch is `bd2af1f` plus documentation-only commits that add and update this
  document. The application code is byte-identical to `bd2af1f`, which is the code running in
  production.
- The frontend handoff branch points exactly at the commit currently deployed to production.
- The admin handoff branch points exactly at `8ed815d`, the head of
  `fix/admin-current-backend-integration`. This branch is currently the active standalone admin
  baseline and contains no handoff-only code changes. `8ed815d` is the newest build in the Vercel
  project `mbo-rewards-admin`, served on that branch's preview URL.
- Do not deploy from the production branches during the move. They may receive fixes; the handoff
  branches will not.

### Other Vercel projects (not part of the lift-and-shift)

| Vercel project | Source | Status |
|---|---|---|
| `mbo-rewards-backend-d4ud`, `rewards` | older experiments | Not in the production path. Do not migrate. |

---

## 2. Current production architecture (Vercel)

```
                        Browser
                           │
     www.mborewards.com ───┤  Next.js 16 site + /mbointegratedPlatform SPA (static)
     (Vercel project        │  repo: mbo-rewards-frontend
      mbo-rewards-frontend) │
                           │  XHR to https://api.mborewards.com/api/...
                           ▼
     api.mborewards.com ──►  Express 5 API (Node), Vercel serverless, region sin1
     trk.mborewards.com     repo: mbo-rewards-backend, Vercel project mbo-rewards-backend
                           │   ├─ /api/...                 REST API (274 routes, §12)
                           │   ├─ /r/:slug/:token, /t/...  tracking redirects (public)
                           │   └─ /health, /health/live, /health/ready, /metrics
                           ▼
                     Supabase PostgreSQL (Prisma 5.22; DATABASE_URL pooled + DIRECT_URL direct)

  GitHub Actions (backend repo) ──every 5 min──► POST /api/internal/cron/sync-drain
                                  (manual only) ► POST /api/internal/cron/sync-start
  Supplier APIs ◄── outbound HTTPS from the API (Optimise, Boostiny, Trackier, Awin, Partnerize, …)
  Resend ◄── transactional e-mail from the API and the site's contact forms

     Standalone admin ──────►  Vite + React 18 SPA (static), Vercel project mbo-rewards-admin
     (branch preview URL of     repo: techmbo/mborewards, branch fix/admin-current-backend-integration
      fix/admin-current-…)      XHR to the backend at its own VITE_API_BASE_URL (preview builds only, §3.1)
```

- The platform SPA's API base URL is compiled in at build time from
  `platform/.env.production` (`VITE_API_BASE_URL`, host `api.mborewards.com`). Re-pointing that
  DNS name to AWS needs no frontend rebuild.
- The GitHub cron workflows call the Vercel hostname `mbo-rewards-backend.vercel.app` directly,
  hard-coded as `BASE=` in `.github/workflows/sync-drain.yml` and `sync-start.yml`.
- The Vercel domain lists show only `*.vercel.app` names for these projects. How `www`, `api` and
  `trk.mborewards.com` reach them today (a Cloudflare proxy, or domains attached elsewhere) could
  not be verified from the handoff session. Confirm in the DNS provider before cutover (§21).

---

## 3. Component relationships (backend, main frontend, standalone admin)

- **Frontend** (`mbo-rewards-frontend`): a Next.js 16 marketing site. The Integrated Platform is a
  separate Vite + React 18 app in `platform/`. It is built with `npm run sync:platform`, which
  writes into `public/mbointegratedPlatform`, and **that build output is committed**. What is served
  is the committed bundle, not a fresh build.
- **The Integrated Platform holds both UIs.** It is the staff admin (ops, suppliers, integrations,
  clients, commercial, finance views) and the client portal. It is a pure API client of the
  backend: no database access and no secrets.
- **Next.js server routes** in the frontend: `/api/contact` and `/api/simulator-lead`. They use
  `RESEND_API_KEY` and `GOOGLE_SHEET_WEBHOOK_URL` and never call the backend.
- **Standalone admin** (`techmbo/mborewards`): a separate Vite + React 18 single-page app with its
  own Vercel project (`mbo-rewards-admin`) and its own `vercel.json` (every path rewritten to
  `index.html`). It is a pure API client of the same backend, with no database access and no
  secrets. It is still actively used; its working copy today is the Vercel preview of
  `fix/admin-current-backend-integration`, which sits behind Vercel login protection. The project's
  production alias (`mbo-rewards-admin.vercel.app`) serves an older build (`42c3cb6`) made without
  `VITE_API_BASE_URL`, which the app requires at load.
- **Backend CORS**: `FRONTEND_ORIGINS` and `ADMIN_FRONTEND_ORIGIN` must list every origin that
  serves the platform or the standalone admin, including any new Cloudflare preview hostnames used
  for testing.

### 3.1 Standalone admin — migration requirements

| Item | Value |
|---|---|
| Repository | `techmbo/mborewards` |
| Source branch | `fix/admin-current-backend-integration` |
| Source SHA | `8ed815d4ada8dcbff92713203d0084ad65b595f9` |
| Frozen handoff branch | `handoff/aws-admin-2026-10` |
| Handoff SHA | `8ed815d4ada8dcbff92713203d0084ad65b595f9` |
| Vercel project | `mbo-rewards-admin` |
| Build | `npm ci && npm run build` (Vite) → static files in `dist/` |
| Routing | single-page app: every unknown path must serve `index.html` |

- The admin has its own `VITE_API_BASE_URL`, read in `src/api.js`; the app stops with "Missing
  VITE_API_BASE_URL" when it is absent.
- The current Vercel value is configured for **preview builds only**. There is no production value.
- The AWS/Cloudflare deployment must set `VITE_API_BASE_URL` **explicitly at build time**. Vite
  compiles it into the bundle, so changing it later means rebuilding.
- Before cutover, confirm the value points to the new canonical API endpoint, preferably
  `https://api.mborewards.com/api`, and **not** directly to the old Vercel backend URL
  (`mbo-rewards-backend.vercel.app`, which the repo's `.env.example` still names).
- The admin's new hostname must be added to the backend's `ADMIN_FRONTEND_ORIGIN` /
  `FRONTEND_ORIGINS`, or its API calls fail CORS.
- The repo has no Cloudflare configuration yet. Hosting it on Cloudflare Pages or Workers static
  assets needs single-page-app fallback configured on the Cloudflare side; that is deployment
  configuration, not an application change.
- **Do not retire the standalone admin until parity is confirmed**: every page people use on it
  works on the new host, or exists in the Integrated Platform.
- **Auth tokens**: the staff and portal UIs hold a backend-issued JWT (`JWT_SECRET`). The client
  API (`/api/v1/client/*`, `/api/partner/v1/*`) uses client API keys issued by the backend. None
  of this depends on the host.

---

## 4. Database (PostgreSQL via Prisma)

- **Engine**: PostgreSQL, accessed only through Prisma 5.22 (`prisma/schema.prisma`,
  `provider = "postgresql"`).
- **Connection variables the code reads:**
  - `DATABASE_URL`: runtime, pooled. Size the pool with `DATABASE_POOL_LIMIT` if needed.
  - `DIRECT_URL`: direct, non-pooled. Prisma migrations use it.
- **Provider: Supabase (PostgreSQL), confirmed.** The production Prisma migration connection
  (`DIRECT_URL`) was confirmed to be the Supabase database. `DATABASE_URL` points at the same
  database: the running application reads the schema that migration created. The backend Vercel project also carries `PRISMA_DATABASE_URL` and `POSTGRES_URL`, which
  a Vercel storage integration injects, but **no code reads them**; do not carry them over (§5.6).
- **Connecting from AWS**: keep Supabase's pooled connection for `DATABASE_URL` and its direct
  connection for `DIRECT_URL`, exactly as today, and make sure the AWS egress path can reach
  Supabase over TLS.
- **Lift-and-shift rule**: the database stays where it is for the move. The AWS runtime connects to
  the same database with the same two variables. Moving the database (for example to RDS) is a
  separate, later project.
- **No migration may run as part of this handoff.**

### Prisma migration state

- `prisma/migrations` holds 64 migrations. The newest is
  `20260930090000_network_connection_control_plane`, which is additive: it relaxes
  `MarketplaceAccount.encryptedAccessToken` to nullable and adds 12 columns with constant defaults.
- **Applied to production successfully** before `bd2af1f` was deployed. Production has no
  pending migration, and the running `bd2af1f` code depends on this migration being present.
- Re-verify immediately before cutover, read-only:
  - `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;`
    shows the newest migration finished and none rolled back.
  - `npx prisma migrate status` against production reports **nothing pending**.
- If `migrate status` ever reports a pending migration during the move, **stop**. It means the code
  and database have drifted.

---

## 5. Environment variables (names only)

Values live in the current Vercel projects. Copy them into AWS Secrets Manager / SSM Parameter
Store and Cloudflare secrets **without printing them anywhere**.

### 5.1 Backend — required at runtime

| Name | Purpose |
|---|---|
| `NODE_ENV` | `production` (makes missing required vars fatal at boot) |
| `PORT` | listen port (container default 4000) |
| `DATABASE_URL` | Postgres, pooled (**required**; boot fails without it) |
| `DIRECT_URL` | Postgres, direct (Prisma) |
| `JWT_SECRET` | signs staff/portal tokens (**required**) |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | encrypts stored OAuth/API credentials (**required**; must stay identical or stored encrypted credentials become unreadable) |
| `BACKEND_URL` | public API base URL |
| `FRONTEND_URL` | public site base URL |
| `TRACKING_BASE_URL` | public tracking-redirect base URL |
| `FRONTEND_ORIGINS` | CORS allow-list |
| `ADMIN_FRONTEND_ORIGIN` | CORS origin of the admin UI |
| `CRON_SECRET` | bearer secret for `/api/internal/cron/*` |
| `RESEND_API_KEY`, `EMAIL_FROM` | transactional e-mail |

### 5.2 Backend — supplier credentials (read through the credential catalog, §7)

| Network | Names | Set in production today |
|---|---|---|
| Optimise SEA / MENA / UK | `OPTIMISE_API_KEY`, `OPTIMISE_SEA_CONTACT_ID`, `OPTIMISE_MENA_API_KEY`, `OPTIMISE_MENA_CONTACT_ID`, `OPTIMISE_UK_API_KEY`, `OPTIMISE_UK_CONTACT_ID` | yes |
| Boostiny | `BOOSTINY_API_KEY` | yes |
| Trackier (vCommission) | `VCOMMISSION_API_KEY` | yes |
| Awin | `AWIN_ACCESS_TOKEN`, `AWIN_PUBLISHER_ID` | yes |
| Partnerize | `PARTNERIZE_APPLICATION_KEY`, `PARTNERIZE_USER_API_KEY`, `PARTNERIZE_PUBLISHER_ID` | yes |
| Impact | `IMPACT_ACCOUNT_SID`, `IMPACT_AUTH_TOKEN` | **no** (Impact cannot sync) |

### 5.3 Backend — other supplier credentials (read directly, outside the catalog)

`RAKUTEN_ACCESS_TOKEN`, `RAKUTEN_WEB_SECURITY_TOKEN`, `CJ_ACCESS_TOKEN`, `CJ_PUBLISHER_CID`,
`CJ_WEBSITE_ID`, `ADMITAD_CLIENT_ID`, `ADMITAD_CLIENT_SECRET`, `ADMITAD_OAUTH_SCOPE`,
`PARTNERIZE_CERTIFICATION_CAMPAIGN_ID`.

Carry them over unchanged. Rakuten, CJ and Admitad are excluded from full/scheduled syncs by the
supplier gate (§6.1).

### 5.4 Backend — tuning values set in production today

`BOOSTINY_MIN_INTERVAL_MS`, `TRACKIER_BASE_URL`, `TRACKIER_SYNC_FROM`, `TRACKIER_SYNC_TO`,
`TRACKIER_SYNC_DAYS_BACK`, `TRACKIER_CAMPAIGN_MIN_INTERVAL_MS`, `TRACKIER_REPORT_MIN_INTERVAL_MS`,
`TRACKIER_PAGE_LIMIT`, `IMPACT_SYNC_DAYS_BACK`, `PARTNERIZE_SYNC_DAYS_BACK`, `SYNC_UPSERT_BENCHMARK`.

### 5.5 Backend — supported but not set today (leave unset)

These have safe defaults in code; setting any of them changes behaviour.

- **Supplier URLs, windows and pacing:**
  - Admitad: `ADMITAD_ACCESS_TOKEN`, `ADMITAD_BASE_URL`, `ADMITAD_OAUTH_TOKEN_URL`, `ADMITAD_*_TIMEOUT_MS`, `ADMITAD_STATUS_UPDATED_START/END`
  - Awin: `AWIN_BASE_URL`, `AWIN_MIN_INTERVAL_MS`, `AWIN_SYNC_DAYS_BACK`, `AWIN_CERTIFICATION_TIMEOUT_MS`
  - Boostiny: `BOOSTINY_BASE_URL`, `BOOSTINY_*_ENDPOINT`, `BOOSTINY_OAUTH_*`, `BOOSTINY_PER_CAMPAIGN_PERFORMANCE`, `BOOSTINY_REPORT_*`
  - CJ: `CJ_PID`, `CJ_REQUESTOR_CID`, `CJ_*_URL`, `CJ_CERTIFICATION_TIMEOUT_MS`
  - Impact: `IMPACT_BASE_URL`, `IMPACT_MIN_INTERVAL_MS`
  - Optimise: `OPTIMISE_BASE_URL`, `OPTIMISE_COMMISSION_GROUPS_*`, `OPTIMISE_CONVERSIONS_*`, `OPTIMISE_{SEA,MENA,UK}_OAUTH_*`, `OPTIMISE_MIN_INTERVAL_MS`, `OPTIMISE_PAGE_LIMIT`, `OPTIMISE_PRODUCT_FEED_*`, `OPTIMISE_REPORTING_*`, `OPTIMISE_TARGET_CURRENCY_CODE`
  - Partnerize: `PARTNERIZE_BASE_URL`, `PARTNERIZE_MIN_INTERVAL_MS`, `PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS`
  - Rakuten: `RAKUTEN_BASE_URL`, `RAKUTEN_*_DAYS_BACK`, `RAKUTEN_ADVANCED_REPORT_*`, `RAKUTEN_CERTIFICATION_TIMEOUT_MS`
  - Trackier: `TRACKIER_CONVERSIONS_MAX_DAYS`, `TRACKIER_REPORTS_MAX_DAYS`
- **Platform:**
  - `LOG_LEVEL`, `APP_VERSION`
  - `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`, `CERTIFICATION_*`
  - `REDIS_URL`: optional; without it caches and rate limits are in-process.
  - `JOB_MAX_ATTEMPTS`, `EVENT_DISPATCH_INLINE`, `FAST_SYNC`, `AUTO_PROMOTE_AFTER_SYNC`, `SYNC_ENTITY_BATCH_SIZE`, `FIELD_UPSERT_CONCURRENCY`, `ALLOT_GROUP_CONCURRENCY`, `SUPPLIER_COMMISSION_RULE_CONCURRENCY`, `NETWORK_OPS_COMMISSION_*`, `DATABASE_POOL_LIMIT`
- **Finance cutover guards: must stay unset.** `FINANCE_CONSUMER_MODE` defaults to `LEGACY`, and
  `FINANCE_CUTOVER_APPROVED` is off.
- **SES e-mail path (not used today; Resend is):** `AWS_SES_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
  On AWS, prefer an IAM task role to static keys if SES is ever enabled.

### 5.6 Present in Vercel but not read by the `bd2af1f` code (do not carry)

- `ENABLE_SCHEDULER`: the in-process scheduler was retired.
- `PRISMA_DATABASE_URL`, `POSTGRES_URL`: storage-integration injected.
- `RAKUTEN_CLIENT_ID`, `RAKUTEN_CLIENT_SECRET`, `DB_RECOVERY_DIAGNOSTIC_TOKEN`.
- Preview-only: `ADMIN_BOOTSTRAP_TOKEN`, `ADMIN_USER_AUDIT_TOKEN`, `ALLOW_DEV_AUTH_BYPASS`.
  **`ALLOW_DEV_AUTH_BYPASS` must never exist in any production environment.**

### 5.7 Frontend

| Name | Where | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | build time, platform SPA; committed in `platform/.env.production` and also set on the Vercel project | backend base URL including `/api` |
| `RESEND_API_KEY` | Next.js server routes (runtime secret) | contact and lead e-mails |
| `GOOGLE_SHEET_WEBHOOK_URL` | Next.js server routes (runtime secret) | lead capture |
| `VERCEL_GIT_COMMIT_SHA` | provided by Vercel; optional elsewhere | build stamp |

The frontend Vercel project currently defines only `VITE_API_BASE_URL`. Confirm whether the contact
and lead forms work in production today (§21).

### 5.8 Standalone admin

| Name | Where | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | build time, standalone admin; set on the Vercel project `mbo-rewards-admin` for **preview builds only** | backend base URL including `/api`; must be set explicitly for the AWS/Cloudflare build (§3.1) |

### 5.9 Scheduler

| Name | Where | Purpose |
|---|---|---|
| `MBO_SYNC_CRON_SECRET` | GitHub Actions secret (backend repo) | must equal the backend's `CRON_SECRET` |

---

## 6. Suppliers, Network Connections and live network state

### 6.1 Supplier registry (`suppliers` table, production, 2026-09-28)

| Key | Status | Full/scheduled sync |
|---|---|---|
| AWIN | ENABLED (row added 2026-09-28) | eligible |
| BOOSTINY | ENABLED | eligible |
| OPTIMISE | ENABLED | eligible |
| TRACKIER | ENABLED | eligible |
| PARTNERIZE | PLANNED | **excluded** |
| IMPACT | PLANNED | **excluded** |
| ADMITAD, CJ, RAKUTEN | no row | **excluded** |

The gate is strict and reads the registry only:
- ENABLED joins full and scheduled runs.
- PLANNED is excluded.
- A missing row is excluded.
- If the registry cannot be read, every supplier is excluded.

Explicit admin actions (a manual per-network sync, a scoped durable run, Test Connection) are not
gated.

### 6.2 Network Connections (`MarketplaceAccount`)

- **0 rows in production.**
- Every network that syncs today reads its credentials from the catalogued environment variables
  (§7) as the `default` account.
- With no connection rows, Optimise, Boostiny and Trackier have no accounts for the full-run
  planner to enumerate, so the scheduled full plan contains no units for them. Awin runs as the
  single `default` account, so with AWIN ENABLED a full plan contains Awin units only.

### 6.3 Last observed sync state (Step 0 read-only checks, 2026-09-28)

- Unfinished `NetworkSyncRun`: 0.
- Active `sync:orchestration`: 0, and active `sync:unit`: 0.
- Trackier: latest campaigns and coupons runs SUCCESS.
- Awin: programmes SUCCESS. The latest offers run was PARTIAL, with no error code and no
  checkpoints; earlier offers runs were SUCCESS.
- Optimise: **no live ingestion** (by decision; see §17).
- Impact: credentials not configured.
- Stale rows: 17 old `sync:lock` rows and 1 old `promotion` job are still marked RUNNING. They are
  harmless (§10.3).

---

## 7. Credential resolver architecture

Code: `src/modules/integrations/credentials/`.

- **`credentialCatalog.js` is the fixed allow-list.** Per network it lists credential *slots*:
  `primarySecret`, `secondarySecret`, `accountExternalId`, `contactId`, and the one env name each
  slot may read (the names in §5.2). Nothing outside this file names those variables.
- **`credentialResolver.js`** resolves a connection's `secretRef` (`<provider>:<reference>`):
  - The server builds the reference from platform, environment and account label; admins only
    choose a provider.
  - Stored references are re-validated on every read, so a tampered or foreign reference is refused
    before any lookup.
  - Resolved values go only to the caller. They are never logged, stored or returned by the API.
- **Providers:**
  - `env` is registered by default. It reads the catalogued env names.
  - `aws-sm` is **implemented but not registered**; registering it at startup enables it.
- **Precedence per network** (unchanged production order):
  - Optimise, Boostiny, Trackier: connection row, then OAuth token, then catalogued env fallback.
  - Awin, Partnerize, Impact: the catalogued env name is read first, then the connection. An
    `aws-sm` connection for these three only takes effect once the env variable is removed.
- **Adapter independence**: supplier adapters and credential modules do not import any provider and
  do not read catalogued env names. A test enforces this. Changing provider changes no adapter.

### 7.1 AWS Secrets Manager mapping (for when `aws-sm` is enabled; not part of the lift-and-shift)

- **Secret name**: `mbo/<environment>/networks/<platform>/<accountLabel>`, all lower case, for
  example `mbo/production/networks/optimise_sea/default`.
- **Secret value**: a JSON object keyed by slot name. Keys that are not slots are ignored.

| Platform | JSON keys |
|---|---|
| `optimise_sea`, `optimise_mena`, `optimise_uk` | `primarySecret` (API key), `contactId` |
| `boostiny` | `primarySecret` |
| `trackier` | `primarySecret` |
| `awin` | `primarySecret` (access token), `accountExternalId` (publisher id) |
| `partnerize` | `primarySecret` (application key), `secondarySecret` (user API key), `accountExternalId` (publisher id) |
| `impact` | `primarySecret` (account SID), `secondarySecret` (auth token) |

- **IAM**: `secretsmanager:GetSecretValue` on
  `arn:aws:secretsmanager:<region>:<account>:secret:mbo/production/networks/*` only.
- **Enabling it** is a small startup change: add `@aws-sdk/client-secrets-manager` and call
  `registerCredentialProvider(createAwsSecretsManagerProvider({ fetchSecretString }))`. It is a
  code change and needs its own approval.
- **Application secrets** (§5.1) are a separate concern. In the lift-and-shift they are injected
  into the container as environment variables, for example from Secrets Manager via the ECS task
  definition.

---

## 8. Network Connections control plane

Model: `MarketplaceAccount`. Code: `networkConnection.service.js`, `networkConnections.controller.js`.

| Route (under `/api/ops/admin/network-connections`) | Access | Effect |
|---|---|---|
| `GET /catalog`, `GET /`, `GET /:id` | `integrations:read` | read-only, value-free |
| `POST /` | `integrations:manage` | creates a connection **paused** (`PENDING_ACTIVATION`), campaign sync only |
| `PATCH /:id` | `integrations:manage` | switches or provider; a provider change clears the last test |
| `POST /:id/pause`, `POST /:id/resume` | `integrations:manage` | resume requires a passing test |
| `POST /:id/test` | `integrations:manage` + certification rate limit | one read-only supplier probe |
| `POST /:id/initial-sync` | ADMIN + `integrations:manage` + `sync:trigger` | campaigns-only scoped durable run |

- Every change writes an `AuditEvent` (aggregate type `NetworkConnection`).
- Responses never contain secrets, reference targets or variable names.
- **Resuming a connection is the go-live action**: it makes the connection eligible for full and
  scheduled runs. No connection may be created or resumed during the move (§17).
- **Automatic pause**: a 401, or a 403 whose body names an authentication failure, pauses the
  connection as `AUTH_FAILED`. Prior data is untouched.

---

## 9. Data flow: raw → staged → supplier → canonical

1. **Fetch.** A supplier adapter calls the network API for one source object (campaigns, coupons,
   conversions, reports, …) inside a `NetworkSyncRun`.
2. **Raw.** Each supplier record is stored verbatim in `raw_payloads`, keyed by supplier, account,
   resource and external id, with its sync run and connection links.
3. **Staged.** `upsertManyRawEntities` writes the normalised row into `Entity` (idempotent
   `INSERT … ON CONFLICT`). The Entity staging barrier freezes staging while a promotion walk is
   paging `Entity`.
4. **Supplier layer.** The promotion jobs map `Entity` to the supplier tables: `supplier_campaigns`,
   supplier coupons, `SupplierCommissionRule`, conversions and orders. Supplier campaigns link to the
   `suppliers` registry row by key when one exists.
5. **Canonical layer.** Supplier campaigns are matched into canonical campaigns and
   `CampaignSource` records; conversions become canonical `Order`/`Conversion` rows.
   `DailyReport` aggregation follows.
6. **Client exposure and finance.** Client assignment, payables and withdrawals are separate,
   gated steps. They are not automatic (§17).

---

## 10. Jobs, workers and schedulers

| Mechanism | Where | Notes |
|---|---|---|
| Durable orchestration | `job_runs` rows: `sync:orchestration` (parent), `sync:unit` (bounded units), `sync:lock` (locks and barrier) | Created by `sync-start` or `/api/sync/all`; advanced one unit per `sync-drain` call. Units are leased and retried, ending in `DEAD_LETTER`. |
| Tracked in-process jobs | `jobRunner` handlers `promotion`, `conversion-promotion`, `aggregation`, `merchant-matching` (`src/platform/bootstrap.js`) | Run inside a request. Concurrency is an **in-memory** counter per process. |
| Event outbox | `event_outbox`, dispatched inline (`EVENT_DISPATCH_INLINE` default on) | also `POST /api/ops/outbox/dispatch` |
| In-process scheduler | **retired** | no `setInterval`/cron in the server; `ENABLE_SCHEDULER` is unused |

### 10.1 Cron routes and schedule

| Route | Auth | Schedule today | Behaviour |
|---|---|---|---|
| `POST /api/internal/cron/sync-drain` | `Authorization: Bearer <CRON_SECRET>` | **every 5 minutes** (GitHub Actions `sync-drain.yml`, `*/5 * * * *`) | executes exactly one durable unit per call; the workflow makes up to 5 calls per tick with a 310 s per-call timeout and a 240 s budget |
| `POST /api/internal/cron/sync-start` | same | **not scheduled** (`sync-start.yml` is manual-dispatch only) | plans and enqueues a full run (`kind: full`, `trigger: scheduler`, `promoteAfter: true`); executes nothing |

- `sync-start.yml` carries a prepared schedule, `17 2 * * *` (02:17 UTC daily), to add **only
  when separately approved**. Keep it unscheduled during the move.
- The drain route returns 200 with no work when nothing is active.

### 10.2 `NetworkSyncRun` vs `job_runs`

- **`NetworkSyncRun`** is the supplier-sync domain record. It holds one row per network, account and
  source object fetch, with its trigger (`scheduler`/`manual`/`reprocess`), `checkpointBefore`, counters
  (fetched, created, updated, unchanged, quarantined) and a safe error code (`HTTP_<n>`, `TIMEOUT`,
  `NETWORK_ERROR`, …). Rows left RUNNING for more than 30 minutes are closed as
  `CANCELLED / RUN_ABANDONED` when the next run of the same object starts; they are never deleted.
- **`job_runs`** is orchestration and bookkeeping: durable run parents and units, locks, the staging
  barrier, and tracked jobs. It says *what work is scheduled and who holds what*; `NetworkSyncRun`
  says *what a supplier returned*.

### 10.3 Stale `job_runs` rows (current behaviour)

- Locks and barriers count only rows whose `startedAt` is inside their lease:
  - 10 minutes for account locks and the freeze marker;
  - 30 minutes for staging participants.
- Older RUNNING rows are ignored and block nothing.
- Stale RUNNING `promotion` rows do not block promotion, because concurrency is in-memory.
- The only effect is cosmetic: ops "running jobs" counts include them.
- **No cleanup is required for the move.** An optional one-time marker update (never a delete) was
  prepared separately for the operator.

---

## 11. Auth and permissions

- **Staff**: a JWT from `/api/auth/login` (OTP, invite and set-password flows under `/api/auth/*`).
  - Roles: `ADMIN`, `OPERATIONS`, `ANALYST`, `TECH`, `SUPPORT` (`src/auth/permissions.js`).
  - Each route checks `requirePermission(<permission>)`. Sensitive sync routes also require the
    ADMIN role.
- **Clients**: the `CLIENT` role and portal session (`/api/portal/v1/*`), or client API keys
  (`/api/v1/client/*`, `/api/partner/v1/*`) through `authenticatePartner`, with a delivery-channel
  check.
- **Cron**: `/api/internal/cron/*` accepts only the `CRON_SECRET` bearer token. Every failure gets
  the same 401.
- **Public**: health, the OTP/login/invite auth endpoints, the supplier OAuth callback, and tracking
  redirects (`/r/:slug/:token`, `/r/:token`, `/t/product/:token`).
- Rate limits use `express-rate-limit`'s in-memory store: they apply per process, not globally.

---

## 12. API routes

Every route is mounted under `/api`, as are the OpenAPI docs (`/api/docs`, `/api/openapi.json`).
Mounted outside `/api`: `/health`, `/health/live`, `/health/ready`, `/metrics`, and the tracking
redirects.

Summary by area:

| Area | Prefix | Auth |
|---|---|---|
| Auth | `/api/auth/*` | public + staff JWT |
| Staff admin and ops | `/api/ops/*`, `/api/admin/coupons/*`, `/api/clients/*`, `/api/catalog/*`, `/api/merchants/*`, `/api/supplier-campaigns/*`, `/api/reports/*`, `/api/users/*`, … | staff JWT + permission |
| Network Connections | `/api/ops/admin/network-connections/*` | §8 |
| Legacy connect | `/api/marketplace/accounts/*`, `/api/auth/connect/:platform` | `integrations:*` |
| Sync | `/api/sync/*` (status, plan-preview, all, per-network, scoped durable, worker, cancel) | staff JWT, several ADMIN-only |
| Cron | `/api/internal/cron/sync-start`, `/api/internal/cron/sync-drain` | cron secret |
| Client API | `/api/v1/client/*`, `/api/partner/v1/*` | client API key |
| Client portal | `/api/portal/v1/*` | portal session |

The complete generated list (274 routes, with auth and permission constants) is in **Appendix A**.

---

## 13. Cloudflare requirements

1. **DNS** for `mborewards.com`: `www` (site and platform), `api` (backend), `trk` (tracking redirects).
2. **Frontend hosting on Workers.** The repo is already configured: `open-next.config.ts` and
   `wrangler.jsonc` (worker name `rewards`, assets binding, `IMAGES` binding, observability on).
   - Build and deploy: `npm ci && npm run deploy` (`opennextjs-cloudflare build && … deploy`).
   - `public/_redirects` and `public/_headers` already give the SPA deep-link fallback for
     `/mbointegratedPlatform/*` and immutable caching of `/_next/static/*`.
   - Worker secrets: `RESEND_API_KEY`, `GOOGLE_SHEET_WEBHOOK_URL`.
   - Deploy the committed platform bundle as-is. Do not rebuild it with a different
     `VITE_API_BASE_URL`.
3. **API proxying** for `api.mborewards.com` to the AWS load balancer:
   - TLS: Full (strict).
   - **Never cache `/api/*`**: bypass cache on authenticated JSON.
   - Keep the `Authorization` header intact.
4. **Timeout constraint.** Cloudflare's proxied origin timeout is 100 s on non-Enterprise plans. A
   `sync-drain` call can legitimately run up to about 300 s. **The cron caller must reach the
   origin without the Cloudflare proxy**: a grey-clouded hostname, the load balancer's own name, or
   a Worker Cron Trigger fetching the origin directly. Otherwise it will see 524 errors.
5. **Tracking domain** `trk.mborewards.com`: route `/r/*` and `/t/*` to the backend with no caching,
   so every click reaches the origin.
6. **WAF / rate limiting** at the edge is welcome, but must not challenge `/api/internal/cron/*` or
   the client API (machine clients cannot solve challenges).
7. **Optional**: Cloudflare Cron Triggers can replace GitHub Actions as the `sync-drain` caller later.
   Keep the 5-minute cadence and ensure one caller at a time.
8. **Standalone admin hosting** (Cloudflare Pages or Workers static assets) from
   `handoff/aws-admin-2026-10`:
   - build with `VITE_API_BASE_URL` set explicitly (§3.1);
   - single-page-app fallback, so deep links serve `index.html`;
   - a hostname for it, protected at least as well as today (Vercel login protection today; for
     example Cloudflare Access), and that hostname added to the backend's CORS origins.

---

## 14. AWS runtime requirements

| Need | Recommendation |
|---|---|
| Container | the existing `Dockerfile`: `node:20-alpine`, port 4000, `HEALTHCHECK /health/live`, `CMD node src/index.js`. The build stage runs `prisma generate` and **never** migrates. |
| Compute | ECS on Fargate (a long-running Node process), at least 2 tasks behind an ALB. |
| Load balancer | ALB with an **idle timeout of 330 s or more** (the default 60 s would cut `sync-drain` calls). Health check `GET /health/ready`. |
| Images | ECR |
| Secrets | Secrets Manager or SSM Parameter Store, injected as task environment variables (§5). IAM task role with least privilege. |
| Network | tasks in private subnets with a NAT gateway for outbound supplier APIs and database access. A fixed egress IP makes future supplier or database allow-lists possible; nothing depends on one today. |
| Database | unchanged (§4). Ensure the tasks can reach it (network path, TLS). |
| Logs and metrics | CloudWatch Logs (JSON logs from pino), CloudWatch alarms on 5xx, task restarts and drain failures. `/metrics` is Prometheus text; do not expose it publicly. |
| Certificates | ACM for the ALB if Cloudflare uses Full (strict). |
| Region | today's function region is `sin1` (Singapore). Choose `ap-southeast-1` unless the database location says otherwise. |
| Not needed for the lift-and-shift | RDS, ElastiCache (`REDIS_URL` unset), SES (Resend in use), EventBridge (optional replacement for the GitHub Actions cron) |

Avoid App Runner and API Gateway + Lambda for the API: their request timeouts (120 s and 29 s by
default) are shorter than a drain unit.

### Build and start commands

| Surface | Build | Start / deploy |
|---|---|---|
| Backend | `docker build -t mbo-rewards-backend .` (runs `npm ci` and `npx prisma generate`) | `node src/index.js` (container `CMD`), `PORT=4000` |
| Backend, without Docker | `npm ci && npx prisma generate` | `NODE_ENV=production node src/index.js` |
| Frontend (Cloudflare) | `npm ci` | `npm run deploy` (OpenNext build and Wrangler deploy) |
| Platform SPA (only if deliberately rebuilt) | `cd platform && npm ci && npm run build`, then `npm run sync:platform` | committed into `public/mbointegratedPlatform` |
| Standalone admin (Cloudflare) | `npm ci && VITE_API_BASE_URL=<canonical API URL> npm run build` | upload `dist/` with single-page-app fallback |

---

## 15. Deployment sequence (lift-and-shift)

1. **Freeze.**
   - Confirm no active durable run: `SELECT count(*) FROM job_runs WHERE "jobName"='sync:orchestration' AND status IN ('PENDING','RUNNING')` returns 0.
   - Keep the `sync-start` workflow unscheduled.
2. **Verify schema, read-only.** `npx prisma migrate status` reports nothing pending (§4). Run no
   migration.
3. **Stand up the backend on AWS** from `handoff/aws-backend-2026-09`:
   - image to ECR, then ECS service behind the ALB;
   - environment from §5.1–5.4, with values copied, not retyped;
   - the same `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY` and
     `CRON_SECRET` as Vercel.
4. **Smoke-test AWS on its own hostname** (§16), before any DNS change.
5. **Stand up the frontend on Cloudflare Workers** from `handoff/aws-frontend-2026-09` and
   smoke-test it on its `*.workers.dev` or preview hostname. Add that origin to `FRONTEND_ORIGINS`
   and `ADMIN_FRONTEND_ORIGIN` for testing only.
   - **Stand up the standalone admin** on Cloudflare from `handoff/aws-admin-2026-10`, built with
     `VITE_API_BASE_URL` set explicitly (§3.1), and add its hostname to the backend CORS origins.
6. **Cut over the API.**
   - Point `api.mborewards.com` and `trk.mborewards.com` at the AWS load balancer through
     Cloudflare.
   - Update `BACKEND_URL` and `TRACKING_BASE_URL` only if their hostnames change. They do not if the
     same names are re-pointed.
7. **Move the drain caller.** Change `BASE=` in `.github/workflows/sync-drain.yml` (and
   `sync-start.yml`) to the AWS origin hostname that bypasses the Cloudflare proxy (§13.4).
   - This is a one-line workflow change and needs approval.
   - **Only one drain caller may be active at a time.**
8. **Cut over the site.** Point `www.mborewards.com` at the Worker. Move admin users to the
   standalone admin's new hostname once its smoke tests pass; leave the Vercel admin running.
9. **Watch for 24 hours**: 5xx rates, drain results, login and portal use, tracking redirects.
10. **Keep Vercel deployments intact**, unscheduled and unrouted, for at least 7 days as the
    rollback target.

## 16. Smoke tests (read-only, no supplier calls)

`$API` is the environment under test; `$TOKEN` is an ADMIN session token; `$CRON` is the cron
secret, held in an env var and never echoed.

| # | Request | Expected |
|---|---|---|
| 1 | `GET $API/health`, `/health/live`, `/health/ready` | 200 (`/health` and `/health/ready` return 503 when a dependency is down) |
| 2 | `GET $API/api/health` | `{"ok":true}` |
| 3 | `GET $API/api/ops/admin/network-connections/catalog` (bearer `$TOKEN`) | 200, `Cache-Control: no-store`; 8 platforms; `credentialProviders: ["env"]`; no variable names in the body |
| 4 | `GET $API/api/ops/admin/network-connections` | 200, `data: []` |
| 5 | `GET $API/api/sync/plan-preview` | `plan.exclusions` lists `supplier_not_enabled` for partnerize, impact, admitad, cj and rakuten, and not for awin; `plan.byPlatform` contains `awin` only |
| 6 | `POST $API/api/internal/cron/sync-drain` with header `Authorization: Bearer $CRON` | 200 with `status: "idle"` while no run is active; the same call without the header returns 401 |
| 7 | `GET $API/r/does-not-exist/x` | a 4xx, not 5xx: the tracking path reaches the app |
| 8 | Frontend `/` and a deep link `/mbointegratedPlatform/<any route>` | 200; the SPA shell loads |
| 9 | Platform login and one staff list page | API calls succeed with no CORS errors |
| 10 | Logs for the first hour | no Prisma `P2022`, "column does not exist" or unhandled errors |
| 11 | Standalone admin: load, log in, open one list page and one deep link | pages load; the browser's network panel shows API calls going to the canonical API host (not `*.vercel.app`), with no CORS errors |

## 17. Features and connections that must stay disabled

- Optimise live ingestion: no Optimise connection is created, tested live, resumed or initially
  synced.
- Creating or resuming **any** Network Connection.
- Partnerize and Impact stay **PLANNED**. Admitad, CJ and Rakuten stay out of the registry. Do not
  add or enable suppliers to make full syncs include them.
- The `sync-start` schedule (daily full run) stays absent.
- Automatic client exposure of campaigns or offers.
- Automatic payable release.
- Withdrawal automation.
- Treating supplier-paid as MBO-received: network paid does **not** equal MBO received.
- The finance cutover: `FINANCE_CONSUMER_MODE` stays `LEGACY` (unset) and
  `FINANCE_CUTOVER_APPROVED` stays unset.
- The `aws-sm` credential provider stays unregistered until approved.
- `ALLOW_DEV_AUTH_BYPASS` never exists in production.
- Retiring the standalone admin (the Vercel project or its preview) before parity is confirmed.

## 18. Rollback

The database is not changed by the move, so rollback is routing only:

1. Point `api.mborewards.com`, `trk.mborewards.com` and `www.mborewards.com` back to their
   pre-cutover targets (recorded at step 6/8).
2. Point the `sync-drain` workflow `BASE=` back to `https://mbo-rewards-backend.vercel.app` and
   stop the AWS caller. Keep exactly one caller.
3. Point admin users back to the Vercel standalone admin, which stays running throughout.
4. Leave the AWS stack running but unrouted until the cause is understood.
5. No data rollback is needed. If a durable run was mid-flight, the other side picks it up from
   `job_runs`: units are leased, and a unit abandoned by a killed process is reclaimed after its
   lease.

## 19. Known risks

| Risk | Mitigation |
|---|---|
| Proxy and load-balancer timeouts cut `sync-drain` calls (Cloudflare 100 s, ALB default 60 s) | ALB idle timeout ≥ 330 s; cron bypasses the Cloudflare proxy (§13.4) |
| Two drain callers at once (GitHub → Vercel and something → AWS) | one caller only; durable locks prevent double execution, but it wastes capacity and muddles logs |
| How `www`/`api`/`trk` are routed today is unconfirmed | confirm in DNS before step 6 |
| In-memory rate limits and job concurrency apply per process | acceptable for lift-and-shift; add `REDIS_URL` later if needed |
| `OAUTH_TOKEN_ENCRYPTION_KEY` changed or mistyped | stored encrypted credentials become unreadable; copy the value exactly |
| Public repositories | never commit values, hostnames of data stores or dumps; this document is world-readable |
| The Awin offers source's latest run was PARTIAL | monitor after cutover; not a migration blocker |
| Awin is ENABLED, so a full run (manual `/sync/all`, or `sync-start` if it is ever scheduled) now includes Awin units | expected; `sync-start` stays unscheduled during the move |
| Impact has no credentials | stays PLANNED; no action |
| 17 stale `sync:lock` rows and 1 stale `promotion` row | harmless (§10.3) |
| Tests: 13 known failing tests with the test env (identical on `22d5464`) | pre-existing; not introduced by `bd2af1f` |
| The standalone admin is built without `VITE_API_BASE_URL`, or with the old Vercel backend URL | it fails at load, or keeps calling Vercel after cutover; set the value explicitly at build and check it (§3.1, smoke test 11) |
| The standalone admin is retired before its pages exist elsewhere | admin users lose tools they use; keep it until parity is confirmed |

## 20. Exact first actions after cutover

1. Run the smoke tests (§16) against the public hostnames.
2. Confirm the single drain caller hits AWS every 5 minutes and returns 200 or 409 (the Actions log
   or the AWS access log).
3. Confirm Vercel's backend receives no cron traffic and no API traffic, apart from rollback tests.
4. Re-run the Step 0 read-only pack. Expect:
   - no new unfinished `NetworkSyncRun`;
   - no active orchestration;
   - `MarketplaceAccount` still 0 rows.
5. Confirm the standalone admin on its new host calls the canonical API host (smoke test 11).
6. Record the cutover (time, commits, DNS targets) in the ops log.
7. Then **stop**. The next steps are business decisions made separately:
   - the `sync-start` schedule;
   - the Optimise SEA go-live;
   - registering `aws-sm`.

## 21. Blockers and items the tech team must confirm

| # | Item | Why it matters | Owner |
|---|---|---|---|
| B1 | **Resolved.** The production database is Supabase (PostgreSQL), confirmed by the production Prisma migration connection. `PRISMA_DATABASE_URL`/`POSTGRES_URL` are not used. | AWS connects to the same Supabase database with the same `DATABASE_URL`/`DIRECT_URL` | closed |
| B2 | How `www`, `api` and `trk.mborewards.com` are routed today (Cloudflare proxy or DNS-only, and to which Vercel project). The Vercel projects list only `*.vercel.app` domains. | defines the cutover and rollback DNS targets | infra |
| B3 | A cron hostname that bypasses the Cloudflare proxy, and the `BASE=` edit in the two workflows | a proxied drain call dies at 100 s (§13.4) | infra; the workflow edit needs MBO approval |
| B4 | Whether the site's contact and lead forms work today: the frontend Vercel project defines no `RESEND_API_KEY` or `GOOGLE_SHEET_WEBHOOK_URL` | those secrets must exist on the Worker if the forms are expected to work | MBO |
| B5 | **Resolved.** The standalone admin is still actively used. It is now the third component, frozen as `handoff/aws-admin-2026-10` at `8ed815d` (§1, §3.1). | needs its own hosting on Cloudflare | closed |
| B6 | Region choice relative to the Supabase project region (today's functions run in `sin1`) | latency on every request | infra |
| B7 | **Resolved.** The AWIN supplier row has been added and is ENABLED. | Awin is eligible for full/scheduled runs (§6.1) | closed |
| B8 | GitHub Actions secret `MBO_SYNC_CRON_SECRET` stays equal to the AWS `CRON_SECRET` | otherwise the drain returns 401 and the workflow fails | infra |
| B9 | The standalone admin's `VITE_API_BASE_URL` for the new build: confirm it is the canonical API endpoint (preferably `https://api.mborewards.com/api`), not the old Vercel backend URL | the value is compiled in; a wrong value fails at load or keeps calling Vercel | MBO + infra |
| B10 | The standalone admin's new hostname and access protection, and adding it to the backend's CORS origins | without CORS its API calls fail; without protection the admin is publicly reachable | infra |

---

## Appendix A — API routes (generated from `src/routes/index.js` at `bd2af1f`)

| Method | Path | Auth | Permission constant(s) |
|---|---|---|---|
| GET | `/api/health` | public | — |
| POST | `/api/auth/send-otp` | public | — |
| POST | `/api/auth/verify-otp` | public | — |
| POST | `/api/auth/register` | public | — |
| POST | `/api/auth/login` | public | — |
| GET | `/api/auth/me` | staff JWT | — |
| POST | `/api/auth/logout` | staff JWT | — |
| GET | `/api/auth/invite/:token` | public | — |
| POST | `/api/auth/set-password` | public | — |
| GET | `/api/users` | staff JWT | `USERS_MANAGE` |
| POST | `/api/users` | staff JWT | `USERS_MANAGE` |
| PATCH | `/api/users/:id` | staff JWT | `USERS_MANAGE` |
| GET | `/api/logs/access` | staff JWT | `LOGS_READ` |
| POST | `/api/internal/cron/sync-start` | cron secret | — |
| POST | `/api/internal/cron/sync-drain` | cron secret | — |
| GET | `/api/sync/status` | staff JWT | `SYSTEM_READ` |
| GET | `/api/sync/plan-preview` | staff JWT + ADMIN role | `SYSTEM_READ` |
| POST | `/api/sync/all` | staff JWT | `SYNC_TRIGGER` |
| POST | `/api/sync/incremental` | staff JWT | `SYNC_TRIGGER` |
| POST | `/api/sync/runs/:runId/cancel` | staff JWT + ADMIN role | `SYNC_TRIGGER` |
| POST | `/api/sync/worker` | staff JWT + ADMIN role | `SYNC_TRIGGER` |
| POST | `/api/sync/awin/backfill-staged-offers` | staff JWT + ADMIN role | `SYNC_TRIGGER` |
| POST | `/api/sync/:platform/:accountLabel/durable` | staff JWT + ADMIN role | `SYNC_TRIGGER` |
| POST | `/api/sync/boostiny/:accountLabel/canary` | staff JWT + ADMIN role | `SYNC_TRIGGER` |
| POST | `/api/sync/:platform/:accountLabel` | staff JWT | `SYNC_TRIGGER` |
| POST | `/api/sync/:platform` | staff JWT | `SYNC_TRIGGER` |
| GET | `/api/auth/connect/:platform` | staff JWT | `INTEGRATIONS_MANAGE` |
| GET | `/api/auth/callback/marketplace/:platform` | public | — |
| GET | `/api/marketplace/accounts` | staff JWT | `INTEGRATIONS_READ` |
| POST | `/api/marketplace/accounts/:platform/connect` | staff JWT | `INTEGRATIONS_MANAGE` |
| DELETE | `/api/marketplace/accounts/:platform/:accountLabel` | staff JWT | `INTEGRATIONS_MANAGE` |
| GET | `/api/entities` | staff JWT | — |
| GET | `/api/entities/summary` | staff JWT | — |
| GET | `/api/ops/imported-records` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/ops/imported-records/summary` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/ops/imported-records/facets` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/ops/imported-records/columns` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/ops/imported-records/:id` | staff JWT | `CAMPAIGNS_READ` |
| POST | `/api/ops/imported-records/reprocess` | staff JWT | `SYNC_TRIGGER` |
| GET | `/api/fields` | staff JWT | — |
| GET | `/api/coupons/columns` | staff JWT | `COUPONS_READ` |
| GET | `/api/admin/coupons/columns` | staff JWT | `COUPONS_READ` |
| POST | `/api/admin/coupons/columns` | staff JWT | `COUPON_COLUMNS_MANAGE` |
| PUT | `/api/admin/coupons/columns` | staff JWT | `COUPON_COLUMNS_MANAGE` |
| POST | `/api/admin/coupons/columns/reset` | staff JWT | `COUPON_COLUMNS_MANAGE` |
| PATCH | `/api/admin/coupons/columns/:key` | staff JWT | `COUPON_COLUMNS_MANAGE` |
| DELETE | `/api/admin/coupons/columns/:key` | staff JWT | `COUPON_COLUMNS_MANAGE` |
| GET | `/api/admin/coupons` | staff JWT | `COUPONS_READ` |
| GET | `/api/admin/coupons/pool` | staff JWT | `COUPONS_READ` |
| POST | `/api/admin/coupons/pool/:id/review-alert` | staff JWT | `COUPONS_WRITE` |
| PATCH | `/api/admin/coupons/pool/:id` | staff JWT | `COUPONS_WRITE` |
| GET | `/api/admin/coupons/:id` | staff JWT | `COUPONS_READ` |
| GET | `/api/admin/coupons/:id/commercial` | staff JWT | `COUPONS_READ` |
| POST | `/api/admin/coupons` | staff JWT | `COUPONS_WRITE` |
| PATCH | `/api/admin/coupons/:id` | staff JWT | `COUPONS_WRITE` |
| DELETE | `/api/admin/coupons/:id` | staff JWT | `COUPONS_WRITE` |
| GET | `/api/suppliers` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/suppliers/:key` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/supplier-campaigns` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/supplier-campaigns/brands` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/supplier-campaigns/brands/:brandKey` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/master/catalog-summary` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/ops/client/guide` | staff JWT | `CLIENTS_READ` |
| GET | `/api/ops/network/ai-integration-guide` | staff JWT | `OPS_READ` |
| GET | `/api/ops/global-search` | staff JWT | — |
| GET | `/api/supplier-campaigns/:id` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/supplier-campaigns/tracking-links/queue` | staff JWT | `TRACKING_READ` |
| PUT | `/api/supplier-campaigns/:id/tracking-link` | staff JWT | `TRACKING_MANAGE` |
| PUT | `/api/supplier-campaigns/:id/tracking-link/state` | staff JWT | `TRACKING_MANAGE` |
| POST | `/api/supplier-campaigns/promote` | staff JWT | `SYNC_TRIGGER` |
| GET | `/api/supplier-coupons` | staff JWT | `COUPONS_READ` |
| POST | `/api/promotion/run` | staff JWT | `SYNC_TRIGGER` |
| POST | `/api/promotion/retry` | staff JWT | `SYNC_TRIGGER` |
| GET | `/api/mapper-errors` | staff JWT | `SYSTEM_READ` |
| PATCH | `/api/mapper-errors/:id/retry` | staff JWT | `SYNC_TRIGGER` |
| GET | `/api/merchants` | staff JWT | `MERCHANTS_READ` |
| GET | `/api/merchants/:id` | staff JWT | `MERCHANTS_READ` |
| POST | `/api/merchants` | staff JWT | `MERCHANTS_MANAGE` |
| PATCH | `/api/merchants/:id` | staff JWT | `MERCHANTS_MANAGE` |
| POST | `/api/merchants/:id/merge` | staff JWT | `MERCHANTS_MANAGE` |
| POST | `/api/merchant-matching/run` | staff JWT | `MERCHANTS_MANAGE` |
| GET | `/api/merchant-review` | staff JWT | `MERCHANTS_READ` |
| GET | `/api/merchant-review/:id` | staff JWT | `MERCHANTS_READ` |
| PATCH | `/api/merchant-review/:id` | staff JWT | `MERCHANTS_MANAGE` |
| GET | `/api/catalog` | staff JWT | `CATALOG_READ` |
| GET | `/api/catalog/:id` | staff JWT | `CATALOG_READ` |
| POST | `/api/catalog` | staff JWT | `CATALOG_MANAGE` |
| PATCH | `/api/catalog/:id` | staff JWT | `CATALOG_MANAGE` |
| POST | `/api/catalog/:id/source` | staff JWT | `CATALOG_MANAGE` |
| PATCH | `/api/catalog/source/:id` | staff JWT | `CATALOG_MANAGE` |
| POST | `/api/catalog/source/:id/promote` | staff JWT | `CATALOG_MANAGE` |
| GET | `/api/clients` | staff JWT | `CLIENTS_READ` |
| GET | `/api/clients/:id` | staff JWT | `CLIENTS_READ` |
| POST | `/api/clients` | staff JWT | `CLIENTS_MANAGE` |
| PATCH | `/api/clients/:id` | staff JWT | `CLIENTS_MANAGE` |
| DELETE | `/api/clients/:id` | staff JWT | `CLIENTS_MANAGE` |
| POST | `/api/clients/:id/portal-users` | staff JWT | `CLIENTS_MANAGE` |
| GET | `/api/clients/:id/portal-users` | staff JWT | `CLIENTS_MANAGE` |
| GET | `/api/clients/:id/api-keys` | staff JWT | `CLIENTS_MANAGE` |
| POST | `/api/clients/:id/api-keys` | staff JWT | `CLIENTS_MANAGE` |
| POST | `/api/clients/:id/api-keys/:credentialId/revoke` | staff JWT | `CLIENTS_MANAGE` |
| GET | `/api/clients/:id/onboarding` | staff JWT | `CLIENTS_MANAGE` |
| PUT | `/api/clients/:id/onboarding/commercial-model` | staff JWT | `CLIENTS_MANAGE` |
| POST | `/api/clients/:id/onboarding/admin` | staff JWT | `CLIENTS_MANAGE` |
| POST | `/api/clients/:id/onboarding/allot` | staff JWT | `CLIENTS_MANAGE` |
| GET | `/api/clients/:id/allocation/campaigns` | staff JWT | `CLIENTS_MANAGE` |
| GET | `/api/clients/:id/allocation/campaigns/:campaignId` | staff JWT | `CLIENTS_MANAGE` |
| POST | `/api/clients/:id/onboarding/provision` | staff JWT | `CLIENTS_MANAGE` |
| POST | `/api/clients/:id/onboarding/activate` | staff JWT | `CLIENTS_MANAGE` |
| GET | `/api/v1/client/campaigns` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/campaigns/:id` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/account` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/performance` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/performance/summary` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/performance/campaigns` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/performance/affiliate-links` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/performance/coupons` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/performance/orders` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/orders` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/confirmed-orders` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/payments` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/payouts` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/statements` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/statements/:id` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/withdrawal-requests` | partner/client (API key or portal session) | — |
| POST | `/api/v1/client/withdrawal-requests` | partner/client (API key or portal session) | — |
| GET | `/api/v1/client/products` | partner/client (API key or portal session) | — |
| GET | `/api/partner/v1/campaigns` | partner/client (API key or portal session) | — |
| GET | `/api/partner/v1/campaigns/:id` | partner/client (API key or portal session) | — |
| GET | `/api/partner/v1/orders` | partner/client (API key or portal session) | — |
| GET | `/api/partner/v1/confirmed-orders` | partner/client (API key or portal session) | — |
| GET | `/api/partner/v1/payment-status` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/me` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/overview` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/performance` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/campaigns` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/campaigns/:id` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/orders` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/payment-status` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/products` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/payments` | partner/client (API key or portal session) | — |
| PUT | `/api/portal/v1/bank` | partner/client (API key or portal session) | — |
| POST | `/api/portal/v1/withdrawals` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/payable-statements` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/payable-statements/:id` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/withdrawal-requests` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/withdrawal-requests/:id` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/notifications` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/dashboard-summary` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/settings` | partner/client (API key or portal session) | — |
| PATCH | `/api/portal/v1/settings` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/team` | partner/client (API key or portal session) | — |
| POST | `/api/portal/v1/support` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/api-docs` | partner/client (API key or portal session) | — |
| GET | `/api/portal/v1/api-keys` | partner/client (API key or portal session) | — |
| POST | `/api/portal/v1/api-keys/rotate` | partner/client (API key or portal session) | — |
| GET | `/api/client-brand-requests` | staff JWT | `CLIENTS_READ` |
| POST | `/api/client-brand-requests` | staff JWT | `CLIENTS_MANAGE` |
| PATCH | `/api/client-brand-requests/:id` | staff JWT | `CLIENTS_MANAGE` |
| GET | `/api/client-assignments` | staff JWT | `CLIENTS_READ` |
| POST | `/api/client-assignments` | staff JWT | `CLIENTS_MANAGE` |
| PATCH | `/api/client-assignments/:id` | staff JWT | `CLIENTS_MANAGE` |
| GET | `/api/tracking-links` | staff JWT | `TRACKING_READ` |
| GET | `/api/tracking-links/defaults` | staff JWT | `TRACKING_READ` |
| POST | `/api/tracking-links` | staff JWT | `TRACKING_MANAGE` |
| PATCH | `/api/tracking-links/:id` | staff JWT | `TRACKING_MANAGE` |
| GET | `/api/coupon-assignments` | staff JWT | `COUPON_ASSIGN_READ` |
| POST | `/api/coupon-assignments` | staff JWT | `COUPON_ASSIGN_MANAGE` |
| PATCH | `/api/coupon-assignments/:id` | staff JWT | `COUPON_ASSIGN_MANAGE` |
| GET | `/api/commission-rules` | staff JWT | `COMMISSION_READ` |
| POST | `/api/commission-rules` | staff JWT | `COMMISSION_MANAGE` |
| PATCH | `/api/commission-rules/:id` | staff JWT | `COMMISSION_MANAGE` |
| GET | `/api/clicks` | staff JWT | `TRACKING_READ` |
| POST | `/api/clicks` | staff JWT | `TRACKING_MANAGE` |
| GET | `/api/conversions` | staff JWT | `CONVERSIONS_READ` |
| POST | `/api/conversions` | staff JWT | `SYNC_TRIGGER` |
| GET | `/api/reports/daily` | staff JWT | `PERFORMANCE_READ` |
| GET | `/api/reports/client` | staff JWT | `PERFORMANCE_READ` |
| GET | `/api/reports/merchant` | staff JWT | `PERFORMANCE_READ` |
| GET | `/api/reports/campaign` | staff JWT | `PERFORMANCE_READ` |
| GET | `/api/reports/source` | staff JWT | `PERFORMANCE_READ` |
| POST | `/api/aggregation/run` | staff JWT | `SYNC_TRIGGER` |
| POST | `/api/aggregation/rebuild` | staff JWT | `SYNC_TRIGGER` |
| GET | `/api/ops/metrics` | staff JWT | `OPS_READ` |
| GET | `/api/ops/queues` | staff JWT | `OPS_READ` |
| GET | `/api/ops/jobs/failed` | staff JWT | `OPS_READ` |
| GET | `/api/ops/jobs/dead-letter` | staff JWT | `OPS_READ` |
| GET | `/api/ops/aggregation` | staff JWT | `OPS_READ` |
| GET | `/api/ops/promotion` | staff JWT | `OPS_READ` |
| GET | `/api/ops/matching-queue` | staff JWT | `OPS_READ` |
| GET | `/api/ops/storage` | staff JWT | `OPS_READ` |
| GET | `/api/ops/database` | staff JWT | `OPS_READ` |
| GET | `/api/ops/workers` | staff JWT | `OPS_READ` |
| POST | `/api/ops/outbox/dispatch` | staff JWT | `OPS_READ` |
| GET | `/api/ops/exceptions` | staff JWT | `EXCEPTIONS_READ` |
| GET | `/api/ops/exceptions/:id` | staff JWT | `EXCEPTIONS_READ` |
| POST | `/api/ops/exceptions/:id/acknowledge` | staff JWT | `EXCEPTIONS_MANAGE` |
| POST | `/api/ops/exceptions/:id/assign` | staff JWT | `EXCEPTIONS_MANAGE` |
| POST | `/api/ops/exceptions/:id/resolve` | staff JWT | `EXCEPTIONS_MANAGE` |
| POST | `/api/ops/exceptions/:id/reopen` | staff JWT | `EXCEPTIONS_MANAGE` |
| POST | `/api/ops/exceptions/:id/retry` | staff JWT | `EXCEPTIONS_MANAGE` |
| GET | `/api/ops/mapping-review` | staff JWT | `EXCEPTIONS_READ` |
| GET | `/api/ops/raw-payloads` | staff JWT | `OPS_READ` |
| GET | `/api/ops/raw-payloads/:id` | staff JWT | `OPS_READ` |
| POST | `/api/ops/raw-payloads/:id/replay` | staff JWT | `OPS_MANAGE` |
| POST | `/api/ops/reprocess` | staff JWT | `OPS_MANAGE` |
| GET | `/api/ops/sync-runs` | staff JWT | `OPS_READ` |
| GET | `/api/ops/sync-runs/:id` | staff JWT | `OPS_READ` |
| GET | `/api/ops/finance/dashboard` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/finance/reconcile/transaction/:id` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/finance/reconcile/conversion/:conversionId` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/finance/reconcile/client/:clientId` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/finance/reconcile/supplier/:supplier` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/finance/portal-cutover-readiness` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/finance/daily-report-cutover-readiness` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/finance/historical-coverage` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/products` | staff JWT | `PRODUCTS_READ` |
| POST | `/api/ops/products/sync-feeds` | staff JWT | `PRODUCTS_MANAGE` |
| GET | `/api/ops/products/:id` | staff JWT | `PRODUCTS_READ` |
| GET | `/api/ops/product-feeds` | staff JWT | `PRODUCTS_READ` |
| POST | `/api/ops/product-feeds/ingest` | staff JWT | `PRODUCTS_MANAGE` |
| POST | `/api/ops/client-products/assign` | staff JWT | `PRODUCTS_MANAGE` |
| GET | `/api/ops/admin/campaigns` | staff JWT | `CATALOG_READ` |
| GET | `/api/ops/admin/campaigns/:id` | staff JWT | `CATALOG_READ` |
| POST | `/api/ops/admin/campaigns/supplier/:supplierCampaignId/certify-mapping` | staff JWT | `OPS_MANAGE` |
| POST | `/api/ops/admin/campaigns/supplier/:supplierCampaignId/revoke-mapping` | staff JWT | `OPS_MANAGE` |
| POST | `/api/ops/admin/campaigns/approve-catalog` | staff JWT | `CATALOG_MANAGE` |
| GET | `/api/ops/admin/performance` | staff JWT | `PERFORMANCE_READ` |
| GET | `/api/ops/admin/client-overview` | staff JWT | `PERFORMANCE_READ` |
| GET | `/api/ops/admin/client-performance` | staff JWT | `PERFORMANCE_READ` |
| GET | `/api/ops/admin/client-confirmed-orders` | staff JWT | `CONVERSIONS_READ` |
| GET | `/api/ops/admin/reporting-overview` | staff JWT | `PERFORMANCE_READ` |
| GET | `/api/ops/admin/orders` | staff JWT | `CONVERSIONS_READ` |
| POST | `/api/ops/admin/order-items/:id/validation` | staff JWT | `OPS_MANAGE` |
| GET | `/api/ops/admin/product-feeds` | staff JWT | `PRODUCTS_READ` |
| GET | `/api/ops/admin/network-certification` | staff JWT | `INTEGRATIONS_MANAGE` |
| POST | `/api/ops/admin/network-certification/:network/run` | staff JWT | `INTEGRATIONS_MANAGE` |
| GET | `/api/ops/admin/network-connections/catalog` | staff JWT | `INTEGRATIONS_READ` |
| GET | `/api/ops/admin/network-connections` | staff JWT | `INTEGRATIONS_READ` |
| GET | `/api/ops/admin/network-connections/:id` | staff JWT | `INTEGRATIONS_READ` |
| POST | `/api/ops/admin/network-connections` | staff JWT | `INTEGRATIONS_MANAGE` |
| PATCH | `/api/ops/admin/network-connections/:id` | staff JWT | `INTEGRATIONS_MANAGE` |
| POST | `/api/ops/admin/network-connections/:id/pause` | staff JWT | `INTEGRATIONS_MANAGE` |
| POST | `/api/ops/admin/network-connections/:id/resume` | staff JWT | `INTEGRATIONS_MANAGE` |
| POST | `/api/ops/admin/network-connections/:id/test` | staff JWT | `INTEGRATIONS_MANAGE` |
| POST | `/api/ops/admin/network-connections/:id/initial-sync` | staff JWT + ADMIN role | `INTEGRATIONS_MANAGE` `SYNC_TRIGGER` |
| GET | `/api/ops/admin/commission-vocabulary` | staff JWT | `COMMISSION_READ` |
| GET | `/api/ops/admin/payment-status` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/admin/network-billing` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/admin/network-payments-received` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/admin/mbo-receipts` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/admin/client-settlements/payable-orders` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/admin/client-settlements/withdrawal-invoice-requests` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/admin/client-settlements/payouts` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/admin/boostiny/payment-source-mappings` | staff JWT | `FINANCE_OPS_READ` |
| PUT | `/api/ops/admin/boostiny/payment-source-mappings` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/admin/boostiny/partner-payment-settlements` | staff JWT | `FINANCE_OPS_READ` |
| POST | `/api/ops/admin/boostiny/partner-payment-upload` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/admin/feeds` | staff JWT | `PRODUCTS_READ` |
| GET | `/api/ops/data-quality` | staff JWT | `OPS_READ` |
| GET | `/api/ops/assignment-coverage` | staff JWT | `OPS_READ` |
| GET | `/api/ops/supplier-health` | staff JWT | `OPS_READ` |
| GET | `/api/ops/job-health` | staff JWT | `OPS_READ` |
| GET | `/api/ops/system-health` | staff JWT | `OPS_READ` |
| GET | `/api/ops/finance/reconcile/network` | staff JWT | `FINANCE_OPS_READ` |
| POST | `/api/ops/finance/reconcile/network/rebuild` | staff JWT | `FINANCE_OPS_READ` |
| GET | `/api/ops/mapping-review/rules` | staff JWT | `OPS_READ` |
| GET | `/api/ops/mapping-registry` | staff JWT | `OPS_READ` |
| GET | `/api/ops/mapping-registry/:id` | staff JWT | `OPS_READ` |
| POST | `/api/ops/mapping-registry/sync` | staff JWT | `OPS_READ` |
| GET | `/api/ops/network/dashboard` | staff JWT | `CAMPAIGNS_READ` |
| GET | `/api/ops/admin/supplier-commission-rules` | staff JWT | `COMMISSION_READ` |
| POST | `/api/ops/admin/supplier-commission-rules/test` | staff JWT | `COMMISSION_MANAGE` |
| GET | `/api/ops/admin/tracking-links` | staff JWT | `TRACKING_READ` |
