# API Key Load Table Plan

## Objective

Add an operator-facing table on `/admin/` directly below the existing "Site vs external demand" card that shows how much request load each API key generated in the selected admin window.

## Feasibility

This is doable, but not from current long-retention data alone.

What already exists:

- The reliability section already has the right UI insertion point: `src/app/admin/sections/reliability-section.tsx`.
- The existing demand card already loads a 24h admin telemetry payload from `GET /api/request-source-stats`.
- API key inventory metadata already exists through `GET /api/api-keys`.

What is missing:

- Long-retention request attribution only stores minute buckets by `route_key`, `lane`, and `consumer_class`; it does **not** store `api_key_id`.
- The only current per-key counter is `api_key_rate_limit`, but that table is pruned after roughly 10 minutes and cannot support a 24h view.

Conclusion:

- **Feasible with a small backend extension and a new retained per-key telemetry table.**
- **Not feasible as a pure frontend/UI change.**
- **Not feasible from existing retained data without accepting a fresh-data-only limitation.**

## Current State Summary

### Existing retained demand telemetry

- `worker/migrations/0085_total_request_attribution.sql`
  - `api_request_consumer_stats(bucket_start, route_key, route_path, lane, consumer_class, request_count)`
- `worker/src/lib/request-source-attribution.ts`
  - records retained worker attribution with no key dimension
- `worker/src/api/request-source-stats.ts`
  - aggregates totals, route groups, worker lanes, and time buckets for the admin card

### Existing API key metadata

- `worker/src/lib/api-key-admin.ts`
  - `listApiKeys()` returns current key inventory from `api_keys`
- `shared/types/api-keys.ts`
  - current summary has metadata plus `lastUsedAt` and `lastUsedRoute`, but no volume/load counters

### Existing short-lived per-key counting

- `worker/src/lib/api-key-rate-limit.ts`
  - increments `api_key_rate_limit`
- `worker/src/lib/api-key-core.ts`
  - prune window multiplier is `10`, so retention is about 10 minutes

## Recommended Approach

Implement a dedicated retained telemetry table for keyed traffic instead of repurposing the rate-limit table.

Recommended new table:

- `api_key_request_stats`
  - `bucket_start INTEGER NOT NULL`
  - `api_key_id INTEGER NOT NULL`
  - `request_count INTEGER NOT NULL DEFAULT 0`
  - `PRIMARY KEY (api_key_id, bucket_start)`
  - index on `bucket_start`

Why this shape:

- Minimal write amplification: one minute-bucket upsert per keyed request.
- Matches the actual feature request: load by key, not full per-key route analytics.
- Keeps rate-limiting concerns separate from retained operator telemetry.
- Avoids blowing up `api_request_consumer_stats` cardinality by adding `api_key_id` there.

## Proposed Product Shape

Render a new card immediately below the request attribution card in the reliability section.

Suggested columns:

- Key
- Traffic class
- 24h requests
- Share of keyed load
- Share of total public-api load
- Rate limit / minute
- Status

Suggested scope note:

- "Authenticated API-key requests on protected public routes only. This table excludes `/_site-data/*`, `site-api`, exempt public routes, and any public-api traffic that was not authenticated with a valid key."

This note matters because the table will not sum to total site/external demand when public traffic is allowed without a valid key.

Important MVP constraint:

- do **not** present `api_keys.last_used_at` or `last_used_route` as if they are window-scoped load fields
- those values are current metadata, updated on a separate throttled path, and can fall outside the selected telemetry window
- if a future version wants "latest route in window", that needs additional telemetry and is out of scope for the first cut

## Implementation Plan

### 1. Add retained per-key telemetry storage

Create a new backward-compatible D1 migration:

- add `api_key_request_stats`
- add an index on `bucket_start`
- update `worker/migrations/MANIFEST.md`

Do **not** modify or extend `api_key_rate_limit` retention for this feature.

### 2. Record keyed load at request time

Add a retained telemetry recorder for valid keyed public-api requests.

Recommended wiring:

- keep the existing rate-limit path unchanged for enforcement
- add a new helper near `worker/src/lib/request-source-attribution.ts`
- thread `apiKey?.id` through the existing request-source recording path instead of recording directly inside `evaluateAccessGate()`
- schedule the write through the same `ctx.waitUntil(...)` path already used by `createRequestSourceRecorder()`

Design constraints:

- count minute buckets
- prune opportunistically on the same hourly cadence used by other request-attribution tables
- keep retention aligned with request attribution retention (`35 days`) unless there is a strong reason to choose a shorter operator window
- keep the counting point aligned with existing request-attribution semantics so keyed telemetry and total-demand telemetry agree on what a counted request is

Recommended counted scope:

- count authenticated keyed attempts at the same post-gate recording point as existing request attribution
- that keeps keyed telemetry consistent with current demand accounting for:
  - cached responses
  - valid-key requests that later end in `404` / `405`
  - valid-key requests that receive a keyed `429`

### 3. Expose aggregated per-key load to the admin UI

Preferred API option:

- extend `GET /api/request-source-stats`

Add a new query parameter:

- `apiKeyLimit`
  - default `25`
  - max `100`
  - return only keys with `requestCount > 0`, ordered by descending `requestCount`

