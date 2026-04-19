# Status/Admin Cron Freshness Remediation Plan

Date: 2026-04-19
Owner: Codex
Status: draft v2, reviewer fixes applied

## Scope

Audit and remediation plan for `/status/`, `/admin/`, and the worker health/status data those pages consume after the 2026-04-18/19 cron cadence changes.

## Assumptions

- The current local worker schedule metadata is the intended new state.
- `/admin/` live content is Cloudflare Access-gated; live verification so far covers only the Access redirect and public endpoints.
- Public `/status/` uses `/_site-data/health`, browser probe hooks, `/_site-data/public-status-history`, and shared status components.
- Admin `/admin/` uses the same public health payload plus Access-proxied `/api/status`, `/api/status-history`, request-attribution endpoints, and browser probes.

## Success Criteria

- `/status/` and `/admin/` distinguish three concepts instead of collapsing them:
  - producer cadence: how often the writer is expected to run
  - endpoint freshness budget: max-age used for `X-Data-Age`, `_meta`, `Warning`, and endpoint stale banners
  - availability budget: max-age used by `/api/health`, `/api/status`, `summary.worstCacheRatio`, and incident severity
- A public endpoint cannot emit a stale/degraded freshness warning while `/status/` presents that same lane as plainly healthy without either explaining the stricter endpoint budget or surfacing a warning.
- Browser endpoint probes are either true semantic probes or clearly labeled transport reachability probes. A `200` response with a freshness `Warning` must not be counted as plainly semantically healthy.
- Cron lane labels, group descriptions, and badges represent the new schedules: 6-hour blacklist, 2-hour DEX discovery, mixed shared/isolated half-hour lanes, 4-hour reserve/redemption/Kinesis, 4-hour yield supplemental, hourly yield publication, daily 03:00 retention pruning, and daily 08:00/08:05 jobs.
- Public and admin top-fold freshness indicators are labeled as dashboard/client fetch freshness, not underlying data freshness.
- Tests pin the corrected freshness contracts, copied schedule descriptions, and UI labels so future cron changes fail loudly when status/admin drift.
- Docs and doc-sync checks are updated wherever endpoint freshness, status payload fields, cron cadence descriptions, or operator visibility semantics change.

## Verification Performed

- Read relevant docs: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`.
- Inspected worker cron authority: `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/wrangler.toml`, scheduled handlers.
- Inspected `/status/` and `/admin/` client code, shared status components, cache health logic, endpoint probe logic, and status/health worker handlers.
- Ran `npm run check:cron-sync`: passed, 16 triggers and 16 runners aligned. This only proves trigger/runner alignment; it does not validate per-job intervals, group copy, status display, or connection budgets.
- Ran focused tests:
  - `worker/src/api/__tests__/status.test.ts`
  - `worker/src/lib/__tests__/api-utils.test.ts`
  - `src/components/__tests__/dataset-freshness-table.test.tsx`
  - `src/components/status/__tests__/cron-metadata-summary.test.ts`
  - Result: 4 files, 115 tests passed.
- Pre-remediation live endpoint sample at 2026-04-18T23:17Z:
  - `https://pharos.watch/_site-data/health` returned `status="healthy"`.
  - Same payload reported `dews.ageSeconds=7439`, `dews.maxAge=1800`, `healthy=true`.
  - `https://pharos.watch/_site-data/stress-signals` simultaneously returned `Warning: 110 - "Response is stale (7431s old, max 900s)"`.
  - `https://pharos.watch/_site-data/dex-liquidity` reported `X-Data-Age=7630` with no warning because the endpoint uses a 3600s freshness budget and the generic warning runway is 8x.
  - `https://pharos.watch/_site-data/health` reported `dex-liquidity.maxAge=43200`, so `/status/` says the DEX availability target is 12h while the endpoint freshness budget is 1h.
  - `https://ops.pharos.watch/admin/` returned a Cloudflare Access login redirect. Authenticated admin content was not live-verified.

## Findings

### P0: DEWS Status Health Disagrees With Public Endpoint Freshness

`worker/src/api/stress-signals.ts` calls `addFreshnessHeaders(..., 900)` for aggregate and per-coin stress-signal responses. `/api/health` and `/api/status` classify the `dews` cache lane via `CACHE_FRESHNESS_THRESHOLDS.dews = 1800`.

Impact:

- Public `/status/` can show DEWS as healthy while the public DEWS endpoint emits `Warning: 110` and `Cache-Control: no-store`.
- This was active on the live site in the endpoint sample above.

Remediation:

- Replace the hard-coded `900` in `worker/src/api/stress-signals.ts` with the canonical DEWS endpoint budget.
- Default recommendation: set the DEWS endpoint budget to 1800s to match `CRON_INTERVALS["compute-dews"]`, `API_FRESHNESS_MAX_AGE_SEC.stressSignals`, and status availability.
- Add a regression test that a 7400s-old aggregate DEWS sample does not emit a stale warning under the 1800s budget.

