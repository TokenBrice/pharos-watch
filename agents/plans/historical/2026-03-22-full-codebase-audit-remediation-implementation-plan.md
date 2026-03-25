# 2026-03-22 Full Codebase Audit Remediation Implementation Plan

> Execution plan for [agents/audits/2026-03-21-full-codebase-audit.md](../audits/2026-03-21-full-codebase-audit.md).
> Scope covers all `27` findings from that audit.

## Objective

Execute the audit findings in a way that:

- restores a fully green validation baseline first
- fixes operational correctness issues before structural refactors
- removes duplicated policy and UI logic without changing product behavior unnecessarily
- expands test and guardrail coverage before ratcheting architecture and complexity
- ends with a more deterministic release pipeline and clearer ownership boundaries

## Source Findings Covered

| Workstream | Findings |
| --- | --- |
| `WS1` Reserve metadata and validation baseline | `QLT-009`, `SUS-001` |
| `WS2` Status correctness and observability hardening | `QLT-001`, `QLT-002`, `QLT-005` |
| `WS3` FX and depeg operational hardening | `QLT-004`, `QLT-007`, `QLT-008` |
| `WS4` Feedback and admin proxy hardening | `QLT-003`, `QLT-006` |
| `WS5` Worker-side redundancy removal | `RED-001`, `RED-007` |
| `WS6` Frontend/page/OG redundancy removal | `RED-002`, `RED-003`, `RED-004`, `RED-005`, `RED-006`, `RED-008` |
| `WS7` UI coverage and hotspot ratchet expansion | `QLT-010`, `SUS-002` |
| `WS8` Worker route and endpoint source-of-truth unification | `SUS-003` |
| `WS9` Local/CI guardrail and hygiene expansion | `SUS-004`, `SUS-006`, `SUS-007`, `SUS-008` |
| `WS10` Import-cycle and boundary cleanup | `SUS-009` |
| `WS11` Release determinism and deployment hardening | `SUS-005` |

All `27` findings are covered exactly once by the workstream map above.

## Constraints

- Keep public API behavior stable unless the current behavior is objectively misleading or broken.
- Do not combine correctness fixes with large architectural rewrites in the same PR.
- Preserve existing product and design-system patterns; these findings are not a redesign mandate.
- Update docs for any runtime, API, pipeline, or workflow behavior change.
- Do not expand methodology scope. This plan does not include scoring or methodology changes to PSI, DEWS, report cards, liquidity, mint/burn, or yield.
- Keep Cloudflare Worker connection-budget constraints in mind when touching cron/network code.

## Non-Goals

- No broad rewrite of the Next.js frontend shell.
- No worker router replacement from scratch.
- No migration renumbering or historical schema rewrite.
- No dependency-refresh campaign beyond the specific low-risk patch updates already called out in `SUS-008`.

## Execution Principles

- Fix the broken baseline before starting deep refactors.
- Add or tighten characterization tests before decomposing critical worker paths.
- Prefer one canonical source of truth over adding a second abstraction layer.
- Separate “behavior change” PRs from “shape-only refactor” PRs whenever practical.
- Land low-risk duplication removals before expanding ratchets and unused-code checks.

## Mandatory Validation Gates