Add a new response section such as:

- `keyedPublicApi`
  - `requests`
  - `unkeyedPublicApiRequests`
  - `totalPublicApiRequests`
  - `apiKeyLimit`
- `apiKeys[]`
  - `apiKeyId`
  - `name`
  - `maskedToken`
  - `trafficClass` (`current` key config, not a reconstructed historical-in-window class split)
  - `isActive`
  - `expiresAt`
  - `rateLimitPerMinute`
  - `requestCount`
  - `shareOfKeyedRequestsPct`
  - `shareOfTotalPublicApiRequestsPct`

Why extend this endpoint:

- the table is conceptually part of the same reliability/load story
- the page already polls this endpoint on the right cadence
- no extra client query is needed for the new card

Why add `apiKeyLimit` and `keyedPublicApi`:

- `routeLimit` already shows this endpoint is designed to bound expensive breakdowns
- the keyed table should be bounded the same way
- `keyedPublicApi` makes it explicit when the per-key table is only a subset of total public-api load

Alternative:

- extend `GET /api/api-keys` with a `usageWindow` block and per-key counts

This is viable, but weaker for the requested placement because the table belongs next to request-load telemetry rather than inside the operator control panel.

### 4. Update shared contracts

Update:

- `shared/types/request-source.ts`
- any shared barrel exports
- tests that use `ApiRequestAttributionResponse` fixtures
- `shared/lib/api-endpoints/paths.ts` so `API_PATHS.requestSourceStats()` can carry `apiKeyLimit`
- polling/query-contract tests that assert the fixed ops-proxy request path

Keep the new response field optional only if a staged rollout needs compatibility. Otherwise, make the contract explicit and update all fixtures together.

### 5. Add the UI card

Add a new component under `src/components/status/`, for example:

- `api-key-load-table.tsx`

Wire it under the existing request attribution card in:

- `src/app/admin/sections/reliability-section.tsx`

UI behavior:

- sort by descending request volume
- show an empty state when no keyed traffic exists in the window
- preserve the existing Pharos admin visual language
- keep the table horizontally scrollable on smaller viewports
- if rows are truncated by `apiKeyLimit`, make that visible in the card copy rather than silently implying exhaustiveness

### 6. Testing

Add or update:

- worker unit tests for the new recorder
- `worker/src/handlers/http/__tests__/request-source.test.ts` for keyed-recorder wiring behavior
- `worker/src/__tests__/index.fetch.test.ts` to verify valid keyed requests write retained per-key telemetry in the real fetch flow
- worker API tests for `GET /api/request-source-stats`
- frontend component tests for the new table
- admin client fixture tests if the request-source contract changes there
- `src/hooks/__tests__/query-polling-policy.test.ts` for the updated fixed `request-source-stats` query path

Recommended validation commands for implementation:

- `npm run lint`
- `npm test`
- `npm run build`
- `npm run check:migrations`
- `npm run check:doc-sync`
- `cd worker && npx tsc --noEmit`

Before any push:

- `npm run test:merge-gate`

### 7. Documentation

Update:

- `docs/api-reference.md`
  - new `GET /api/request-source-stats` response field
- `docs/status-dashboard.md`
  - reliability section now includes per-key load telemetry
- `docs/architecture.md`
  - endpoint description if the response contract meaningfully changes
- `docs/worker-infrastructure.md`
  - retained keyed-traffic telemetry storage/write path
- `docs/worker-and-api-limits.md`
  - add the retention note for the new telemetry table if retained for 35 days

No methodology docs are affected by this feature.

## Risks and Design Notes

### Historical backfill

There is no retained historical per-key attribution today. After deployment:

- the new table can only populate prospectively
- at most, an immediate stopgap could infer roughly the last 10 minutes from `api_key_rate_limit`, but not 24h history

Recommendation:

- do not backfill
- ship with a note that the table fills in after deploy

### Semantics

The new table should be defined as:

- keyed authenticated load on protected `public-api` routes only

It should **not** claim to represent:

- total site demand
- total external demand
- `site-api` worker load
- exempt public routes where keys are not authenticated today
- unauthenticated public traffic in `off` or `report-only` auth modes

If the UI shows any "traffic class" metadata:

- treat it as the key's current configuration from `api_keys`
- do not claim it is a reconstructed historical class split for the full window

### Separate metadata vs window telemetry

`api_keys.last_used_at` and `api_keys.last_used_route` are useful operational metadata, but they are not the same thing as windowed telemetry:

- they update on a throttled path
- they reflect the latest overall use, not necessarily the selected window
- they should stay in the API-key management panel unless a future version explicitly labels them as "latest overall use"

### Query cost

The admin read is low-frequency and acceptable. The write path is the more important constraint.

This plan keeps the write expansion to one extra D1 upsert per valid keyed request, which is the smallest clean solution that still provides 24h operator visibility.

## Recommendation

Proceed.

This is a clean, low-risk feature if implemented as:

1. a new retained `api_key_request_stats` table
2. a small worker-side recorder for valid keyed requests
3. an extension to `GET /api/request-source-stats`
4. a new admin reliability table rendered directly below the existing demand card

That approach is coherent with the current architecture and avoids overloading the rate-limit table with a telemetry role it was not designed to serve.
