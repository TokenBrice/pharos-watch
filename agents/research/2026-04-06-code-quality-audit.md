# Code Quality Audit

Date: 2026-04-06
Scope: complete audit pass across `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, plus the required context docs and relevant tests. This write-up prioritizes the strongest confirmed findings and excludes speculative or style-only observations.

## Severity Tally

| Severity | Count |
| --- | ---: |
| Critical | 1 |
| High | 2 |
| Medium | 6 |
| Low | 0 |
| Total | 9 |

## Findings

### CQ-001 — Critical

- Location:
  - `worker/src/handlers/http/gates.ts:94-149`
  - `worker/src/lib/api-keys.ts:297-380`
  - `docs/worker-and-api-limits.md:43-44`
  - `docs/api-reference.md:7,154,2146`
- Problem:
  Protected public `/api/*` routes authenticate `X-API-Key` before applying the public IP limiter. When the key is invalid, expired, or malformed, `gateRequest()` returns `401` immediately at `worker/src/handlers/http/gates.ts:114-127`, and never reaches `checkPublicApiRateLimit()` at `worker/src/handlers/http/gates.ts:131-149`. Because `authenticateApiKey()` performs a D1 lookup and hash work at `worker/src/lib/api-keys.ts:336-380`, an attacker can force repeated protected-route auth work with random keys while bypassing the documented fallback public limiter.
- Why it matters:
  This is both an error-handling and security defect. Invalid-key traffic is exactly the class of traffic that should be throttled aggressively. Instead, it can fan out into repeated D1 work and contradicts the public contract documented for protected routes when auth is not satisfied.
- Recommendation:
  Apply the public IP limiter before or alongside protected-route auth failures. The safest fix is:
  1. Keep valid keys on the per-key limiter path.
  2. Route missing/invalid/expired keys through `checkPublicApiRateLimit()` before returning `401`.
  3. Add an explicit regression test that proves invalid-key traffic increments the public limiter table.

### CQ-002 — High

- Location:
  - `worker/src/cron/compute-dews.ts:448-500`
  - `worker/src/cron/compute-dews.ts:597-666`
  - `worker/src/lib/dews.ts:479-487`
- Problem:
  `computeAndStoreDEWS()` builds `mintBurnMap` only by iterating `mb24hMap` at `worker/src/cron/compute-dews.ts:491-499`. Coins that have a valid 30-day baseline but zero rows in the last 24 hours never enter the map. Later, those coins receive `burnVolume24hUsd: null`, `mintVolume24hUsd: null`, `burnBaseline30dUsd: null` via `worker/src/cron/compute-dews.ts:663-666`, and `computeFlowSignal()` marks the signal unavailable at `worker/src/lib/dews.ts:481-487`.
- Why it matters:
  Zero current flow with non-zero history is a meaningful state, not missing data. The current implementation silently drops the flow signal for exactly the case where the baseline should still anchor the comparison, which can understate stress and distort DEWS weighting.
- Recommendation:
  Build `mintBurnMap` from the union of `mb24hMap` and `mb30dMap`, defaulting missing 24h volumes to `0` while preserving 30-day baselines and `days_with_data`. Add a targeted test for `0 current / non-zero baseline`.

### CQ-003 — High

- Location:
  - `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:263-270`
  - `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:342-344`
  - `worker/src/cron/dex-liquidity/orchestrator.ts:291-294`
- Problem:
  If the previous coverage-count read fails, `analyzeDexLiquidityPostScoring()` logs a warning and substitutes `{ cnt: 9999 }` at `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:267-270`. That synthetic value then feeds `minExpectedCoverage` and `nearCoverageGuard` at `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:342-344`, and can trigger the hard failure in `worker/src/cron/dex-liquidity/orchestrator.ts:291-294`.
- Why it matters:
  A telemetry/read-path failure is converted into a fabricated historical baseline and then treated as a correctness invariant. That is inverted error handling: a transient inability to read old coverage can fail the entire cron even when the current scoring output is fine.
- Recommendation:
  Replace the `9999` sentinel with a nullable/unknown state. Skip the hard coverage guard when the previous coverage read fails, and record the degraded observability state in metadata instead of manufacturing a baseline.

### CQ-004 — Medium

- Location:
  - Production path: `worker/src/handlers/http/gates.ts:94-149`
  - Related tests: `worker/src/api/__tests__/api-keys.test.ts:338-347`, `worker/src/__tests__/index.fetch.test.ts:472-485`
- Problem:
  The current test coverage proves only two protected-route branches: invalid key returns `401` and valid key uses `api_key_rate_limit`. There is no regression test asserting that invalid-key traffic is subject to `public_api_rate_limit`, even though the docs claim that fallback behavior.
- Why it matters:
  The defect in CQ-001 made it through because the critical error path is untested. Auth/rate-limit interactions are a high-risk surface and should not rely on documentation alone.
- Recommendation:
  Add an integration test that sends repeated protected-route requests with an invalid `X-API-Key`, asserts the public limiter table is touched, and verifies eventual `429` behavior. Keep the existing valid-key test separate so the two lanes stay explicit.

### CQ-005 — Medium

- Location:
  - Production path: `worker/src/cron/compute-dews.ts:448-500`, `worker/src/lib/dews.ts:479-487`
  - Related tests: `worker/src/lib/__tests__/dews.test.ts:289-317`, `worker/src/cron/__tests__/compute-dews.test.ts:247-527`
- Problem:
  The flow-signal tests cover “available”, “no data”, and “data too young”, but there is no case for a coin with a 30-day mint/burn baseline and zero last-24h flow. The cron test suite also does not assert that `computeAndStoreDEWS()` preserves baselines when `mb24h` is empty.
- Why it matters:
  CQ-002 is a silent data-loss bug in a scoring pipeline. Without a regression test, a future refactor could reintroduce the same failure even after a fix.
- Recommendation:
  Add one unit test in `worker/src/lib/__tests__/dews.test.ts` for `burnVolume24hUsd = 0`, `mintVolume24hUsd = 0`, `burnBaseline30dUsd > 0`, and one cron-level test in `worker/src/cron/__tests__/compute-dews.test.ts` that feeds only 30-day mint/burn rows and verifies the DEWS input passed to `computeDEWS()`.

### CQ-006 — Medium

- Location:
  - `worker/src/cron/sync-yield-data.ts:226-702`
  - Coupled responsibilities visible at `worker/src/cron/sync-yield-data.ts:247-278`, `293-324`, `361-441`, `458-478`, `503-587`, `632-651`
- Problem:
  `syncYieldData()` is a large orchestration hotspot that mixes unrelated responsibilities in a single function: cache parsing, safety-score snapshot publication, on-chain cooldown state management, yield history loading, source evaluation, coverage guards, persistence, cache writes, and cleanup. The function spans roughly 477 lines with multiple decision-heavy branches.
- Why it matters:
  This is a textbook SRP violation. The current shape makes the function difficult to reason about, difficult to unit-test in isolation, and fragile to modify. The risk is amplified because it also writes `report_card_cache`, so yield sync is implicitly responsible for a safety-score publication side effect.
- Recommendation:
  Split `syncYieldData()` into explicit phases with typed boundaries, for example:
  - input/state loading
  - source resolution
  - evaluation and guard calculation
  - publication/persistence
  - cooldown-state update
  Keep the top-level cron function as a thin coordinator that composes those steps.

### CQ-007 — Medium

- Location:
  - `worker/src/cron/compute-dews.ts:156-788`
  - Mixed responsibilities visible at `worker/src/cron/compute-dews.ts:198-560`, `580-675`, `688-788`
- Problem:
  `computeAndStoreDEWS()` is another orchestration hotspot. It performs source reads, malformed-input handling, previous-signal loading, mint/burn aggregation, blacklist/yield enrichment, per-asset scoring, orphan cleanup, validation, and batch persistence in one function spanning roughly 633 lines.
- Why it matters:
  The current structure hides data-quality bugs like CQ-002 because the source-loading and scoring concerns are intertwined. It also forces tests to mock the entire function graph instead of validating smaller, deterministic transforms.
- Recommendation:
  Extract:
  - source loaders returning typed maps plus degradation metadata
  - a pure “build DEWS input per asset” step
  - persistence/cleanup post-processing
  Then unit-test the input-builder independently from D1 and cache interactions.

### CQ-008 — Medium

- Location:
  - `src/components/contagion-graph.tsx:53-783`
  - Mixed concerns visible at `src/components/contagion-graph.tsx:59-114`, `120-222`, `250-388`, `392-462`, `464-783`
- Problem:
  `ContagionGraph` owns graph derivation, simulation, drag logic, keyboard navigation, neighborhood scoping, BFS ripple highlighting, tooltip composition, and the full SVG render tree in one component. The component spans about 731 lines and contains several dense interaction branches.
- Why it matters:
  This is a frontend maintainability and correctness risk. Interaction-heavy components regress easily when state derivation, event handling, and rendering are tightly coupled. Accessibility behavior in particular is hard to verify when keyboard and pointer logic live inside the render component.
- Recommendation:
  Extract at least three seams:
  - a graph-state hook for derived nodes/links/visibility
  - an interaction hook for drag/focus/keyboard behavior
  - presentational subcomponents for edges, nodes, and tooltips
  Preserve the current UI, but reduce the state and event surface area in the parent component.

### CQ-009 — Medium

- Location:
  - `worker/src/api/api-key-audit-log.ts:53-60`
  - Related tests: `worker/src/api/__tests__/api-key-audit-log.test.ts:13-52`
- Problem:
  `handleApiKeyAuditLog()` parses `row.detail_json` with bare `JSON.parse()` inside the response mapper. A single malformed persisted row will throw and fail the entire endpoint. The current tests cover only valid JSON and filter behavior.
- Why it matters:
  This is a brittle admin path. Audit-log data is append-only operational state; one bad row should not take down the whole response. The current behavior converts one malformed record into a full endpoint failure.
- Recommendation:
  Parse `detail_json` defensively. On parse failure, either return `detail: null` plus a `detailParseError` marker, or omit only the malformed row while logging the incident. Add a test with invalid `detail_json` to prove the endpoint still returns `200`.

## Notes

- `npm run check:unused-code`, `npm run check:shared-cycles`, `npm run check:duplicate-exports`, and `npm run check:hotspot-ratchet` all passed during the audit. Those guards are useful, but they do not cover the runtime bugs and error-path gaps above.
- `npm audit --audit-level=high --json` reported no current high/critical dependency vulnerabilities in the installed tree.