### P1: Freshness Budgets Are Split And Have Different Semantics

Freshness budgets currently live in at least three places:

- `worker/src/lib/constants.ts` (`CACHE_FRESHNESS_THRESHOLDS`) drives `/api/health`, `/api/status`, `/status/`, `/admin/`, `summary.worstCacheRatio`, and availability severity.
- `shared/lib/api-freshness.ts` drives frontend stale-data presets and some endpoint handlers.
- Individual route handlers still pass literal max-age values into `addFreshnessHeaders()`.

Important constraint:

- `CACHE_FRESHNESS_THRESHOLDS` is not just display metadata. Changing a lane there changes public/admin availability incident thresholds because cache status uses `8x/12x` ratio bands.

Concrete drift:

| Lane | Endpoint Budget | Availability Budget | Producer Cadence | Required Decision |
| --- | ---: | ---: | ---: | --- |
| stablecoins | 600s handler, 900s shared config | 600s | 900s | Preserve current 600s API/status contract or explicitly change the public API contract to 900s. Do not silently reinterpret the current target. |
| dews / stress-signals | 900s handler, 1800s shared config | 1800s | 1800s | Fix to one canonical 1800s budget unless a stricter endpoint budget is intentionally documented and surfaced. |
| dex-liquidity | 3600s | 43200s | scoring 1800s, discovery 7200s | Do not collapse these without an explicit incident-threshold change. If the 12h availability budget remains, show both values and explain why. |
| bluechip-ratings | 43200s | 86400s | 86400s | Either align both budgets or document/surface the stricter endpoint budget separately from status availability. |
| mint-burn flows | 3600s | health uses 60m fresh / 90m degraded / stale after 90m | critical writer 1800s | Keep separate from generic cache freshness. |
| mint-burn events | 900s | not in cache table | critical writer 1800s | Audit separately; only this endpoint uses the stricter 900s budget. |

Remediation:

- Add a shared freshness-lane contract, likely in `shared/lib/api-freshness.ts`, with explicit fields:
  - `producerJob`
  - `producerIntervalSec`
  - `endpointMaxAgeSec`
  - `availabilityMaxAgeSec`
  - `endpointBudgetReason`
  - `availabilityBudgetReason`
- Route handlers must consume `endpointMaxAgeSec`.
- `/api/health` and `/api/status` must consume `availabilityMaxAgeSec`.
- `/status/` and `/admin/` should display enough context to avoid making a 12h availability budget look like a 12h writer cadence.
- Either derive `worker/src/lib/freshness-sentinels.ts` from the shared lane contract, or keep it worker-local and add a test that sentinel producer jobs match the shared `producerJob` entries.
- Do not change DEX, stablecoins, Bluechip, or mint/burn incident thresholds without explicit tests and docs that describe the threshold change.

### P1: Browser Endpoint Probes Can Overstate Data Freshness

`use-endpoint-probes.ts` treats non-semantic endpoint probes as transport-only. `status-dashboard-model.ts` then treats a 2xx non-semantic response as healthy, and `EndpointHealthGrid` copy says the board is semantically healthy.

Impact:

- A route can return `200` with `Warning: 110` and still count as healthy in the browser probe board.
- This undermines the success criterion that stale endpoint freshness should not be presented as plainly healthy.

Remediation:

- Preferred: have browser probes inspect `Warning` and `X-Data-Age` for non-semantic routes and set `semanticStatus` to degraded/stale for freshness warnings.
- Simpler acceptable alternative: relabel non-semantic route probes as transport reachability only and move data freshness interpretation to `CacheFreshnessTable`.
- Add a test for a 200 response with freshness `Warning` so it is not counted as plainly semantically healthy.

### P1: Cron Group Copy And Badges Are Stale Or Under-Specified

`shared/lib/cron-jobs.ts` group metadata feeds `/admin/` cron group cards.

Current issues:

- `half-hourly` says jobs are on isolated 30-minute triggers, but charts/PSI/DEWS/DEX liquidity share the half-hour chain while mint/burn lanes are isolated.
- `hourly` still says "Blacklist sync plus dedicated reserve and core yield publication lanes"; blacklist is 6-hourly and reserve/redemption/Kinesis are 4-hourly.
- `multi-hourly` calls lanes "best-effort slower refresh lanes", but it includes critical `sync-blacklist`.
- `multi-hourly` badge says `~4h` despite 2h/4h/6h jobs.
- `daily` badge says `~08:00` and omits the 03:00 UTC retention-prune slot.
- Scheduled handler filenames and some log prefixes such as `hourly-live-reserves`, `hourly-blacklist`, and `thirty-minute-dex-discovery` are stale. These do not directly render on the pages, so they should be deferred unless the team wants cleanup churn.