Run for every merge-ready PR in this plan unless the PR is docs-only:

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
```

Run these whenever the affected area changes:

```bash
npm run check:worker-boundary
npm run check:migrations
npm run check:doc-counts
npm run check:doc-sync
npm run check:duplicate-exports
npm run check:unused-code
npm run check:hotspot-ratchet
npm run audit:deps
```

Ad hoc verification required for cycle cleanup:

```bash
npx madge --circular --extensions ts,tsx,mts,js,mjs src shared worker/src functions --ts-config tsconfig.json
```

## Recommended Phase And PR Sequence

| Phase | PRs | Goal |
| --- | --- | --- |
| `P0` | `PR-00` | Characterization and baseline capture |
| `P1` | `PR-01` to `PR-04` | Restore green baseline and close correctness bugs |
| `P2` | `PR-05` to `PR-07` | Remove duplication and add high-value UI coverage |
| `P3` | `PR-08` to `PR-10` | Expand guardrails and clean structural boundaries |
| `P4` | `PR-11` to `PR-12` | Finish architectural unification and release determinism work |

Recommended PR order:

```text
PR-00 Baseline characterization and acceptance fixtures
PR-01 Reserve metadata baseline repair
PR-02 Feedback and admin proxy hardening
PR-03 FX and depeg operational hardening
PR-04 Status correctness and observability hardening
PR-05 Worker-side redundancy removal
PR-06 Frontend/page/OG redundancy removal
PR-07 UI coverage expansion + hotspot ratchet expansion
PR-08 Local/CI guardrail and hygiene expansion
PR-09 Import-cycle cleanup
PR-10 Worker route and endpoint source-of-truth unification
PR-11 Release determinism hardening
PR-12 Final dependency patch window, docs sweep, and regression closeout
```

## Parallelization Rules

- `PR-01` and `PR-02` can run in parallel.
- `PR-03` can run in parallel with `PR-05` or `PR-06`.
- `PR-04` should land before `PR-07` because UI tests need the stabilized status payload/behavior.
- `PR-08` should land after the obvious cleanup PRs so new guardrails do not fail on already-known debt.
- `PR-09` should land before `PR-10` if route unification would otherwise compound cycle churn.
- `PR-11` should stay isolated from runtime refactors because it changes CI/release behavior.

## Phase 0 - Baseline And Characterization

### `PR-00` Baseline characterization and acceptance fixtures

Purpose:

- capture current behavior for the worker and UI surfaces that will be refactored
- lock down current failure modes before changing logic

Tasks:

1. Record the current failing reserve warning inventory from `src/lib/__tests__/reserve-coinid-validation.test.ts`.
2. Capture representative payloads/fixtures for:
   - `GET /api/status`
   - `GET /api/status-history`
   - `GET /api/stablecoin/usdt-tether`
   - `POST /api/feedback`
3. Capture current `madge` cycle output and hotspot metrics as reference artifacts in the PR description or implementation notes.
4. Note current Pages release dependency on `https://api.pharos.watch/api/digest-archive`.

Exit criteria:

- characterization artifacts exist for every high-risk module touched later in the plan
- no production behavior has changed yet

## Phase 1 - Green Baseline And Operational Correctness

### `WS1` Reserve metadata and validation baseline

Findings: `QLT-009`, `SUS-001`

Primary files:

- `src/lib/__tests__/reserve-coinid-validation.test.ts`
- `shared/data/stablecoins/usd-minor.json`
- `shared/lib/__tests__/reserve-risk-consistency.test.ts`
- `docs/live-reserves.md`
- `docs/testing.md`

Implementation:

1. Replace the global warning ceiling with an explicit reviewed-warning registry keyed by stablecoin and reserve-slice identifier.
2. Backfill deterministic missing `coinId` values in `shared/data/stablecoins/usd-minor.json`.
3. Separate resolvable cases from intentional exceptions so the test fails only on newly introduced unreviewed warnings.
4. Keep `reserve-risk-consistency` as the hard fail for true data bugs.
5. Document the rule: new reserve slices referencing tracked assets must either set `coinId` or be added to the reviewed exception registry with justification.

Acceptance criteria:

- `npm test` is green again
- reserve warning drift is explicit and reviewable
- known exceptions are documented rather than hidden behind a moving ceiling

Validation:

```bash
npx vitest run src/lib/__tests__/reserve-coinid-validation.test.ts shared/lib/__tests__/reserve-risk-consistency.test.ts
npm test
```

Risk:

- Medium. This changes both test policy and reserve metadata.

### `WS4` Feedback and admin proxy hardening

Findings: `QLT-003`, `QLT-006`

Primary files:

- `worker/src/api/feedback/request.ts`
- `worker/src/api/feedback.ts`
- `functions/api/admin/[[path]].ts`
- `worker/src/api/__tests__/feedback.test.ts`
- `functions/__tests__/ops-admin-proxy.test.ts`
- `docs/feedback-pipeline.md`
- `docs/operator-origin-access.md`

