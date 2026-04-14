# Module Complexity Simplification Targets

Date: 2026-04-14

Scope: read-only exploration across pricing pipeline, depeg/DEWS, liquidity, redemption backstop, reserve sync, yield, safety/report cards, PSI, mint/burn, and blacklist/freeze tracker.

## Assumptions

- This is an exploration pass, not remediation.
- "Worst offender" means code whose orchestration, branching, mutation, or view-model work is much larger than the output shape it ultimately produces.
- Provider/RPC/chain-specific complexity is not automatically a defect; the main target is accidental coordinator, policy, persistence, and presentation mixing.
- The current worktree already has uncommitted changes outside this audit artifact, including redemption backstop, report-card, coverage, and related test files. I treated those as current worktree context and did not edit or revert them.

## Method

- Read `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, and `docs/worker-and-api-limits.md`.
- Ran module-focused read-only subagents for pricing, depeg/DEWS, liquidity/redemption, reserves/yield, safety/PSI, mint-burn/blacklist.
- Ran local hotspot survey and `npm run check:hotspot-ratchet`; the ratchet passed.
- Reviewed recent checked-in audits where relevant, especially the 2026-04-07 simplification audit and recent module audits.

## Executive Read

The most important pattern is not "big adapters are big." It is that several coordinator modules do four jobs at once:

- source/provider fan-in
- policy decisions and trust/quality gates
- mutation or persistence
- API/UI response shaping

That creates large flows that are hard to mentally simulate even when the external product surface is straightforward. The biggest simplification wins should come from making these files thin coordinators with typed phase results, declarative policy tables, and pure view-model builders.

## Ranked Cross-Module Targets

| Rank | Area | Primary Files | Why It Stands Out | Simplification Direction | Risk / Verification |
| --- | --- | --- | --- | --- | --- |
| 1 | Pricing policy and post-enrichment | `worker/src/lib/price-validation.ts`, `worker/src/lib/price-publish-policy.ts`, `worker/src/cron/sync-stablecoins/pricing.ts`, `worker/src/cron/sync-stablecoins/post-enrichment.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | A yes/no price-accept decision is spread across context building, source fan-in, consensus, publish policy, replay/cached continuity, GT probe, protocol overrides, and repeated `PeggedAsset` mutations. | Collapse validation into a rule table keyed by peg class/mode; have provider adapters emit uniform `SourcePrice[]`; centralize price stamping/clearing in a finalizer; make each phase return explicit result objects. | High. Preserve FX/commodity/NAV cases, protocol overrides, GT probe, replay cache, and ordering. Run pricing validation/publish-policy tests plus `sync-stablecoins` integration tests. |
| 2 | Safety/report-card snapshot assembly | `worker/src/lib/report-cards-snapshot.ts`, `shared/lib/report-card-blacklist-risk.ts` | One snapshot path loads multiple data sources, handles partial failures, computes peg/liquidity/resilience/dependency state, resolves blacklist inheritance, topologically orders dependencies, materializes defunct cards, and sorts one JSON payload. | Split into `loadInputs`, `assembleCard`, and `finalizeSnapshot`; isolate defunct card materialization and dependency ordering; turn blacklist inference into a clearer declarative matcher plus a dedicated fixed-point resolver if needed. | Medium-high. Verify report-card API, topo ordering, blacklist classification, and grade payload shape. |
| 3 | DEX liquidity coordinator | `worker/src/cron/dex-liquidity/orchestrator.ts`, `worker/src/cron/dex-liquidity/process-pools.ts`, `worker/src/cron/dex-liquidity/scoring.ts`, `worker/src/lib/dex-api-common.ts`, `worker/src/api/dex-liquidity.ts` | The pipeline coordinates source loading, direct API fetches, subgraph enrichment, fallback crawlers, staged merges, scoring, post-score analysis, persistence, challenger publication, metadata, and API warning/trend projection. | Typed phase result objects; separate matching, enrichment, accumulation, pure scoring, DB writes, and API projection. Keep DEX identity rules but give them narrower modules. | High. Preserve abort/degraded semantics, Curve metapool handling, symbol/address fallbacks, caps, price inversion, and trend baselines. Use DEX cron/API/direct-source tests. |
| 4 | Depeg state machine and DEWS input hydration | `worker/src/cron/detect-depegs.ts`, `worker/src/cron/dews/source-state.ts`, `worker/src/cron/dews/scoring.ts`, `worker/src/lib/dews.ts`, `shared/lib/peg-score.ts` | Live depeg detection handles transitions, duplicate merge repair, DEX corroboration, native-quote suppression, pending routing, and cleanup in one loop. DEWS source loading repeats query/decode/coverage/degrade patterns before emitting a simple per-coin score. | Drive detection through explicit outcomes such as `suppress`, `open_live`, `open_pending`, `update_peak`, `close`; add generic `load/parse/log/coverage` helpers for DEWS sources; separate DEWS calibration tables from compute functions. | High. Verify depeg direction flips, pending promotion, native quote veto, malformed source rows, bootstrap behavior, and methodology output. |
| 5 | Live reserve registry and sync coordinator | `shared/lib/live-reserve-adapters.ts`, `worker/src/cron/reserve-adapters/helpers.ts`, `worker/src/cron/sync-live-reserves.ts`, `worker/src/cron/sync-live-reserves-core.ts`, `worker/src/lib/live-reserves-store-parsing.ts`, `worker/src/lib/live-reserves-store-view.ts` | Registry/schema/capability metadata live in one large shared file; helper code is a transport/protocol grab bag; sync lifecycle spans progress, shared-source caching, fallbacks, breakers, attempts, finalization, stale cleanup, history pruning, parsing, and view generation. | Split adapter definitions from schema/registry; split HTTP, EVM, Solana, and DefiLlama helpers; collapse attempt lifecycle into a smaller coordinator/store boundary; separate stored-row parsing from consumer view construction. | Medium-high to high. Verify adapter parsing, reserve sync integration, timeout/uncertain-write behavior, corrupt-row fallback, and freshness/scoring eligibility. |
| 6 | Mint/burn sync and read API | `worker/src/cron/sync-mint-burn.ts`, `worker/src/cron/mint-burn/sync-config.ts`, `worker/src/lib/mint-burn-contracts.ts`, `worker/src/api/mint-burn-flows.ts`, `worker/src/api/mint-burn-flows-shared.ts` | The cron rotates configs, lanes, budgets, state, price context, recalc hours, and metadata while per-config sync handles log fetch, timestamp resolution, parsing, bridge classification, persistence, and advancement. The API also mixes aggregate/per-coin modes, fallback cache, freshness, report-card classification, and response shaping. | Put config scan behind one result-producing interface; keep the cron as order/budget coordinator; split aggregate and per-coin API handlers; keep shared file focused on cache/freshness helpers. | High. Verify cursor advancement, rotation, budget pressure, hourly recalc, cache fallback, and public response shapes. |
| 7 | Blacklist amount recovery and cursor sync | `worker/src/cron/blacklist/amount-recovery.ts`, `worker/src/cron/blacklist/current-balance-cache.ts`, `worker/src/cron/sync-blacklist.ts`, `src/app/blacklist/page.tsx` | Amount recovery interleaves provider selection, Tron/EVM branching, destroy-log decoding, gold pricing, error classification, row mutation, and persistence. The top cron handles breakers, backfill ordering, chain scans, budget cutoffs, cursor advancement, progress, and status. | Add an amount resolver returning `{ amount, source, status, errorClass, provider }`; make backfill/cache layers persist resolver output; split sync into phases: backfill, EVM scan, Tron scan, cursor advance, metadata. Move page URL/search/analytics state into a hook. | Medium-high. Verify destroy events, historical balances, Tron unsupported states, cursor advancement, and query-param behavior. |
| 8 | Stability Index worker/API/UI | `worker/src/cron/stability-index.ts`, `worker/src/api/stability-index.ts`, `src/app/stability-index/client.tsx`, `src/app/stability-index/view-model.ts` | PSI cron does ETL, fallback policy, scoring, persistence, and retention in one function. The API adds current/history normalization, malformed JSON handling, synthetic today rows, freshness, methodology reconstruction, and detail branching. The client remains a large route composition surface. | Split cron into `collectInputs`, `resolveFallbacks`, `computeSample`, `persistSample/pruneSamples`; move API normalization into a shared PSI response builder; split major visual sections from the route client. | Medium-high. Verify degraded-mode behavior, replay fallback, `detail=true`, history deduping, synthetic today row, and UI band/event derivation. |
| 9 | Yield arbitration and optional sources | `worker/src/cron/yield-sync/evaluation.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/sources-optional-protocols.ts`, `worker/src/cron/yield-config.ts`, `src/components/yield-detail-section.tsx` | Yield evaluation carries history compatibility, candidate scoring, fallback buckets, benchmark/degrade logic, and publication prep. Optional sources and config are long because every provider has different shapes. The detail component packs URL state, source table, PYS breakdown, and ranking display. | Isolate history selection, candidate scoring, and winner arbitration into pure stages; keep provider-specific source code but extract shared fetch/normalize patterns when stable; split detail section into PYS/table/state components. | High for worker, low-medium for UI. Verify source switch counts, published rankings, stale/negative fallbacks, supplemental dedupe, and component selection state. |
| 10 | Redemption backstop builder and view | `worker/src/lib/redemption-backstop-sources.ts`, `worker/src/cron/sync-redemption-backstops.ts`, `src/components/stablecoin-detail/redemption-backstop-card.tsx`, `shared/lib/redemption-backstop-configs/offchain-issuer.ts` | The current worktree is actively changing this module. Builder code combines static scoring, capacity, route impairment, holder eligibility, notes, confidence, and effective exit. The UI component also owns copy/policy formatting. The large config file is mostly data, not a primary code debt target. | After current redemption work lands, introduce a `buildRedemptionBackstopViewModel(entry)` helper and consider separating static scoring, capacity resolution, and route availability application in the builder. | Medium. Verify card wording, capacity semantics, impaired route states, current worktree behavior, and redemption backstop sync tests. |

