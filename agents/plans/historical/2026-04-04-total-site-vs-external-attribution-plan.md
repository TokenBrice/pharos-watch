# Total Site-vs-External Attribution Plan

## Goal

Replace the current `/admin` request-source card, which only measures `api.pharos.watch`, with a total site-vs-external attribution view for API load.

Desired semantics:
- `site`: website-owned traffic, including the split website lane and any website-owned public API keys.
- `external`: public API traffic that is not website-owned.

## Current State

- The worker records minute-bucketed attribution into `api_request_source_stats`.
- That table only tracks `api.pharos.watch` requests.
- `site-api.pharos.watch` requests are skipped entirely.
- The current source values are `web` and `external`.
- `web` is inferred from browser evidence (`Origin`/`Referer` or the frontend `Accept` marker plus same-site fetch metadata).
- API keys do not have a first-class attribution class today. They only expose `name`, `ownerEmail`, `tier`, and rate-limit metadata.
- The Pages `/_site-data/*` proxy has its own cache. Cache hits there do not reach the worker, but they still execute the Pages Function first, so they can be counted there.

## Recommended Scope

Implement this as a full site-vs-external demand view in phase 1, with worker-load and cache-delivery breakdowns beneath it.

That means:
- Count every `/_site-data/*` request in the Pages Function as `site` demand, including cache hits.
- Count `api.pharos.watch` requests as `site` or `external` depending on browser evidence or API-key ownership.
- Keep a separate breakdown showing how much site demand was served from the Pages cache versus forwarded upstream to `site-api` or `api.pharos.watch`.

Reason:
- This answers the actual product question: total website demand versus external consumer demand.
- The cache situation becomes explicit instead of being an undocumented blind spot.
- The only extra requirement is a durable Pages-side telemetry sink, not a separate optional product phase.

## Required Pages Proxy Telemetry

Add telemetry directly in `functions/_site-data/[[path]].ts`.

Important implementation detail:
- `/_site-data/*` cache hits still run the Pages Function before `caches.default.match()` returns.
- The proxy can therefore record both cache hits and cache misses without touching the worker.

Recommended Pages-side telemetry dimensions:
- `route_key`
- `route_path`
- `delivery_path`
  - `pages-cache-hit`
  - `pages-upstream-fetch`
  - `pages-upstream-timeout`
  - `pages-upstream-error`
- `upstream_lane`
  - `site-api`
  - `public-api-fallback`

Recommended durability approach:
- add a D1 binding to the Pages project and write minute buckets from the Pages Function
- use the same D1 database unless there is a strong operational reason to isolate telemetry tables

Required infra/documentation step:
- extend the Pages site-data env contract with a D1 binding
- document that binding in the Pages deployment/runtime docs because it is configured on the Pages project, not by `wrangler pages deploy`

## Data Model Changes

### 1. Add first-class API-key attribution metadata

Add a new column to `api_keys`:
- `traffic_class TEXT NOT NULL DEFAULT 'external'`

Allowed values:
- `external`
- `site`

Why:
- This avoids inferring website ownership from `tier` or `ownerEmail`.
- It gives a stable way to treat website-owned public API keys as `site`.
- It keeps the admin policy explicit and auditable.

Files touched:
- `worker/migrations/00xx_add_api_key_traffic_class.sql`
- `worker/src/lib/api-keys.ts`
- `shared/types/api-keys.ts`
- `src/components/status/api-keys-panel.tsx`
- `worker/src/api/api-keys.ts` tests

### 2. Create a new worker-load attribution table instead of mutating the old primary key

Create a new table, for example:

`api_request_consumer_stats`

Columns:
- `bucket_start INTEGER NOT NULL`
- `route_key TEXT NOT NULL`
- `route_path TEXT NOT NULL`
- `lane TEXT NOT NULL`
- `consumer_class TEXT NOT NULL`
- `request_count INTEGER NOT NULL DEFAULT 0`

Recommended lane values:
- `public-api`
- `site-api`

Recommended consumer values:
- `site`
- `external`

Primary key:
- `(bucket_start, route_key, lane, consumer_class)`

Indexes:
- `(bucket_start)`
- `(route_key, bucket_start)`
- optionally `(lane, bucket_start)` if lane summaries are queried often