Remediation:

- Update `CRON_GROUPS` descriptions and badges so `/admin/` reads correctly.
- Suggested badge changes:
  - multi-hourly: `2-6h`
  - daily: `daily` or `03:00/08:00`
- Add metadata/UI tests that pin the changed group copy and the changed jobs' intervals.

### P2: Pipeline Freshness Table Can Be Misread As Cron Cadence

`DatasetFreshnessTable` shows `Expected` as `min(owner interval) * 2`, then classifies:

- on time: `age <= expected * 4`
- aging: `age <= expected * 6`
- late: `age > expected * 6`

For a 6-hour blacklist writer, the row displays `Expected 12h` and only becomes late after 72h. That may be a deliberate quiet-period grace budget, but the label reads like cron cadence.

Remediation:

- Rename `Expected` to `On-time budget`, or split into `Cadence` and `Late after`.
- `DatasetFreshnessTable` already uses `getCronJobMeta()` to derive the doubled budget; the missing piece is a raw cadence display or clearer label.
- Add tests for blacklist plus DEWS/yield/mint-burn displayed cadence/budget. Reserve cadence belongs in `CronCard` and `ReserveSyncHealthCard`, not this table, unless a new reserve dataset row is deliberately added.

### P2: Public/Admin Top-Fold Freshness Is Dashboard Fetch Freshness

Both pages use `FreshnessIndicator` for client-side query freshness:

- `/status/` computes `lastUpdated` from the health/probe query floor and renders the pill beside the public status badge.
- `/admin/` computes a similar floor across status/health/probes and uses `ADMIN_STALE_AFTER_MS = 180_000`.

This is browser/dashboard fetch freshness, not pipeline freshness.

Remediation:

- Keep the browser fetch thresholds unless operators want a different polling cadence.
- Add visible or accessible labels such as `Dashboard fetch` or `Client sync` next to the pill on both pages.
- Keep `SystemDiagnostics` "Status Freshness" tied to persisted status state (`STATUS_SYSTEM_FRESHNESS_SEC = 1800`).

### P2: Public Mint/Burn Card Needs A Copy Decision

The public status card labels one timestamp "Latest Hourly Sample" while both mint/burn writer lanes run every 30 minutes.

Remediation:

- Confirm whether "hourly sample" means the `mint_burn_hourly` aggregate bucket. If yes, relabel to `Latest hourly rollup`.
- If the intent is writer freshness, replace or supplement the row with `Last successful writer sync`.

### Follow-Up: Manual Digest Trigger Runtime State Is Persisted But Not Surfaced

`worker/src/handlers/scheduled/digest-trigger-poll.ts` persists `digest:last-trigger-result` so the ops UI can report the outcome, but no admin/status component currently reads that cache key.

This is a real operator observability gap, but it is not required to fix the freshness-budget contradiction. Keep it as a follow-up unless the implementation window explicitly includes operator action observability.

Follow-up remediation:

- Prefer adding digest trigger state to `/api/status` supplements instead of creating a new endpoint.
- If a new endpoint is chosen, include the full shared route-model work: `shared/lib/api-endpoints/*`, worker route registry, method/auth/cache-bypass tests, `docs/api-reference.md`, and `docs/architecture.md`.
- Update `docs/worker-and-api-limits.md` either to say the result is currently stored for DB/future UI inspection or to document the new admin UI surface.

## Execution Plan

### Phase 1: Fix Freshness Contract Drift Without Silent Threshold Changes

1. Add canonical lane metadata with `producerIntervalSec`, `endpointMaxAgeSec`, and `availabilityMaxAgeSec`.
2. Use `endpointMaxAgeSec` in endpoint handlers and `_meta` fallback parsing.
3. Use `availabilityMaxAgeSec` for `CACHE_FRESHNESS_THRESHOLDS`, `/api/health`, `/api/status`, and `summary.worstCacheRatio`.
4. Fix the DEWS mismatch by making `stress-signals` use the canonical 1800s endpoint budget, unless a documented stricter endpoint budget is intentionally chosen.
5. Reconcile `API_FRESHNESS_MAX_AGE_SEC.stablecoins` with the current 600s worker contract. Default: preserve 600s and add producer-cadence display; only move to 900s through an explicit API-contract decision.
6. Keep DEX/Bluechip endpoint-vs-availability differences only if their reasons are encoded and displayed.
7. Split mint/burn into separate contracts: flow API freshness, event API freshness, and public health sync semantics. Generic cache work must not change public mint/burn health behavior.
8. Derive or cross-check freshness sentinel producer mappings against the canonical lane metadata.

### Phase 2: Make `/status/` And `/admin/` Accurate To The New State

