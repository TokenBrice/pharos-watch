# Phase 1-3 Audit Remediation Implementation Plan

Date: 2026-04-20

Source audit: `agents/audits/2026-04-20-multi-agent-codebase-audit.md`

Scope: implement the audit roadmap's Phase 1, Phase 2, and Phase 3 items. Strategic Phase 4 work (`S-01`, full hotspot decomposition, and broad response-body/abort guardrails) is intentionally excluded except where this plan creates prerequisites.

## Assumptions

- Remediation lands as multiple small PRs, not one broad refactor.
- Worker/API behavior changes preserve or explicitly update the documented contract in `docs/api-reference.md`.
- No D1 migration is expected for these phases.
- `/docs/` and `README.md` are updated when behavior, API contract, scripts, deployment, or operational procedure changes.
- Methodology pages are touched only for UI duplication cleanup; no methodology version bump is required unless visible methodology content changes.
- Remote-D1 repair scripts must default to dry-run behavior before Phase 3 is complete.
- Because `S-01` deploy-concurrency redesign remains Phase 4, these Phase 1-3 PRs must be merged serially at the repository level: while any production workflow run is active after a `main` push, manual dispatch, or scheduled Pages rebuild, do not push or merge anything else to `main`, including docs-only, agents-only, or manual production-dispatch changes. After each production run starts, wait for the workflow, post-deploy smoke, and rollback gate to finish before the next `main` push or manual production dispatch.

## Success Criteria

