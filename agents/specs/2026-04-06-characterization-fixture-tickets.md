# Characterization Fixture Tickets

Date: 2026-04-06  
Companion to:

- `agents/plans/2026-04-06-phase1-3-implementation-plan.md`
- `agents/plans/2026-04-06-phase1-3-execution-control-board.md`

## Purpose

These tickets are pre-created characterization tasks for the highest-risk refactor slices. They should be completed on the refactor branch before major code movement, or landed as explicit prep PRs if the owning lane is otherwise clear.

The goal is to capture current behavior in executable fixtures so later refactors can prove semantic equivalence instead of relying on informal reasoning.

## Ticket `CHAR-B4-01` — API Key Subsystem Characterization

- Target slice: `B4`
- Lane: Auth/admin
- Objective:
  - Freeze current public/admin API-key behavior before splitting `worker/src/lib/api-keys.ts`.
- Primary files:
  - `worker/src/lib/api-keys.ts`
  - `worker/src/handlers/http/gates.ts`
  - `worker/src/api/__tests__/api-keys.test.ts`
  - `worker/src/__tests__/index.fetch.test.ts`
- Add or extend tests around:
  - valid key on a protected public route uses the per-key limiter path
  - invalid key on a protected public route follows the post-`A2` public-limiter behavior
  - inactive or expired key returns the current expected auth failure shape
  - admin create/update/deactivate/rotate flows preserve response shape and masked-token behavior
  - audit-log side effects and usage timestamps remain consistent where already observable
- Suggested test artifact:
  - add a focused characterization suite near existing auth tests rather than inventing a brand-new test harness
- Definition of done:
  - tests fail if auth routing, limiter routing, or admin response shapes change unexpectedly during the module split

## Ticket `CHAR-B6-01` — Yield Publisher Characterization

- Target slice: `B6`
- Lane: Yield
- Objective:
  - Freeze current `sync-yield-data` publication behavior before coordinator extraction.
- Primary files:
  - `worker/src/cron/sync-yield-data.ts`
  - `worker/src/cron/__tests__/sync-yield-data.test.ts`
  - `worker/src/cron/__tests__/yield-cache.test.ts`
- Add or extend tests around:
  - healthy publish path writes rankings cache with expected row count and provenance envelope
  - safety-degraded path still publishes fresh rankings when payload is valid but skips `report_card_cache`
  - schema-invalid or severe-shrink path does not overwrite the last good cache
  - supplemental cache stale/missing path degrades only as currently documented
  - deterministic cooldown behavior preserves current publication semantics
- Suggested fixture style:
  - snapshot normalized cache payload metadata, source-family counts, and write/no-write decisions rather than full noisy payload dumps
- Definition of done:
  - coordinator split can be validated against executable before/after outcomes for cache publication and degraded-mode behavior

## Ticket `CHAR-C2-01` — Stablecoin Sync Pipeline Characterization

- Target slice: `C2`
- Lane: Stablecoin sync
- Objective:
  - Freeze current `sync-stablecoins` orchestration behavior before phase-contract refactoring.
- Primary files:
  - `worker/src/cron/sync-stablecoins.ts`
  - `worker/src/cron/sync-stablecoins/stages.ts`
  - `worker/src/cron/sync-stablecoins/fallback.ts`
  - existing sync/depeg tests under `worker/src/cron/__tests__/`
- Add or extend tests around:
  - primary intake happy path publishes expected stablecoin payload and metadata
  - fallback path preserves current publish semantics when primary intake is unavailable
  - missing-price path and enrichment path keep current validation/failure behavior
  - depeg detection and pending-confirmation behavior remain unchanged
  - cache publication and downstream depeg pipeline ordering remain unchanged
- Suggested fixture style:
  - use representative mini-universe fixtures rather than full production-scale data
  - normalize timestamps and IDs where possible so the fixtures stay reviewable
- Definition of done:
  - the refactor can prove unchanged publish/depeg/fallback outcomes across representative pipeline states

## Ticket `CHAR-C3-01` — Price Enrichment Pass Characterization

- Target slice: `C3`
- Lane: Stablecoin sync
- Objective:
  - Freeze current enrichment-pass behavior before provider-family extraction.
- Primary files:
  - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`
  - pricing-related tests under `worker/src/cron/__tests__/`
- Add or extend tests around:
  - pass ordering and fallback precedence across representative missing-price scenarios
  - preservation of current validation semantics after enrichment
  - wrapper/NAV cases added by recent `main` commits, including USDAI/PYUSD wrapper behavior and NAV-wrapper peg-risk inheritance where enrichment interacts with the pricing path
  - representative direct-source success, source miss, and multi-pass recovery flows
- Suggested fixture style:
  - scenario fixtures keyed by asset type and expected resolved price path rather than one giant end-to-end blob
- Definition of done:
  - provider-family extraction can prove unchanged resolved-price outcomes and unchanged pass-order semantics on the current HEAD behavior set

## Ticket `CHAR-C4-01` — Yield Resolver Family Characterization

- Target slice: `C4`
- Lane: Yield
- Objective:
  - Freeze current yield source-selection and degraded-mode behavior before splitting resolver families.
- Primary files:
  - `worker/src/cron/yield-sync/resolve.ts`
  - `worker/src/cron/__tests__/yield-resolve.test.ts`
  - `worker/src/cron/__tests__/sync-yield-data.test.ts`
- Add or extend tests around:
  - deterministic on-chain path selection
  - explicit protocol source selection
  - optional timed-provider fallback behavior
  - auto-discovery selection and arbitration behavior
  - degraded/no-publish vs degraded/publish outcomes where those are currently distinct
- Suggested fixture style:
  - scenario table keyed by source family, expected selected source, and expected degraded flags
- Definition of done:
  - resolver-family extraction can be validated against stable source-selection outcomes, not just type-checking and broad cron tests

## Ticket `CHAR-C5-01` — DEWS Staged Decomposition Characterization

- Target slice: `C5`
- Lane: DEWS
- Objective:
  - Freeze current DEWS assembly and scoring behavior, including the `A3` baseline fix, before staged decomposition.
- Primary files:
  - `worker/src/cron/compute-dews.ts`
  - `worker/src/lib/dews.ts`
  - `worker/src/lib/__tests__/dews.test.ts`
  - `worker/src/cron/__tests__/compute-dews.test.ts`
- Add or extend tests around:
  - representative multi-signal score with stable expected component outputs
  - insufficient-signal path returns `null` as currently documented
  - zero-24h / valid-baseline mint-burn case keeps the restored baseline behavior from `A3`
  - stale core-input behavior preserves current no-write or degraded behavior
  - persistence-stage writes preserve current methodology attribution and result shape
- Suggested fixture style:
  - use normalized per-coin input/output fixtures so the staged refactor can compare assembly outputs separately from scoring outputs
- Definition of done:
  - the staged refactor can prove equivalence at both the assembled-input layer and the final computed-result layer

## Ticket Execution Rules

1. Characterization tickets belong to the same lane as the owning slice.
2. If the lane is busy, the ticket work stays on the owning slice branch rather than becoming a separate overlapping branch.
3. If the lane is clear and the team wants smaller PRs, the ticket may be landed as a prep PR immediately before the owning slice.
4. A large refactor slice should not start code movement until its characterization ticket is complete or explicitly waived with rationale.