Implementation:

1. Reorder feedback submission preparation so required secrets are validated before the rate-limit check consumes quota.
2. Preserve current user-visible status codes and messages except where the secret-order fix removes false `429` consumption.
3. Wrap the Pages admin proxy upstream fetch in an explicit timeout.
4. Return a distinct `504` timeout response instead of collapsing all upstream hangs into `502`.
5. Add regression tests for:
   - feedback secret-misconfiguration path
   - feedback rate-limit ordering
   - admin proxy timeout path

Acceptance criteria:

- feedback submissions no longer burn quota when GitHub credentials are missing
- admin proxy timeouts are distinguishable from generic upstream fetch failures

Validation:

```bash
npx vitest run worker/src/api/__tests__/feedback.test.ts
npx vitest run functions/__tests__/admin-host-gate.test.ts functions/__tests__/ops-admin-proxy.test.ts functions/__tests__/ops-env.test.ts
```

Risk:

- Low to medium. Both fixes are narrow but touch operator-facing paths.

### `WS3` FX and depeg operational hardening

Findings: `QLT-004`, `QLT-007`, `QLT-008`

Primary files:

- `worker/src/cron/sync-fx-rates.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/lib/cex-tickers.ts`
- `worker/src/cron/__tests__/sync-fx-rates.test.ts`
- `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`
- `docs/pricing-pipeline.md`
- `docs/depeg-detection.md`
- `docs/worker-and-api-limits.md`

Implementation:

1. Split OXR cooldown semantics into “last attempt” and, if still needed, “last successful usable fetch”.
2. Persist cooldown state on any completed OXR response, not only on responses that yield usable rates.
3. Hoist the Binance ticker fetch out of the per-row loop in `confirmPendingDepegs`.
4. Refactor the depeg confirmation test suite so the CEX branch does not depend on live network.
5. Add tests covering:
   - zero-usable-rate OXR responses
   - one Binance fetch per cron run
   - fully deterministic confirm-pending-depegs behavior

Acceptance criteria:

- OXR obeys the intended throttle after any completed request
- the depeg confirmer makes at most one Binance snapshot fetch per run
- the unit suite is fully deterministic offline

Validation:

```bash
npx vitest run worker/src/cron/__tests__/sync-fx-rates.test.ts
npx vitest run worker/src/cron/__tests__/confirm-pending-depegs.test.ts
```

Risk:

- Medium. The FX cron and depeg confirmer are operationally sensitive.

### `WS2` Status correctness and observability hardening

Findings: `QLT-001`, `QLT-002`, `QLT-005`

Primary files:

- `worker/src/lib/status-evaluation.ts`
- `worker/src/lib/status-reliability.ts`
- `worker/src/api/status.ts`
- `worker/src/api/status-history.ts`
- `worker/src/api/__tests__/status.test.ts`
- `worker/src/api/__tests__/status-history.test.ts`
- `worker/src/lib/__tests__/status-reliability.test.ts`
- `worker/src/cron/__tests__/status-self-check.test.ts`
- `docs/status-dashboard.md`
- `docs/api-reference.md`
- `docs/architecture.md`

Implementation:

1. Introduce an explicit “unknown / telemetry failed” cron-health path so `cron_runs` query failure does not mark every cron unhealthy by default.
2. Ensure general cache warnings are emitted independently of FX-source warnings.
3. Replace silent persistence catches in status reliability with operator-visible degraded diagnostics.
4. Keep the public contract stable where possible. If a new diagnostic flag or section error is added, document it explicitly.
5. Add regression coverage for:
   - cron history query failure
   - FX warnings coexisting with other cache warnings
   - migration-missing and write-failure paths in status persistence

Acceptance criteria:

- telemetry failures are no longer misreported as platform staleness
- hidden status persistence degradation becomes observable
- status API consumers continue to work without contract ambiguity

Validation:

```bash
npx vitest run worker/src/api/__tests__/status.test.ts worker/src/api/__tests__/status-history.test.ts
npx vitest run worker/src/lib/__tests__/status-reliability.test.ts worker/src/cron/__tests__/status-self-check.test.ts
```