- Every Phase 1-3 roadmap item is implemented or explicitly deferred in `agents/tasks/` with rationale, owner, and validation target.
- Protected public API dependency failures return JSON/CORS-shaped 503 responses instead of uncaught exceptions.
- Cache handlers reject malformed cached payloads consistently.
- Known non-OK passthrough response bodies from `fetchWithRetry()` callers are consumed/canceled.
- Root remote-D1 repair scripts require explicit `--apply` and are covered by SQL-safety scanning.
- Cron jobs either honor abort signals or carry an explicit waiver with bounded-runtime proof.
- The canonical validation set passes:
  - `npm run validate:prebuild`
  - `npm test`
  - `npm run coverage:critical`
  - `cd worker && npx tsc --noEmit`
  - `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
  - `npm run build` and `npm run seo:check` for Pages-impacting PRs
  - `npm run test:merge-gate` on the merged worktree

## Workstream Order

1. **Protected public API contract first:** `Q-01`, `R-07`.
2. **Cache/parser and endpoint quick wins:** `Q-02`, `Q-05`, `Q-08`, `Q-10`, `Q-11`.
3. **Response/edge-cache discipline:** `Q-03`, `S-03`.
4. **Docs and UI dedupe:** `R-05`, `S-06`, `R-09`, `R-10`.
5. **Shared-contract cleanup:** `R-03`, `R-06`, `Q-09`, `R-04`.
6. **Operational hardening:** `Q-04`, `S-04`, `S-02`, `Q-07`/`S-08`, `R-01`, `R-02`, `S-07`.

This sequence is risk-first rather than phase-number-first: the highest-priority production API contract fix lands before lower-risk quick wins.

## Phase And PR Map

| PR | Phase | Findings | Purpose |
| --- | --- | --- | --- |
| 1 | Phase 2, priority-first | `Q-01`, `R-07` | Protected public API failure containment and shared API-key policy |
| 2 | Phase 1 | `Q-02`, `Q-05` | Cache/parser correctness |
| 3 | Phase 2 | `Q-03`, `S-03` | Response-body and edge-cache discipline |
| 4 | Phase 1 | `Q-08`, `Q-10`, `Q-11` | Small public endpoint/client cleanup |
| 5 | Phase 1 | `R-05`, `S-06` | Docs helper and module-state docs cleanup |
| 6 | Phase 1 | `R-09`, `R-10` | Small UI dedupe |
| 7 | Phase 2 | `R-03`, `R-06`, `Q-09` | DEX/cemetery/OG shared-contract cleanup |
| 8 | Phase 2 | `R-04` | Blacklist processing dedupe |
| 9 | Phase 3 | `Q-04`, `S-04`, `R-08` | Remote-D1 repair script hardening |
| 10 | Phase 3 | `S-02` | Cron abort propagation contract |
| 11 | Phase 3 | `R-01` | Taxonomy hub dedupe |
| 12 | Phase 3 | `R-02` | Report-card raw-input factory |
| 13 | Phase 3 | `Q-07`, `S-08` | Targeted coverage and branch-ratchet follow-through |
| 14 | Phase 3 | `S-07` | Dependency upgrade planning lane |

## PR Slices

### PR 1 - Protected Public API Failure Containment

Phase: Phase 2, pulled first due operational priority.

Findings: `Q-01`, `R-07`.

Files:
- `shared/lib/ops-limits.ts` or new `shared/lib/api-key-policy.ts`
- `worker/src/lib/api-key-core.ts`
- `worker/src/lib/api-key-auth.ts`
- `worker/src/lib/api-key-rate-limit.ts`
- `worker/src/handlers/http/gates.ts`
- `worker/src/handlers/http/request-dispatch.ts` only if gate-level containment is insufficient
- `src/components/status/api-keys-panel.tsx`
- `worker/src/api/__tests__/api-keys.test.ts`
- `worker/src/lib/__tests__/api-keys.test.ts`
- `worker/src/__tests__/index.fetch.test.ts` or new `worker/src/handlers/http/__tests__/gates.test.ts`
- `src/components/status/__tests__/api-keys-panel.test.tsx`
- `docs/api-reference.md`
- `docs/worker-and-api-limits.md`

Implementation:
- Move API-key min/max/default/expiry constants into a shared runtime-neutral module.
- Import those constants from Worker validation and admin UI validation.
- Contain D1 failures from API-key lookup, per-key rate-limit writes, previous-pepper hash migration updates, and usage updates.
- Auth and limiter dependency failures return JSON/CORS-shaped `503` with `Retry-After: 60`.
- Usage-update failures are best-effort and must not fail otherwise successful protected reads.
- Preserve `401` for normal missing/invalid keys and `429` for legitimate quota exhaustion.
- Update API docs to describe API-key dependency failures distinctly from the public-IP limiter's 3-strike emergency posture.
- Update Worker/API limits docs to point API-key policy constants at the new shared source.

Acceptance criteria:
- D1 throw during API-key lookup returns 503, not an uncaught exception.
- D1 throw during API-key rate-limit write returns 503, not an uncaught exception.
- D1 throw during previous-pepper migration update returns 503 or a contained unavailable result, not an uncaught exception.
- D1 throw during usage update still allows the protected route response and records/logs best-effort failure.
- Admin UI min/max validation reads the same constants as Worker logic.
- Docs no longer imply API-key limiter dependency failures use only the public-IP limiter emergency-state model.

Validation:
- `npm test -- worker/src/api/__tests__/api-keys.test.ts worker/src/lib/__tests__/api-keys.test.ts worker/src/__tests__/index.fetch.test.ts src/components/status/__tests__/api-keys-panel.test.tsx`
- `npm run test:critical-contracts`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

Docs:
- Required: `docs/api-reference.md` and `docs/worker-and-api-limits.md`.

### PR 2 - Cache And Parser Correctness Quick Wins

Phase: Phase 1.

Findings: `Q-02`, `Q-05`.

Files:
- `worker/src/api/cache-handlers.ts`
- `worker/src/api/__tests__/yield-rankings.test.ts`
- `worker/src/api/dex-liquidity-response.ts`
- `worker/src/api/__tests__/dex-liquidity-response.test.ts`
- `docs/api-reference.md`

Implementation:
- In `handleYieldRankings()`, return 503 when `YieldRankingsResponseSchema` validation fails after JSON parsing.
- Preserve live safety hydration behavior for valid cache payloads.
- In `normalizeTopPools()`, parse as `unknown`, return `[]` for non-arrays, and skip non-object array entries.
- Keep allowed-key filtering and source normalization unchanged for valid entries.
- Update API docs for the behavior change from parseable-but-schema-invalid 200 to cache-passthrough 503.

Acceptance criteria:
- Schema-invalid `yield-rankings` cache returns `{ "error": ... }` with HTTP 503.
- Malformed JSON still returns the existing 503 path.
- `normalizeTopPools("{}")`, `normalizeTopPools("null")`, `normalizeTopPools("[null,1]")`, and invalid `extra` shapes do not throw.
- `docs/api-reference.md` matches the new invalid-cache behavior.

Validation:
- `npm test -- worker/src/api/__tests__/yield-rankings.test.ts worker/src/api/__tests__/dex-liquidity-response.test.ts`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run lint`
- `cd worker && npx tsc --noEmit`

Docs:
- Required: `docs/api-reference.md`.

### PR 3 - Response-Body And Edge-Cache Discipline

Phase: Phase 2.

Findings: `Q-03`, `S-03`.

Files:
- `worker/src/lib/fetch-retry.ts`
- `worker/src/cron/sync-bluechip.ts`
- `worker/src/lib/fx-realtime.ts`
- `worker/src/api/backfill-fx.ts`
- `worker/src/handlers/http/edge-cache.ts`
- `docs/worker-infrastructure.md`
- `worker/src/cron/__tests__/sync-bluechip.test.ts`
- `worker/src/lib/__tests__/fx-realtime.test.ts`
- new `worker/src/api/__tests__/backfill-fx.test.ts`
- new `worker/src/handlers/http/__tests__/edge-cache.test.ts`