1. Update `CacheFreshnessTable` to label budget semantics clearly and, if feasible, show producer cadence next to endpoint/availability budgets.
2. Update browser endpoint probe semantics or copy so transport-only 2xx probes are not called semantically healthy when freshness warnings are present.
3. Update `CRON_GROUPS` titles, badges, and descriptions for half-hourly, hourly, multi-hourly, and daily groups.
4. Update `DatasetFreshnessTable` column labels and tests so grace budgets are not mistaken for cron cadence.
5. Add dashboard/client fetch labels to the `FreshnessIndicator` usage on both `/status/` and `/admin/`.
6. Audit public mint/burn card copy and relabel "Latest Hourly Sample" if it refers to hourly rollups.

### Phase 3: Optional Operator Observability Follow-Up

1. Surface digest trigger pending/result state in `/admin/` only if the implementation scope includes operator action observability.
2. Prefer `/api/status` supplements over a new endpoint.
3. If deferred, update docs so they do not imply current ops-UI visibility.

### Phase 4: Docs, Guardrails, And Validation

1. Update `docs/api-reference.md`:
   - response-body freshness table
   - affected endpoint freshness notes
   - `/api/health.caches[*]` field semantics
   - correct `CacheStatus.healthy` docs to match the code's `8x/12x` bands, not the stale `1.5x` wording
   - `/api/status` supplement docs if digest trigger state is added
2. Update `docs/worker-and-api-limits.md` for current cron cadence copy and digest trigger visibility wording.
3. Update `docs/architecture.md` only if public/admin endpoint contracts or status fields change.
4. Extend `scripts/lib/doc-sync/checks.ts` so freshness rows and representative `/api/health.caches[*].maxAge` examples in `docs/api-reference.md` are checked against the canonical freshness config.
5. Add tests:
   - DEWS endpoint/status budget alignment
   - stablecoins shared-config/current-contract decision
   - DEX/Bluechip endpoint vs availability budget display or explicit alignment
   - browser probe handling of 200 + freshness `Warning`
   - cron metadata/group copy for 6h blacklist, 2h DEX discovery, 4h reserve/redemption/Kinesis, hourly yield publication, 4h yield supplemental, and daily 03:00 pruning
   - dataset freshness labels for blacklist, DEWS, yield, and mint/burn
6. Run:
   - `npm run check:cron-sync`
   - `npm run check:cron-connections`
   - `npm run check:doc-sync`
   - focused status/freshness/UI tests
   - `npm run lint`
   - `npm run typecheck`
   - `cd worker && npx tsc --noEmit`
   - post-deploy/live options when credentials are available: `npm run test:smoke-api`, `npm run test:smoke-ui -- --url https://pharos.watch --mode live`, `npm run test:smoke-ops`
   - `npm run test:merge-gate` before push.

## Open Decisions

- Should stablecoins keep the current 600s public freshness budget while showing producer cadence as 15m, or should the API contract move to 900s?
- Should DEX liquidity keep a 12h availability budget while the endpoint budget is 1h, or should availability become stricter? This is an incident-threshold decision, not a display-only cleanup.
- Should Bluechip use a 12h endpoint budget and 24h availability budget, or should those align?
- Should `/api/mint-burn-events` keep its 900s endpoint budget, or should it follow the 30-minute critical writer / 1h aggregate flow budget?
- Should digest trigger result visibility be included in this remediation or tracked as a separate operator-observability task?

## Reviewer Loop Log

- v1: Initial plan drafted from code inspection, focused tests, and public live probes.
- Reviewer A found seven minor-or-worse issues, including endpoint-vs-availability budget conflation, stablecoins 600s vs 900s contract ambiguity, sentinel mapping coverage, mint/burn contract conflation, invalid reserve dataset-table test target, digest follow-up scope, and stale `CacheStatus.healthy` docs.
- Reviewer B found five minor-or-worse issues, including probe semantics for 200 + freshness warnings, public top-fold fetch freshness ambiguity, half-hourly/badge cron copy drift, invalid reserve dataset-table target, and public mint/burn hourly-sample copy.
- Reviewer C found five minor-or-worse issues, including missing doc-sync guardrails, insufficient cron-connection/interval validation, incomplete digest endpoint/supplement planning, digest docs visibility drift, and overstatement of live UI/admin verification.
- v2: Applied reviewer fixes by splitting endpoint/availability/producer freshness semantics, narrowing threshold-change recommendations, adding probe semantics work, expanding cron-copy coverage, moving digest trigger state to optional follow-up, and adding docs/test guardrails.
- Second-pass Reviewer A result: 0 remaining minor-or-worse issues.
- Second-pass Reviewer B result: 0 remaining minor-or-worse issues.
- Second-pass Reviewer C result: 0 remaining minor-or-worse issues.
- Loop exit condition met: fewer than three minor issues remain.