Risk:

- High. This is the most operator-sensitive runtime workstream.

## Phase 2 - Redundancy Removal And Coverage Expansion

### `WS5` Worker-side redundancy removal

Findings: `RED-001`, `RED-007`

Primary files:

- `worker/src/api/telegram-webhook.ts`
- `worker/src/cron/mint-burn/run-state.ts`
- `worker/src/lib/fx-rate-state.ts`
- `worker/src/lib/price-validation.ts`
- `worker/src/api/__tests__/telegram-webhook.test.ts`
- `worker/src/api/__tests__/telegram-webhook-parsing.test.ts`
- `docs/telegram-alerts.md`

Implementation:

1. Extract Telegram command completion behavior into a shared action-handler registry used by both the initial-command path and the disambiguation-reply path.
2. Preserve message text and persistence semantics unless the duplication currently hides inconsistent behavior.
3. Extract small generic normalizer helpers for repeated record/set sanitation logic.
4. Add tests to prove the Telegram action flow still behaves identically after extraction.

Acceptance criteria:

- Telegram completion behavior has one canonical implementation per action
- small normalization helpers replace the copy-pasted loops without broad behavior churn

Validation:

```bash
npx vitest run worker/src/api/__tests__/telegram-webhook.test.ts worker/src/api/__tests__/telegram-webhook-auth.test.ts worker/src/api/__tests__/telegram-webhook-parsing.test.ts
```

Risk:

- Medium. Telegram behavior is user-visible and stateful.

### `WS6` Frontend/page/OG redundancy removal

Findings: `RED-002`, `RED-003`, `RED-004`, `RED-005`, `RED-006`, `RED-008`

Primary files:

- `src/components/dex-liquidity-card.tsx`
- `src/components/liquidity-stats.tsx`
- `src/app/stablecoins/backing/[backing]/page.tsx`
- `src/app/stablecoins/governance/[governance]/page.tsx`
- `src/app/compare/[slug]/page.tsx`
- `src/components/daily-digest.tsx`
- `src/app/safety-scores/client.tsx`
- `src/app/stability-index/client.tsx`
- `worker/src/lib/og-templates/safety-scores-card.tsx`
- existing related component tests
- `docs/cemetery-and-compare.md`

Implementation:

1. Introduce a shared slug-backed page helper for backing, governance, and compare routes.
2. Extract shared DEX breakdown bar/legend primitives with configurable thresholds.
3. Extract a shared digest paragraph tokenizer/renderer used by full and preview layouts.
4. Split shared safety-score control primitives from the mobile/desktop layout shells.
5. Collapse `HistoryStats` and `HistoryStatsMobile` into one variantable component.
6. Extract a shared OG performer-list subcomponent for safety-score cards.

Acceptance criteria:

- all duplicated UI logic is centralized without changing page behavior
- route metadata and 404 behavior remain unchanged
- component tests still pass and build output remains stable

Validation:

```bash
npx vitest run src/components/__tests__/liquidity-stats.test.ts src/components/__tests__/comparison-table.test.tsx
npm run build
```

Risk:

- Low to medium. Mostly shape-only frontend refactors.

### `WS7` UI coverage expansion and hotspot ratchet expansion

Findings: `QLT-010`, `SUS-002`

Primary files:

- `src/components/contagion-graph.tsx`
- `src/app/admin/client.tsx`
- new or expanded UI tests under `src/components/__tests__/` and `src/lib/__tests__/`
- `scripts/lib/hotspot-ratchet.mjs`
- `scripts/lib/hotspot-ratchet-baseline.json`
- `docs/testing.md`
- `docs/scripts.md`

Implementation:

1. Add focused RTL coverage for:
   - contagion graph focus, keyboard, and drag behavior
   - admin dashboard rendering, expansion, and critical interaction flows
2. Extract minimal seams only where required to make those surfaces testable.
3. After the tests land, expand the hotspot ratchet target set to include the current highest-risk large modules, not just the original four.
4. Update the ratchet baseline only after the selected files are in their intended post-refactor shape.