Implementation:
- Ensure known passthrough non-OK responses returned by `fetchWithRetry()` are drained/canceled before callers return.
- Drain/cancel non-OK responses in `syncBluechip()`, `fetchRealtimeFxRates()`, and `backfill-fx` paths using `passthrough404`.
- In edge-cache writes, skip `Cache-Control` values containing `no-store`, `no-cache`, or `private`.
- Wrap `caches.default.put()` in a caught promise passed to `waitUntil()`.

Acceptance criteria:
- Bluechip 404/non-OK path drains body before returning null.
- Realtime FX non-OK path drains body before returning.
- Backfill-FX passthrough 404/non-OK path drains body before returning or overwriting the response.
- `writeEdgeCache()` does not call `cache.put()` for 200/no-store, 200/no-cache, or 200/private responses.
- Successful cacheable 200 responses still write through the edge cache.

Validation:
- `npm test -- worker/src/cron/__tests__/sync-bluechip.test.ts worker/src/lib/__tests__/fx-realtime.test.ts worker/src/api/__tests__/backfill-fx.test.ts worker/src/handlers/http/__tests__/edge-cache.test.ts`
- `npm run check:cron-connections`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run lint`
- `cd worker && npx tsc --noEmit`

Docs:
- Required: `docs/worker-infrastructure.md` because the Worker cache flow documents the edge-cache store step.

### PR 4 - Low-Risk Public Endpoint And Client Cleanup

Phase: Phase 1.

Findings: `Q-08`, `Q-10`, `Q-11`.

Files:
- `worker/src/api/telegram-webhook.ts`
- `worker/src/api/feedback/types.ts`
- `worker/src/api/__tests__/telegram-webhook-auth.test.ts`
- `worker/src/api/__tests__/telegram-webhook.test.ts`
- `worker/src/api/__tests__/feedback.test.ts`
- `src/hooks/use-compare-share-actions.ts`
- new `src/hooks/__tests__/use-compare-share-actions.test.tsx`
- `docs/api-reference.md`
- `docs/feedback-pipeline.md`

Implementation:
- Return `ok()` before calling `timingSafeCompare()` when the Telegram secret header is blank.
- Keep invalid non-blank secrets on the existing timing-safe path.
- Tighten feedback `pageUrl` validation so protocol-relative strings like `//example.com` are rejected.
- Add a toast reset timer ref and unmount cleanup in `useCompareShareActions()`, matching `ShareButton`.

Acceptance criteria:
- Missing Telegram secret does not emit the timing-safe compare empty-string error.
- Current/previous Telegram secrets still authenticate.
- Feedback accepts internal paths such as `/stablecoin/usdc-circle/` and rejects `//example.com`.
- Compare share timers are cleared on unmount and before replacement.

Validation:
- `npm test -- worker/src/api/__tests__/telegram-webhook-auth.test.ts worker/src/api/__tests__/telegram-webhook.test.ts worker/src/api/__tests__/feedback.test.ts src/hooks/__tests__/use-compare-share-actions.test.tsx`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

Docs:
- Required: `docs/api-reference.md` and `docs/feedback-pipeline.md` because `pageUrl` validation tightens from "starts with /" to single-slash internal paths.

### PR 5 - Script And Documentation Helper Quick Wins

Phase: Phase 1.

Findings: `R-05`, `S-06`.

Files:
- `scripts/check-doc-source-paths.mjs`
- `scripts/check-verified-doc-links.mjs`
- new `scripts/lib/doc-files.mjs`
- `docs/worker-infrastructure.md`

Implementation:
- Extract shared markdown file collection and line splitting helpers.
- Keep both docs checks' observable output unchanged.
- Update module-level state docs to inventory:
  - `shared/lib/cloudflare-access-jwt.ts` JWKS cache
  - `worker/src/lib/rate-limit.ts` isolate-local limiter/prune state
  - `worker/src/lib/api-key-core.ts` API-key cache and usage/prune state
  - `functions/lib/request-attribution.ts` Pages attribution prune state
  - `worker/src/lib/isolate-local-state.ts` semantics

Acceptance criteria:
- Both docs checks pass with unchanged semantics.
- Worker infrastructure docs no longer claim JWKS is the only module-level mutable state.