Why a new table instead of altering `api_request_source_stats`:
- The current PK does not include `lane`.
- Rebuilding that table in place is more rollout-sensitive.
- A new table allows a clean cutover plus one-time backfill from existing production history.
- Old table cleanup can happen later in a separate migration if desired.

### 3. Add a Pages demand table

Create a second table, for example:

`site_data_request_stats`

Columns:
- `bucket_start INTEGER NOT NULL`
- `route_key TEXT NOT NULL`
- `route_path TEXT NOT NULL`
- `delivery_path TEXT NOT NULL`
- `upstream_lane TEXT`
- `request_count INTEGER NOT NULL DEFAULT 0`

Why a separate table:
- Pages demand and worker load are different telemetry scopes
- keeping them separate prevents accidental double counting
- the API layer can merge them intentionally into one operator-facing response

### 4. Backfill existing history

During migration:
- Copy `api_request_source_stats` into the new table.
- Map existing `source = 'web'` to `consumer_class = 'site'`.
- Map existing `source = 'external'` to `consumer_class = 'external'`.
- Set `lane = 'public-api'` for all historical rows.

This preserves the existing 35-day worker-side history instead of resetting the card.

Pages demand history will start at rollout time unless we later backfill it from another source.

## Request Classification Changes

### 1. Replace the current `web` classifier with a lane-aware consumer classifier

Refactor `worker/src/lib/request-source-attribution.ts` to classify:
- `lane`
- `consumerClass`

Recommended rules:

1. `site-api.pharos.watch` or Worker preview requests authenticated with `X-Pharos-Site-Proxy-Secret`
   - lane: `site-api`
   - consumerClass: `site`

2. `api.pharos.watch` requests with a valid API key
   - lane: `public-api`
   - consumerClass:
     - `site` if `api_keys.traffic_class = 'site'`
     - `external` otherwise

3. `api.pharos.watch` requests without a valid API key, or exempt public routes
   - lane: `public-api`
   - consumerClass:
     - `site` if browser evidence matches the existing first-party heuristics
     - `external` otherwise

4. Admin routes and `/api/telegram-webhook`
   - continue to skip attribution entirely

This keeps the current browser heuristics for legacy/fallback/exempt traffic while correctly counting the dedicated website lane.

### 2. Thread request attribution context through the access gate

`evaluateAccessGate()` should return enough context for the recorder to classify requests without re-deriving auth state from raw headers alone.

Recommended additions:
- `lane: 'public-api' | 'site-api' | null`
- `siteProxyAuthenticated: boolean`
- `apiKeyTrafficClass: 'site' | 'external' | null`

That keeps classification logic deterministic after the auth gate has already resolved the request lane.

Files touched:
- `worker/src/handlers/http/gates.ts`
- `worker/src/handlers/http/request-source.ts`
- `worker/src/handlers/http/request-dispatch.ts`
- `worker/src/lib/request-source-attribution.ts`

## API Contract Changes

Keep the endpoint path:
- `GET /api/request-source-stats`

Change the response semantics from "public API host only" to "total site-vs-external demand, with worker-load breakdown".

### Recommended response shape evolution

Rename shared types away from `PublicApi...` to something generic, for example:
- `ApiRequestAttributionSplit`
- `ApiRequestAttributionRouteStat`
- `ApiRequestAttributionTimeBucket`
- `ApiRequestAttributionLaneStat`
- `ApiRequestAttributionResponse`

Recommended payload:
- `totals`
  - `siteRequests`
  - `externalRequests`
  - `totalRequests`
  - `siteSharePct`
  - `externalSharePct`
- `siteDelivery`
  - `pagesCacheHits`
  - `pagesUpstreamFetches`
  - `publicApiSiteRequests`
- `lanes`
  - one row for `public-api`
  - one row for `site-api`
- `routes`
  - aggregated route totals across total demand
- `buckets`
  - time buckets across total demand

Optional but useful:
- `scope`
  - `countsTotalSiteDemand: true`
  - `countsWorkerLoad: true`
  - `includesPagesProxyCacheHits: true`

Why add lane summaries:
- Operators still need to understand whether site traffic is coming through the intended `site-api` lane or leaking onto `api.pharos.watch`.
- This prevents the new total from hiding routing regressions.