Acceptance criteria:

- the two largest untested UI surfaces now have direct behavioral tests
- the hotspot ratchet covers the current true hotspots instead of an outdated subset

Validation:

```bash
npm run check:hotspot-ratchet
npm run build
npm test
```

Risk:

- Medium. UI tests can expose hidden timing/state issues.

## Phase 3 - Guardrails And Structural Boundary Cleanup

### `WS9` Local/CI guardrail and hygiene expansion

Findings: `SUS-004`, `SUS-006`, `SUS-007`, `SUS-008`

Primary files:

- `scripts/test-merge-gate.mjs`
- `.github/workflows/validate-ci.yml`
- `scripts/check-unused-code.mjs`
- `scripts/check-worker-migrations.mjs`
- `scripts/__tests__/check-worker-migrations.test.ts`
- `package.json`
- `package-lock.json`
- `worker/package.json`
- `docs/testing.md`
- `docs/scripts.md`
- `docs/deployment-process.md`

Implementation:

1. Remove the current local/CI drift by making the local merge gate call the same canonical validation set as CI, or by generating both plans from a shared script.
2. Expand unused-code reporting from the current narrow prefixes to all runtime code, with explicit allowlists for justified exceptions.
3. Keep the migration duplicate-prefix exception frozen and documented; do not renumber historical migrations.
4. Land the small dependency patch updates from `SUS-008` in an isolated maintenance PR after the scripts are stable.

Acceptance criteria:

- developers see the same non-negotiable checks locally and in CI
- dead-code scanning covers all runtime surfaces by default
- migration duplicate-prefix handling is explicit and non-expanding
- dependency patch updates keep the repo green

Validation:

```bash
npm run check:unused-code
npm run check:migrations
npm run audit:deps
npm run lint
npm test
```

Risk:

- Medium. Guardrail changes can surface pre-existing debt unexpectedly.

### `WS10` Import-cycle and boundary cleanup

Findings: `SUS-009`

Primary files:

- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/enrich-prices-passes.ts`
- `worker/src/lib/authoritative-price-sources.ts`
- `worker/src/cron/reserve-adapters/index.ts`
- reserve-adapter modules that currently import `AdapterContext` / `AdapterResult` from the barrel
- `docs/dependency-map.md`
- `docs/architecture.md`

Implementation:

1. Break the true runtime cycle in the price-enrichment pipeline by moving shared types/helpers into a leaf module such as `enrich-prices-shared.ts`.
2. Move reserve-adapter shared types out of `index.ts` into a dedicated types module so adapters do not import from their own registration barrel.
3. Re-run `madge` after each cleanup step and keep the diff explicit in PR notes.
4. Add a follow-up script or CI check only if the cycle count is reduced to a stable, intentional baseline.

Acceptance criteria:

- the `enrich-prices` runtime cycle is gone
- reserve adapters no longer depend on the registration barrel for shared types
- cycle output is materially reduced and documented

Validation:

```bash
npx vitest run worker/src/cron/__tests__/enrich-prices.test.ts
npx madge --circular --extensions ts,tsx,mts,js,mjs src shared worker/src functions --ts-config tsconfig.json
```

Risk:

- Medium to high. This is structural worker churn.

## Phase 4 - Architectural Consolidation And Release Determinism

### `WS8` Worker route and endpoint source-of-truth unification

Findings: `SUS-003`

Primary files:

- `worker/src/route-registry.ts`
- `worker/src/router.ts`
- `worker/src/handlers/http/context.ts`
- `shared/lib/api-endpoints.ts`
- `worker/src/api/__tests__/router-contract.test.ts`
- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/dependency-map.md`

Implementation:

1. Designate one canonical endpoint descriptor model for path metadata, methods, admin requirements, route dependencies, and status-page metadata.
2. Derive static route registration and dependency wiring from that descriptor model rather than manually synchronizing separate maps.
3. Keep dynamic routes separate if necessary, but align them to the same dependency-declaration pattern.
4. Migrate incrementally:
   - static routes first
   - dependency wiring second
   - optional dynamic-route normalization last