Validation:
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`
- `npm run lint`

Docs:
- Required: `docs/worker-infrastructure.md`.

### PR 6 - Small UI Dedupe

Phase: Phase 1.

Findings: `R-09`, `R-10`.

Files:
- `src/components/site-header.tsx`
- `src/app/safety-scores/client.tsx`
- `src/components/__tests__/site-header.test.tsx`
- `src/app/safety-scores/client.test.tsx`

Implementation:
- Extract repeated site-header metric pills into a local helper.
- Extract repeated `LazyCard` + `ReportCardMini` rendering in the safety scores client into a local component or render helper.
- Do not change copy, classes, layout breakpoints, or animation indexes.

Acceptance criteria:
- Rendered DOM and visual behavior are equivalent.
- No change to safety-score filtering or simulation behavior.

Validation:
- `npm test -- src/components/__tests__/site-header.test.tsx src/app/safety-scores/client.test.tsx`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run seo:check`

Docs:
- No docs update expected.

### PR 7 - DEX, Cemetery, And OG Shared Contract Cleanup

Phase: Phase 2.

Findings: `R-03`, `R-06`, `Q-09`.

Files:
- `worker/src/cron/dex-liquidity/orchestrator-drift.ts`
- `worker/src/cron/dex-liquidity/orchestrator-analysis.ts`
- `worker/src/cron/dex-liquidity/__tests__/orchestrator-analysis.test.ts`
- `src/lib/cemetery.ts`
- `scripts/generate-cemetery-dataset.ts`
- optional new shared cemetery utility
- `worker/src/lib/og-templates/stablecoin-card.tsx`
- `worker/src/api/__tests__/og.test.tsx`
- `shared/lib/classification.ts` only if missing an exported label variant

Implementation:
- Compose DEX post-score analysis metadata from `DexLiquidityDriftSummary` or exported subtypes.
- Share cemetery death-date parsing and sort comparators.
- Decide explicitly whether the dataset export should match UI major-collapse ordering; document that in helper naming.
- Replace local OG backing/governance label maps with shared classification labels.

Acceptance criteria:
- Type-only DEX metadata refactor has no JSON output change.
- Cemetery dataset check passes.
- OG label output remains intended short labels.

Validation:
- `npm test -- worker/src/cron/dex-liquidity/__tests__/orchestrator-analysis.test.ts worker/src/api/__tests__/og.test.tsx`
- `npm run check:cemetery-dataset`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm run build`
- `npm run seo:check`

Docs:
- No docs update expected unless exported cemetery ordering changes.

### PR 8 - Blacklist Processing Dedupe

Phase: Phase 2.

Findings: `R-04`.

Files:
- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/__tests__/sync-blacklist.test.ts`

Implementation:
- Extract blacklist processed-counter accumulation into a helper without changing chain-specific fetch logic.
- Keep Tron/EVM fetch, runtime-budget, block-advancement, and sync-state behavior unchanged.

Acceptance criteria:
- Blacklist sync counters remain identical in covered tests.
- Tron and EVM branches use the same accumulation helper.
- No changes to fetch, block advancement, or sync-state behavior.

Validation:
- `npm test -- worker/src/cron/__tests__/sync-blacklist.test.ts`
- `npm run lint`
- `cd worker && npx tsc --noEmit`

Docs:
- No docs update expected.

### PR 9 - Remote D1 Repair Script Hardening

Phase: Phase 3.

Findings: `Q-04`, `S-04`, related `R-08`.

Files:
- `scripts/check-sql-interpolation-safety.mjs`
- `scripts/__tests__/sql-interpolation-safety.test.ts`
- `scripts/lib/remote-d1.ts`
- new `scripts/__tests__/remote-d1.test.ts`
- `scripts/fix-non-usd-depeg-fx.ts`
- `scripts/fix-commodity-depeg-median.ts`
- `docs/scripts.md`
- new `agents/tasks/2026-04-20-depeg-repair-script-consolidation.md` if root repair script retirement/shared replay-helper consolidation is deferred

Implementation:
- Add root `scripts/` to SQL safety roots.
- Strengthen the SQL-safety scanner patterns so root repair-script value interpolation such as `peg_type = '${peg_type}'` and generated update/delete statements are detected unless values are bound, validated by an allowlist, or routed through a documented escape helper.
- Add scanner fixtures/tests that fail on unsafe root-script value interpolation and pass on allowlisted enum/numeric construction.
- Replace `execSync(string)` with `execFileSync("npx", ["wrangler", ...])`.
- Require `--apply` for mutating remote-D1 scripts; default to dry run.
- Keep `--dry-run` accepted as an alias/no-op for compatibility, but document `--apply` as the only live mode.
- Validate interpolated enum-like values before SQL construction or move dynamic values into allowlisted/escaped helpers.
- Update script usage docs.
- Either retire/consolidate the bootstrap repair scripts into shared replay/query helpers, or create `agents/tasks/2026-04-20-depeg-repair-script-consolidation.md` with the remaining `R-08` redundancy scope, owner, and validation target.

