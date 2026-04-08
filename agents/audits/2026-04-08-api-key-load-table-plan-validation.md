# API Key Load Table Plan Validation

## Scope

Validate the execution plan for adding an API-key load table below the existing request-attribution card on `/admin/`, research the relevant implementation surface, and iterate the plan through a review/fix loop until the review stage finds fewer than one medium-or-higher issue.

Primary plan under review:

- `agents/plans/2026-04-08-api-key-load-table-plan.md`

## Research Performed

Reviewed the relevant code and docs for:

- admin reliability composition and insertion point
- request-source telemetry storage and aggregation
- API-key auth, rate limiting, and metadata updates
- public-api auth-mode behavior (`off`, `report-only`, `enforce`)
- ops proxy/query path plumbing
- current test coverage and migration validation surface

Primary files inspected:

- `src/app/admin/sections/reliability-section.tsx`
- `src/components/status/request-source-attribution-card.tsx`
- `src/components/status/api-keys-panel.tsx`
- `src/hooks/use-request-source-stats.ts`
- `src/hooks/use-status-dashboard-model.ts`
- `src/hooks/use-admin-polling-query.ts`
- `src/hooks/__tests__/query-polling-policy.test.ts`
- `worker/src/api/request-source-stats.ts`
- `worker/src/lib/request-source-attribution.ts`
- `worker/src/lib/api-key-admin.ts`
- `worker/src/lib/api-key-auth.ts`
- `worker/src/lib/api-key-rate-limit.ts`
- `worker/src/lib/api-key-core.ts`
- `worker/src/handlers/http/gates.ts`
- `worker/src/handlers/http/request-source.ts`
- `worker/src/handlers/http/request-dispatch.ts`
- `worker/src/handlers/http/__tests__/request-source.test.ts`
- `worker/src/__tests__/index.fetch.test.ts`
- `worker/src/api/__tests__/request-source-stats.test.ts`
- `worker/migrations/0083_api_keys.sql`
- `worker/migrations/0084_api_key_rate_limit.sql`
- `worker/migrations/0085_total_request_attribution.sql`
- `worker/migrations/MANIFEST.md`
- `functions/api/admin/[[path]].ts`
- `shared/types/request-source.ts`
- `shared/types/api-keys.ts`
- `shared/lib/api-endpoints/paths.ts`
- `shared/lib/api-endpoints/validation.ts`

Primary docs inspected:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/status-dashboard.md`
- `docs/worker-infrastructure.md`
- `docs/operator-origin-access.md`

## Review Loop

### Review 1 Findings

#### Medium 1: Recorder placement was too vague and risked semantic drift

The earlier plan suggested recording per-key telemetry around `evaluateAccessGate()`. That is risky because the existing request-attribution system records through the later request-source recorder path, after gate evaluation and in the same `waitUntil(...)` workflow. Recording in the gate would make keyed telemetry easier to implement incorrectly, either by adding latency or by drifting from the existing counted-request semantics.

Required fix:

- record keyed telemetry through the existing request-source recorder path
- pass `apiKey?.id` through that path
- keep writes on `ctx.waitUntil(...)`

#### Medium 2: Proposed UI fields mixed window telemetry with non-window metadata

The earlier plan proposed showing `lastUsedAt` and `lastUsedRoute` in the load table. Those fields come from `api_keys` and are maintained on a separate throttled metadata path. They are not guaranteed to represent the selected telemetry window.

Required fix:

- remove those from the MVP table plan
- explicitly call out that they are not window-scoped telemetry

#### Medium 3: Endpoint/result semantics were under-specified

The earlier plan did not adequately bound or qualify the response. That created two operator risks:

1. The table could be misread as exhaustive public-api load when the platform is in `off` or `report-only`, or when traffic hits exempt public routes where keys are not authenticated.
2. The response could grow without limit if a keyed breakdown were added with no equivalent to existing `routeLimit`.

Required fix:

- add `apiKeyLimit`
- define rows as keyed authenticated traffic on protected public routes only
- add a keyed-vs-unkeyed public-api summary so the UI can show partial coverage honestly

#### Medium 4: Validation surface omitted migration/query-contract checks

Because this work adds a D1 migration and changes the fixed `request-source-stats` query path, the validation plan needed to explicitly include `check:migrations` and the query-contract test surface.

Required fix:

- add `npm run check:migrations`
- add `npm run check:doc-sync`
- call out `src/hooks/__tests__/query-polling-policy.test.ts`

### Fixes Applied

The plan was revised to:

- route keyed telemetry through the same request-source recorder flow used by existing attribution
- remove `lastUsedAt` / `lastUsedRoute` from the MVP table
- add `apiKeyLimit`
- add `keyedPublicApi` summary fields
- define the table scope as authenticated keyed traffic on protected public routes only
- explicitly note that current `trafficClass` metadata is not a reconstructed historical-in-window split
- expand testing and validation to cover recorder wiring, fetch-path integration, query-path assertions, migrations, and doc-sync

### Review 2 Outcome

Result:

- **0 medium-or-higher issues found**

Residual low-risk note:

- The plan currently assumes that keeping retained per-key telemetry on the same 35-day horizon as existing request attribution is acceptable. That is reasonable given the current architecture, but implementation should still sanity-check expected active-key cardinality before locking retention if live operator usage turns out to be materially larger than expected.

This is a low issue, not a medium one, because the feature requirement is a 24h operator table, the endpoint already uses bounded breakdowns, and retention can be shortened later without changing the core design.

## Final Validation Verdict

The revised plan is ready for implementation work.

Recommended execution path remains:

1. additive D1 table for retained keyed telemetry
2. keyed recorder added through the existing request-source recording path
3. bounded `GET /api/request-source-stats` extension with keyed summary + per-key rows
4. new reliability card under the existing demand section
5. migration, contract, frontend, and docs validation before push