5. Do not change public paths or allowed methods during the refactor unless the router tests already prove drift.

Acceptance criteria:

- static endpoint metadata and dependency wiring are no longer spread across four disconnected sources
- router contract tests stay green
- docs describe the new canonical route-definition model

Validation:

```bash
npx vitest run worker/src/api/__tests__/router-contract.test.ts
npm run build
```

Risk:

- High. This is a pure maintainability refactor touching central request orchestration.

### `WS11` Release determinism and deployment hardening

Findings: `SUS-005`

Primary files:

- `scripts/sync-digests.ts`
- `.github/workflows/pages-release.yml`
- `.github/workflows/deploy-cloudflare.yml`
- `docs/deployment-process.md`
- `docs/digest-pipeline.md`
- `docs/scripts.md`

Implementation:

1. Remove the hardcoded production API dependency from `scripts/sync-digests.ts`.
2. Make digest synchronization parameterized by explicit input:
   - environment-specific API base URL, or
   - pre-generated digest JSON artifact
3. Preferred approach: add a dedicated CI step that fetches digest data once from the intended deployment environment, stores it as an artifact, and lets the Pages build consume only that artifact.
4. Keep the Pages build itself network-independent with respect to digest data.
5. Update deployment docs with the new artifact/data flow and rollback expectations.

Acceptance criteria:

- Pages release builds no longer fetch digests from `https://api.pharos.watch` during the build itself
- the release pipeline is reproducible from the commit plus CI-provided artifacts/environment
- smoke checks still run in the correct order after the workflow changes

Validation:

```bash
npm run build
npm run seo:check
npm run test:smoke-api
npm run test:smoke-ui -- --url https://pharos.watch
npm run test:smoke-ops
```

Risk:

- High. This changes the deployment pipeline and should be validated in CI before mainline rollout.

## Documentation Update Matrix

Update these docs when the corresponding workstream lands:

| Workstream | Docs |
| --- | --- |
| `WS1` | `docs/live-reserves.md`, `docs/testing.md` |
| `WS2` | `docs/status-dashboard.md`, `docs/api-reference.md`, `docs/architecture.md` |
| `WS3` | `docs/pricing-pipeline.md`, `docs/depeg-detection.md`, `docs/worker-and-api-limits.md` |
| `WS4` | `docs/feedback-pipeline.md`, `docs/operator-origin-access.md` |
| `WS5` | `docs/telegram-alerts.md` if any visible bot behavior changes |
| `WS6` | `docs/cemetery-and-compare.md` only if route/page contract text changes |
| `WS7` | `docs/testing.md`, `docs/scripts.md` |
| `WS8` | `docs/architecture.md`, `docs/api-reference.md`, `docs/dependency-map.md` |
| `WS9` | `docs/testing.md`, `docs/scripts.md`, `docs/deployment-process.md` |
| `WS10` | `docs/architecture.md`, `docs/dependency-map.md` |
| `WS11` | `docs/deployment-process.md`, `docs/digest-pipeline.md`, `docs/scripts.md` |

## Final Definition Of Done

The audit remediation is complete when all of the following are true:

1. Every finding from the 2026-03-21 audit is closed, superseded, or explicitly accepted with written rationale.
2. The repo validation baseline is green:
   - `npm run lint`
   - `npm test`
   - `cd worker && npx tsc --noEmit`
   - `npm run build`
3. Guardrail scripts and docs sync checks pass.
4. The status, FX/depeg, feedback, and admin proxy regressions have direct tests.
5. The largest frontend status surfaces have direct component tests.
6. Route metadata and release behavior are easier to reason about than the current baseline, not just redistributed.
7. The final docs set reflects the runtime structure and deployment process that actually shipped.

## Suggested Closeout Checklist

- Re-run the full validation set on a clean branch.
- Re-run `madge` and capture before/after cycle counts.
- Re-run the Pages and worker smoke tests in CI.
- Compare the final docs against the shipped runtime/workflow structure.
- Add a short remediation summary back to the original audit file or PR description for traceability.