Files touched:
- `shared/types/request-source.ts`
- `worker/src/api/request-source-stats.ts`
- `src/hooks/use-request-source-stats.ts`
- `src/components/status/request-source-attribution-card.tsx`

## Admin UI Changes

Update the card to present:
- top-line total `Site` vs `External`
- a small site-delivery strip:
  - `Pages cache hit`
  - `Pages upstream fetch`
  - `Public API site`
- a small lane summary strip:
  - `site-api`
  - `public-api`
- route groups aggregated across both lanes
- time buckets aggregated across both lanes

Recommended copy:
- Title: `API load attribution`
- Subtitle: explain that the top-line split is total site demand versus external demand, while the sub-breakdowns show how much of site demand hit the Pages cache versus the worker lanes

For API keys:
- add a `Traffic Class` input/select in the admin key panel
- default new keys to `external`
- allow explicit marking of website-owned keys as `site`

## Documentation Changes

Update:
- `docs/api-reference.md`
- `docs/status-dashboard.md`
- `docs/worker-infrastructure.md`

Required doc changes:
- endpoint semantics for `GET /api/request-source-stats`
- new `api_keys.traffic_class` field
- the distinction between total demand attribution and worker-load attribution
- lane rules:
  - `site-api` counts as `site`
  - public API keyed requests use `traffic_class`
  - browser heuristics remain a fallback only for public-host requests
- Pages proxy rules:
  - every `/_site-data/*` request counts as `site` demand
  - `pages-cache-hit` vs `pages-upstream-fetch` stays visible in the response

## Testing Plan

### Worker tests

- `worker/src/lib/__tests__/request-source-attribution.test.ts`
  - classify `site-api` shared-secret requests as `site`
  - classify valid public API keys with `traffic_class = 'site'` as `site`
  - classify valid public API keys with `traffic_class = 'external'` as `external`
  - retain browser-evidence classification for unkeyed/exempt public routes

- `worker/src/__tests__/index.fetch.test.ts`
  - site-api requests write `lane = site-api`, `consumer_class = site`
  - external keyed public requests write `lane = public-api`, `consumer_class = external`
  - site-class keyed public requests write `lane = public-api`, `consumer_class = site`
  - admin and webhook routes still do not write attribution

- `worker/src/api/__tests__/request-source-stats.test.ts`
  - totals aggregate across both lanes
  - lane summary rows are returned correctly
  - routes and buckets aggregate correctly

- `worker/src/lib/__tests__/api-keys.test.ts`
  - list/create/update/rotate preserve `trafficClass`

### Frontend tests

- targeted admin card/render test if needed
- API keys panel test coverage for the new field if UI tests exist in that area

### Pages Function tests

- `functions/__tests__/site-data-proxy.test.ts`
  - cache-hit telemetry write
  - upstream-fetch telemetry write
  - timeout/error telemetry write

### Validation commands

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- before push: `npm run test:merge-gate`

## Rollout Notes

- Migration must stay backward-compatible.
- Preferred sequence:
  1. create new stats table
  2. add `api_keys.traffic_class`
  3. backfill old stats into the new table
  4. deploy worker that writes/reads the new table
  5. optionally remove the old table in a later cleanup migration

- Existing API keys should default to `external`.
- If any website-owned public API keys exist today, mark them explicitly after deploy.

## Risks And Caveats

### 1. Pages Functions need a durable telemetry binding

The full demand view requires the `/_site-data/*` Pages Function to write counters durably.

Practical implication:
- add a D1 binding to the Pages project runtime
- update the local/CI/env contracts and deployment docs accordingly

### 2. Route aggregation remains worker-path based

Route totals will aggregate by worker API path, not by frontend route. That is consistent with the existing card.

### 3. Historical continuity

Using a new worker-load table plus migration backfill preserves continuity, but pre-cutover history will still only have `lane = public-api` because the site-api lane was not tracked before. Pages-demand history starts at rollout time.

## Remaining Optional Work

Still optional:
- long-term cleanup of the legacy `api_request_source_stats` table after the new path has baked
- extra per-host or per-cache-status forensic detail if operators later want a deeper debugging surface than the lane and delivery strips