## Module-By-Module Notes

### Pricing Pipeline

Worst targets:

- `worker/src/lib/price-validation.ts`
- `worker/src/lib/price-publish-policy.ts`
- `worker/src/lib/price-consensus.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/cron/sync-stablecoins/post-enrichment.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`

The source adapters and provider fallbacks are not the best first target. The better target is the policy layer around price validation, publication, and repeated asset mutation.

### Depeg And DEWS

Worst targets:

- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/dews/source-state.ts`
- `worker/src/cron/dews/scoring.ts`
- `worker/src/lib/dews.ts`
- `shared/lib/peg-score.ts`

The backfill/replay surfaces are large, but much of that is justified by deterministic historical repair and dry-run diff requirements. Treat them as audit targets, not first simplification targets.

### Liquidity Pipeline And Scoring

Worst targets:

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-liquidity/process-pools.ts`
- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/lib/dex-api-common.ts`
- `worker/src/api/dex-liquidity.ts`

Do not remove the DEX-specific identity rules. The simplification is a file-boundary and phase-boundary cleanup, not a logic deletion.

### Redemption Backstop

Worst targets:

- `worker/src/lib/redemption-backstop-sources.ts`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx`
- second-pass only: `worker/src/lib/redemption-backstop-capacity.ts`

The active dirty worktree means this should not be remediated from this audit snapshot alone. Wait for the exercisability work to settle, then review the new final shape.