Acceptance criteria:
- Running scripts without `--apply` cannot mutate D1.
- SQL-safety checker scans root repair scripts and fails on representative unsafe value interpolation.
- Remote-D1 helper no longer invokes a shell command string.
- Docs accurately describe dry-run/apply posture.
- Remaining depeg repair script redundancy from `R-08` is either removed or explicitly deferred in `agents/tasks/`.

Validation:
- `npm test -- scripts/__tests__/sql-interpolation-safety.test.ts scripts/__tests__/remote-d1.test.ts`
- `npm run check:sql-safety`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run lint`
- `npm run typecheck`

Docs:
- Required: `docs/scripts.md`.

### PR 10 - Cron Abort Propagation

Phase: Phase 3.

Findings: `S-02`.

Files:
- `worker/src/lib/cron-logger.ts`
- `worker/src/lib/cron-lease.ts`
- `worker/src/lib/__tests__/log-cron-run.test.ts`
- `worker/src/lib/__tests__/cron-leases.test.ts`
- `worker/src/cron/compute-dews.ts`
- `worker/src/cron/snapshot-supply.ts`
- `worker/src/cron/snapshot-psi.ts`
- `worker/src/cron/prune-status-probe-runs.ts`
- `worker/src/cron/prune-cron-history.ts`
- `worker/src/handlers/scheduled/daily-0300.ts`
- `worker/src/__tests__/index.scheduled.test.ts`
- `worker/src/cron/__tests__/compute-dews.test.ts`
- `worker/src/cron/__tests__/snapshot-supply.test.ts`
- `worker/src/cron/__tests__/snapshot-psi.test.ts`
- `worker/src/cron/__tests__/prune-status-probe-runs.test.ts`
- `worker/src/cron/__tests__/prune-cron-history.test.ts`
- new `scripts/check-cron-abort-contract.mjs`
- new `scripts/lib/cron-abort-contract-waivers.json`
- `scripts/lib/deploy-impact.mjs`
- `scripts/__tests__/classify-deploy-changes.test.ts`
- `package.json`
- `scripts/lib/validate-contract.mjs`
- `docs/scripts.md`
- `docs/testing.md`

Implementation:
- Add explicit abort checks to DB-only jobs currently accepting `_signal`.
- Pass `signal` through daily 03:00 scheduled slot prune jobs.
- Add tests proving aborted signals stop these jobs before mutation-heavy phases.
- Add a mandatory guardrail that fails on leased cron entrypoints dropping/renaming the signal as `_signal` unless the exact file/function is listed in `cron-abort-contract-waivers.json`.
- Waivers must include reason, bounded runtime expectation, and a test proving either settle-before-release semantics or phase-level timeout behavior.
- Keep current lease-release semantics only if the guardrail and tests prove no leased job can continue unbounded after timeout. If a necessary waiver cannot prove that, update `runCronWithLease()` to wait for settlement or add phase-level timeout before releasing the lease.

Acceptance criteria:
- No leased cron entrypoint drops the abort signal without explicit waiver.
- The new cron abort contract guard is part of `validate:prebuild`.
- New cron abort guardrail changes are deploy-impacting in `scripts/lib/deploy-impact.mjs`, with classifier test coverage.
- DEWS and PSI snapshot check abort before meaningful D1 work and between major D1 phases.
- Snapshot-supply checks abort before meaningful D1 work and between major D1 phases, or carries an explicit waiver with bounded-runtime proof.
- Daily 03:00 prune jobs receive and honor the abort signal.
- Any waiver has an explicit test and bounded runtime rationale.

Validation:
- `npm test -- worker/src/__tests__/index.scheduled.test.ts worker/src/lib/__tests__/log-cron-run.test.ts worker/src/lib/__tests__/cron-leases.test.ts worker/src/cron/__tests__/compute-dews.test.ts worker/src/cron/__tests__/snapshot-supply.test.ts worker/src/cron/__tests__/snapshot-psi.test.ts worker/src/cron/__tests__/prune-status-probe-runs.test.ts worker/src/cron/__tests__/prune-cron-history.test.ts scripts/__tests__/classify-deploy-changes.test.ts`
- `node scripts/check-cron-abort-contract.mjs`
- `npm run validate:prebuild`
- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm run check:hotspot-ratchet`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run lint`
- `cd worker && npx tsc --noEmit`

Docs:
- Required: `docs/scripts.md` and `docs/testing.md`.
- Update `docs/worker-and-api-limits.md` if cron cancellation policy or budgets are materially clarified.

### PR 11 - Taxonomy Hub Dedupe

Phase: Phase 3.

Findings: `R-01`.

Files:
- `src/app/stablecoins/backing/page.tsx`
- `src/app/stablecoins/governance/page.tsx`
- `src/app/stablecoins/infrastructure/page.tsx`
- existing taxonomy components under `src/components/stablecoin-taxonomy-*.tsx`
- new `src/app/stablecoins/__tests__/taxonomy-hub-pages.test.tsx`

Implementation:
- Introduce a shared taxonomy hub component, reusing existing taxonomy shell/page patterns where practical.
- Keep route metadata exports local.
- Preserve JSON-LD `CollectionPage` and `ItemList` structures.
- Preserve card copy, links, classes, and active counts.

Acceptance criteria:
- Backing, governance, and infrastructure hub pages render the same links and JSON-LD item lists.
- Route metadata remains unchanged.
- Child taxonomy pages are unchanged.

Validation:
- `npm test -- src/app/stablecoins/__tests__/taxonomy-hub-pages.test.tsx`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run seo:check`

Docs:
- No docs update expected unless visible route behavior changes.

### PR 12 - Report-Card Raw Input Factory

Phase: Phase 3.

Findings: `R-02`.

Files:
- `worker/src/lib/report-cards-snapshot-finalize.ts`
- `src/app/portfolio/client.tsx`
- `src/components/__tests__/report-card.test.tsx`
- `src/hooks/__tests__/use-stress-test.test.ts`
- `src/hooks/__tests__/use-portfolio.test.ts`
- new shared raw-input helper
- `src/lib/__tests__/report-cards.test.ts` or new helper test

Implementation:
- Add a default `ReportCard["rawInputs"]` factory with typed overrides.
- Use it in defunct report-card finalization, portfolio pseudo-card creation, and repeated fixtures.
- Keep production values identical to current explicit objects.

Acceptance criteria:
- Report-card raw input defaults are centralized and type-checked.
- Defunct cards, portfolio pseudo-card, and tests preserve existing expected values.

Validation:
- `npm test -- src/components/__tests__/report-card.test.tsx src/hooks/__tests__/use-stress-test.test.ts src/hooks/__tests__/use-portfolio.test.ts src/lib/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

Docs:
- No docs update expected.

### PR 13 - Targeted Coverage And Branch-Ratchet Follow-Through

Phase: Phase 3.

Findings: `Q-07`, `S-08`.

Files:
- `worker/src/cron/dex-liquidity/subgraph-source-families.ts`
- `worker/src/cron/dex-liquidity/crawl-helpers.ts`
- `worker/src/cron/dex-liquidity/subgraph-helpers.ts`
- `worker/src/api/og.tsx`
- `src/components/dews-summary.tsx`
- `src/components/dews-detail.tsx`
- `worker/src/cron/blacklist/amount-recovery.ts`
- new or updated branch coverage ratchet files:
  - `scripts/check-branch-coverage-ratchet.mjs`
  - `scripts/lib/branch-coverage-ratchet-baseline.json`
  - `package.json`
  - `scripts/lib/deploy-impact.mjs`
  - `scripts/lib/validate-contract.mjs`
  - `scripts/test-merge-gate.mjs`
  - `scripts/__tests__/classify-deploy-changes.test.ts`
  - `scripts/__tests__/test-merge-gate.test.ts`
  - `scripts/__tests__/validate-ci-parity.test.ts`
  - `.github/workflows/validate-ci.yml`
  - `docs/scripts.md`
  - `docs/testing.md`
- new `worker/src/cron/dex-liquidity/__tests__/subgraph-source-families.test.ts`
- new `worker/src/cron/dex-liquidity/__tests__/crawl-helpers.test.ts`
- new `worker/src/cron/dex-liquidity/__tests__/subgraph-helpers.test.ts`
- `worker/src/api/__tests__/og.test.tsx`
- `src/components/__tests__/dews-summary.test.ts`
- `src/components/__tests__/dews-detail.test.tsx`
- new `worker/src/cron/blacklist/__tests__/amount-recovery.test.ts`
- `agents/tasks/2026-04-20-branch-coverage-ratchet.md` only if enforcement is explicitly deferred

Implementation:
- Add characterization tests before structural changes.
- Prioritize malformed provider payloads, empty states, missing optional fields, fallback labels, and no-throw behavior.
- Avoid snapshot-only tests where semantic assertions are possible.
- Capture coverage before/after in PR notes.
- Add `coverage:branch-ratchet` for Worker API/cache parsing and cron provider helper directories, backed by a checked-in baseline.
- The branch-ratchet command must generate a fresh coverage artifact itself, for example by composing `vitest run --coverage ...` with `node scripts/check-branch-coverage-ratchet.mjs`; it must not read stale coverage produced by a previous command.
- Do not wire this coverage-dependent command into `validate:prebuild`, which runs before coverage in CI.
- Wire `npm run coverage:branch-ratchet` after `coverage:critical` in `.github/workflows/validate-ci.yml`.
- Wire the same command into local merge-gate after coverage generation through `scripts/lib/validate-contract.mjs` / `scripts/test-merge-gate.mjs`, and update parity tests.
- Add deploy-impact classification and classifier tests for the new root guardrail script so future edits are deploy-impacting.
- If enforcement is deferred, create `agents/tasks/2026-04-20-branch-coverage-ratchet.md` with target directories, baseline values, owner, and the exact blocker preventing CI enforcement.

Acceptance criteria:
- Zero-coverage DEX subgraph modules have direct tests.
- OG route failure/fallback paths have at least one focused test.
- DEWS UI low-data and populated states are covered.
- Blacklist amount recovery has tests for non-OK fetch/body cleanup and recoverable missing amount cases.
- `S-08` branch-ratchet follow-through is either implemented with fresh-coverage generation and post-coverage CI/local merge-gate wiring, or explicitly deferred with a task artifact and baseline target.

Validation:
- `npm test -- worker/src/cron/dex-liquidity/__tests__/subgraph-source-families.test.ts worker/src/cron/dex-liquidity/__tests__/crawl-helpers.test.ts worker/src/cron/dex-liquidity/__tests__/subgraph-helpers.test.ts worker/src/api/__tests__/og.test.tsx src/components/__tests__/dews-summary.test.ts src/components/__tests__/dews-detail.test.tsx worker/src/cron/blacklist/__tests__/amount-recovery.test.ts`
- `npm run test:coverage`
- `npm run coverage:critical`
- `npm run coverage:branch-ratchet` if enforcement is implemented
- `npm test -- scripts/__tests__/classify-deploy-changes.test.ts scripts/__tests__/test-merge-gate.test.ts scripts/__tests__/validate-ci-parity.test.ts` if enforcement is implemented
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

Docs:
- Required: `docs/scripts.md` and `docs/testing.md` if enforcement is implemented.
- Internal `agents/tasks/` update required if branch-ratchet enforcement is deferred.

### PR 14 - Dependency Upgrade Planning Lane

Phase: Phase 3.

Findings: `S-07`.

Files:
- new `agents/tasks/2026-04-20-typescript-eslint-major-upgrade.md`
- optional `agents/tasks/2026-04-20-runtime-patch-dependency-updates.md`

Implementation:
- Create a task note for TypeScript 6 and ESLint 10 migration risks, expected validation commands, and rollback plan.
- Separate patch-level runtime dependency updates from major toolchain upgrades.
- Do not update packages in this PR unless intentionally scoped.

Acceptance criteria:
- Dependency major upgrade work is tracked with scope, validation, and owner expectations.
- No code/package churn unless explicitly chosen.

Validation:
- `npm audit --json`
- `npm outdated --json || true` with output reviewed

Docs:
- Internal `agents/tasks/` only.

## Phase Completion Gates

### Phase 1 Complete When

- PRs 2, 4, 5, and 6 are merged.
- Required docs from PRs 2, 4, and 5 are updated and doc checks pass.
- `npm run test:merge-gate` passes on the merged worktree.

### Phase 2 Complete When

- PRs 1, 3, 7, and 8 are merged.
- API-key protected route dependency-failure tests exist and pass.
- Response-body cleanup and edge-cache no-store tests exist and pass.
- Shared constants/types have replaced the highest-risk policy/DTO duplication.
- `npm run test:merge-gate` passes on the merged worktree.

### Phase 3 Complete When

- PRs 9-14 are merged or explicit deferrals are written under `agents/tasks/`.
- Root remote-D1 scripts are dry-run by default and covered by SQL-safety scanning.
- Cron abort propagation is enforced by guardrail or explicitly waived with tests and bounded-runtime rationale.
- Targeted coverage has been added for the named blind spots.
- Branch-ratchet follow-through is implemented or explicitly deferred with a baseline task.
- Dependency major-upgrade lane is tracked.
- `npm run test:merge-gate` passes on the merged worktree.

## Rollback And Risk Controls

- Keep each PR independently revertible.
- Avoid mixing Worker runtime changes with frontend-only dedupe except where a shared contract requires it.
- For Worker/API changes, add targeted tests first, then implementation, then `test:critical-contracts` or the relevant targeted suite.
- For root repair scripts, do not run live scripts during implementation; test command construction and dry-run behavior only.
- For cron changes, avoid changing schedule metadata or lease budgets unless separately planned and documented.
- For UI dedupe, compare rendered output through exact component/route tests; use Playwright only if visual layout changes are suspected.

## Validation Loop Record

Validator threshold: final plan must have no critical or major issues and fewer than 3 minor issues.

### Iteration 0 - Draft

Status: reviewed by three `gpt-5.4` / `xhigh` validators.

Summary:
- Critical: 0
- Major: phase coupling, validation parity, delayed `Q-01`, optional cron guardrail, missing API docs, incomplete passthrough response scope, missing pepper-migration acceptance.
- Minor: imprecise test commands, missing prune tests, missing branch-ratchet follow-through, `npm outdated` non-zero behavior.

Resolution in Iteration 1:
- Moved `Q-01`/`R-07` to PR 1.
- Split Phase 2 blacklist cleanup from Phase 3 taxonomy/report-card dedupe.
- Made API and worker-limit docs explicit for PRs 1 and 2.
- Added pepper migration failure acceptance.
- Added `backfill-fx` to response-body scope.
- Made cron abort guardrail mandatory.
- Replaced placeholder validation with exact commands or named new test files.
- Added branch-ratchet implementation/deferral requirement.
- Switched dependency validation to `npm outdated --json || true` with reviewed output.

### Iteration 1 - Revised Draft

Status: reviewed by three `gpt-5.4` / `xhigh` validators.

Summary:
- Critical: 0
- Major: missing `snapshot-supply` in cron abort scope, incomplete new guardrail deploy-impact/docs wiring, PR4 feedback contract docs/typecheck, SQL-safety scanner pattern too narrow for root repair value interpolation, rollout control needed while `S-01` remains out of scope.
- Minor: branch-ratchet command/docs specificity, cron guardrail docs specificity.

Resolution in Iteration 2:
- Added serial production rollout control while `S-01` remains Phase 4.
- Added `docs/api-reference.md`, `docs/feedback-pipeline.md`, doc checks, and Worker typecheck to PR 4.
- Required SQL-safety pattern/fixture updates for root repair value interpolation, not only scan-root expansion.
- Added `snapshot-supply` and its test to PR 10.
- Added deploy-impact classifier files/tests, `docs/scripts.md`, `docs/testing.md`, and `validate:prebuild` to PR 10.
- Made branch coverage ratchet command/package/docs wiring explicit in PR 13, with a named deferral task if enforcement is not landed.

### Iteration 2 - Revised Draft

Status: reviewed by three `gpt-5.4` / `xhigh` validators.

Summary:
- Critical: 0
- Major: rollout control still allowed docs/manual dispatch cancellation during active production runs; PR13 branch-ratchet deploy-impact/docs wiring; PR3 edge-cache doc update; PR4 feedback docs/typecheck and handler test; PR9 remaining `R-08` consolidation/deferral.
- Minor: branch-ratchet fresh coverage generation, Phase 1 doc gate wording.

Resolution in Iteration 3:
- Strengthened rollout control to block all `main` pushes and manual production dispatches while any production workflow run is active.
- Added `docs/worker-infrastructure.md` to PR3.
- Added `telegram-webhook.test.ts` to PR4 and made PR4 docs explicit in Phase 1 completion.
- Added PR9 `R-08` consolidation-or-deferral requirement.
- Added PR13 deploy-impact classifier, docs, and fresh-coverage `coverage:branch-ratchet` wiring instead of prebuild/stale coverage.

### Iteration 3 - Revised Draft

Status: reviewed by three `gpt-5.4` / `xhigh` validators.

Summary:
- Critical: 0
- Major: PR13 branch-ratchet enforcement still needed explicit CI/local merge-gate wiring.
- Minor: PR10 validation omitted direct cron lease tests.

Resolution in Iteration 4:
- Added `.github/workflows/validate-ci.yml`, `scripts/lib/validate-contract.mjs`, `scripts/test-merge-gate.mjs`, `scripts/__tests__/test-merge-gate.test.ts`, and `scripts/__tests__/validate-ci-parity.test.ts` to PR13 scope.
- Specified `coverage:branch-ratchet` runs after `coverage:critical` in CI and after coverage generation in local merge gate.
- Added `worker/src/lib/__tests__/cron-leases.test.ts` to PR10 validation.

### Iteration 4 - Revised Draft

Status: reviewed by three `gpt-5.4` / `xhigh` validators.

Summary:
- Critical: 0
- Major: 0
- Minor: 1 wording issue noting the rollout-control sentence should explicitly include scheduled Pages rebuilds.

Final edit:
- Updated the rollout-control assumption to cover `main` pushes, manual dispatches, and scheduled Pages rebuilds.