### Reserve Sync

Worst targets:

- `shared/lib/live-reserve-adapters.ts`
- `worker/src/cron/reserve-adapters/helpers.ts`
- `worker/src/cron/sync-live-reserves.ts`
- `worker/src/cron/sync-live-reserves-core.ts`
- `worker/src/lib/live-reserves-store-parsing.ts`
- `worker/src/lib/live-reserves-store-view.ts`

Provider-specific adapters are messy but mostly expected. The registry and coordinator plumbing is the better simplification lane.

### Yield Module

Worst targets:

- `worker/src/cron/yield-sync/evaluation.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/cron/yield-sync/sources-optional-protocols.ts`
- `worker/src/cron/yield-config.ts`
- `src/components/yield-detail-section.tsx`

The worker side needs behavior-preserving staging, not aggressive deletion. The frontend detail section is a lower-risk component extraction.

### Safety Score / Report Cards

Worst targets:

- `worker/src/lib/report-cards-snapshot.ts`
- `shared/lib/report-card-blacklist-risk.ts`
- `src/components/stablecoin-detail/safety-score-history-section.tsx`

The public report-card endpoint is already thin. The issue is the snapshot builder and inherited blacklist risk resolver.

### Stability Index

Worst targets:

- `worker/src/cron/stability-index.ts`
- `worker/src/api/stability-index.ts`
- `src/app/stability-index/client.tsx`
- `src/app/stability-index/view-model.ts`

The core scoring function in `worker/src/lib/stability-index.ts` is not the issue; the ETL/API/UI wrapping is.

### Mint/Burn Flows

Worst targets:

- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/cron/mint-burn/sync-config.ts`
- `worker/src/lib/mint-burn-contracts.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/mint-burn-flows-shared.ts`

The registry/config file is data-heavy. The best simplification is to narrow the cron/per-config/API boundaries.

### Blacklist / Freeze Tracker

Worst targets:

- `worker/src/cron/blacklist/amount-recovery.ts`
- `worker/src/cron/blacklist/current-balance-cache.ts`
- `worker/src/cron/sync-blacklist.ts`
- `src/app/blacklist/page.tsx`

Most complexity in `worker/src/lib/blacklist-contracts.ts` looks like registry plumbing and provider specificity, not a first-pass target.

## Defer Or Treat Carefully

- `worker/src/lib/authoritative-price-sources.ts`: complex because of archive RPC, fixed-point math, and historical redemption price behavior.
- `worker/src/cron/sync-stablecoins/enrich-prices-dexscreener-pass.ts`, `enrich-prices-jupiter-pass.ts`, and `worker/src/lib/geckoterminal-price-probe.ts`: long because provider batching/rate-limit/request-budget constraints are real.
- Depeg and DEWS backfill/admin repair endpoints: complex because replay/dry-run determinism matters.
- Large content-heavy methodology/about pages: high LOC but lower simplification leverage.
- Reserve provider-specific adapters: simplify shared helper boundaries before trying to flatten adapter-specific logic.

## Suggested Remediation Order

1. **Report cards snapshot split**: high simplification value with relatively contained API surface.
2. **Pricing validation/publication rule consolidation**: high value, but use a narrow test-first path because behavior is central.
3. **DEX liquidity coordinator phase results**: large structural payoff, preserve runtime/degraded semantics.
4. **DEWS source-state loader helper**: good medium-scope cleanup after depeg state-machine risks are better characterized.
5. **Reserve adapter registry split**: strong maintainability payoff if kept mechanical and test-backed.
6. **Mint/burn and blacklist resolver/coordinator splits**: valuable but cursor/ledger semantics make them later, test-heavy tranches.

## Verification Baseline

No production-code edits were made for this audit. Local command run:

```bash
npm run check:hotspot-ratchet
```

Result: passed.
