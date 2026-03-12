# DEX Shadow Pipeline Removal Plan

**Goal:** Remove the DEX-only legacy-vs-new validator shadow telemetry now that the shared validator has been authoritative in production long enough to prove equivalence for the DEX paths.

**Architecture:** Keep `validatePriceCandidate()` as the only DEX observation gate. Delete the old-vs-new comparison bookkeeping from `worker/src/cron/dex-liquidity/price-sanity.ts`, stop emitting `priceValidationShadow` from the DEX cron metadata, and leave `/status` focused on operator-relevant DEX health metrics (`sourceCoverage`, staged-pool counters, failures, budget state).

**Tech Stack:** TypeScript strict, Cloudflare Workers, D1, Vitest, Next.js status dashboard

---

## Scope

**In scope**

- Remove DEX shadow comparison state and helpers from the DEX price-sanity module
- Stop emitting `priceValidationShadow` from:
  - `sync-dex-liquidity`
  - `sync-dex-discovery`
- Update tests and docs to match the slimmer metadata contract
- Verify `/status` still renders useful DEX telemetry after the metadata field disappears

**Explicitly out of scope**

- Do **not** remove or alter the separate `sync-stablecoins` shadow systems:
  - `metadata.priceValidationShadow`
  - `shadowComparison`
- Do **not** change DEX scoring, discovery cadence, or validator acceptance behavior
- Do **not** redesign the `/status` page beyond what is needed for the metadata removal
- Do **not** broaden this into generic telemetry cleanup unless a concrete unused field is already in the touched code path

---

## Readiness Baseline

Production baseline captured on **2026-03-12** from `GET /api/status`:

- `sync-dex-liquidity` recent runs were healthy and showed:
  - `priceValidationShadow.deltaAccepted = 0`
  - empty `sampleRejectedByNew`
  - no failed sources
- `sync-dex-discovery` recent runs also showed:
  - `priceValidationShadow.deltaAccepted = 0`
  - empty `sampleRejectedByNew`
- The new validator is already authoritative in code; the shadow is telemetry only

This is the removal gate: there is no remaining evidence of live DEX drift that justifies keeping the shadow path.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `worker/src/cron/dex-liquidity/price-sanity.ts` | Modify | Remove legacy-vs-new comparison bookkeeping; keep only active validator logic |
| `worker/src/cron/dex-liquidity/orchestrator.ts` | Modify | Stop resetting/reading DEX shadow stats; remove `priceValidationShadow` from metadata |
| `worker/src/cron/dex-discovery/orchestrator.ts` | Modify | Stop resetting/reading DEX shadow stats; remove `priceValidationShadow` from metadata |
| `worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts` | Modify | Replace shadow-counter assertions with pure behavior assertions |
| `worker/src/cron/__tests__/sync-dex-liquidity.test.ts` | Modify | Remove assertions that expect `metadata.priceValidationShadow` |
| `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts` | Add | Cover discovery metadata after shadow removal; assert success path without shadow field |
| `docs/dex-liquidity.md` | Modify | Remove the statement that DEX cron metadata still records shadow counters |
| `docs/status-dashboard.md` | Optional small edit | Clarify the operator-relevant DEX cron metadata set if the current wording would otherwise imply transitional telemetry |

**Likely no code changes required**

- `worker/src/api/status.ts`
- `src/components/status/cron-card.tsx`
- `docs/api-reference.md`

Reason: `/status` does not extract or summarize the DEX `priceValidationShadow` field directly. It passes through raw cron metadata, and the cron-card summary for DEX jobs already uses other fields.

---

## Phase 1: Remove Shadow Logic From The DEX Gate

### Task 1: Simplify `price-sanity.ts` to the live validator only

**Target:** `worker/src/cron/dex-liquidity/price-sanity.ts`

- [ ] Remove shadow-only imports:
  - `buildPriceReasonablenessOptions`
  - `isReasonablePrice`
- [ ] Delete the `DexPriceValidationShadowStats` interface
- [ ] Delete `EMPTY_SHADOW_STATS()`
- [ ] Delete module-level `shadowStats`
- [ ] Delete:
  - `resetDexPriceValidationShadowStats()`
  - `getDexPriceValidationShadowStats()`
- [ ] Remove `legacyAccepted` computation entirely
- [ ] Keep `buildPriceValidationContext(...)` and `validatePriceCandidate(...)` unchanged
- [ ] Keep `isPlausibleDexObservationPrice(...)` as the public helper, but reduce it to:
  - resolve metadata
  - build context
  - validate candidate
  - return `decision.accepted`

**Important constraint**

This task must be behavior-preserving. The removal should only delete comparison bookkeeping, not change the accepted/rejected result returned to DEX scoring or discovery.

---

## Phase 2: Remove DEX Shadow Telemetry Emission

### Task 2: Stop attaching shadow stats to DEX cron metadata

**Targets:**

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-discovery/orchestrator.ts`

- [ ] Remove imports of:
  - `getDexPriceValidationShadowStats`
  - `resetDexPriceValidationShadowStats`
- [ ] Remove the reset call at cron start in both orchestrators
- [ ] Remove `const priceValidationShadow = ...`
- [ ] Remove `priceValidationShadow` from both success and error metadata payloads
- [ ] Keep all other metadata unchanged:
  - `sourceCoverage`
  - `failedSources`
  - `fallbackMode`
  - staged-pool merge/skip counters
  - `coinsCrawled`
  - `poolsDiscovered`
  - `tierBreakdown`
  - `budgetExhausted`

**Scope guard**

Leave `validationFailures` alone unless the implementation proves it is also dead weight in the same touched block and can be removed with zero contract ambiguity. Shadow removal should not become a larger telemetry rewrite.

---

## Phase 3: Telemetry And `/status` Adjustments

### Task 3: Keep `/status` useful without the shadow field

**Current state**

- `/status` parses cron metadata generically in `worker/src/api/status.ts`
- `liquidityHealth` is derived from `sourceCoverage`, not from `priceValidationShadow`
- `src/components/status/cron-card.tsx` summarizes DEX cron runs from:
  - staged-pool counts
  - coverage values
  - price-observation coin count
  - failed sources
  - fallback mode
  - guardrail flags
- The raw metadata expander shows whatever remains in cron metadata

**Plan**

- [ ] Confirm no `/status` code path reads `priceValidationShadow` for DEX jobs
- [ ] Make **no** backend `/status` code changes unless a test reveals an implicit dependency
- [ ] Make **no** cron-card UI changes unless the post-removal summary becomes too sparse
- [ ] Verify that the raw metadata panel simply omits `priceValidationShadow` and still exposes enough DEX diagnostics

**Expected outcome**

There should be no dedicated `/status` code churn. The adjustment is mostly contract shrinkage:

- DEX cron metadata becomes smaller and less transitional
- `/status` remains focused on real operator signals rather than rollout-only comparison counters

---

## Phase 4: Test Coverage Updates

### Task 4: Rewrite tests around behavior, not removed telemetry

**Targets:**

- `worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts`
- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
- `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts` (new)

- [ ] In `dex-liquidity-price-sanity.test.ts`:
  - remove assertions on `getDexPriceValidationShadowStats()`
  - remove/reset helper usage tied only to the shadow
  - keep assertions on actual acceptance/rejection behavior for EUR, BRL, gold, silver, JPY, NAV, and VAR canaries
  - rename any test descriptions that still describe "tracking shadow counters"
- [ ] In `sync-dex-liquidity.test.ts`:
  - remove `metadata.priceValidationShadow` expectations
  - keep assertions for status, failed-source handling, staged-pool counters, and coverage metadata
- [ ] Add a focused `sync-dex-discovery` orchestrator test:
  - success path metadata includes `coinsCrawled`, `poolsDiscovered`, `tierBreakdown`, `budgetExhausted`, `failedCoins`
  - metadata does **not** include `priceValidationShadow`
  - status remains `ok` or `degraded` based on actual crawl outcomes only
- [ ] Only update `worker/src/api/__tests__/status.test.ts` if a fixture or example payload explicitly includes the removed DEX field

**Why add discovery coverage now**

`sync-dex-discovery` currently has live shadow emission but no dedicated orchestrator test covering the metadata contract. Removing the field without adding that test would leave one of the two touched producers under-covered.

---

## Phase 5: Documentation Updates

### Task 5: Remove stale references to DEX shadow telemetry

**Primary doc update**

- [ ] Update `docs/dex-liquidity.md`
  - remove the line stating that the cron still records `priceValidationShadow`
  - keep the description of the shared validation engine itself

**Status documentation**

- [ ] Review `docs/status-dashboard.md`
  - if the current text is already accurate without mentioning shadow telemetry, leave the content untouched
  - if a small clarification improves operator expectations, add one sentence noting that DEX cron metadata now centers on coverage, staging, fallback, and failure signals rather than rollout-only validator comparisons

**Do not edit historical plan files**

Historical handovers and implementation plans should remain historical records. They can continue to mention the old shadow rollout because that was true at the time.

---

## Phase 6: Verification

### Task 6: Local verification before deploy

- [ ] Run targeted tests:

```bash
npm test -- --run \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/cron/__tests__/sync-dex-liquidity.test.ts \
  worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts \
  worker/src/api/__tests__/status.test.ts
```

- [ ] Run worker type-check:

```bash
cd worker && npx tsc --noEmit
```

- [ ] Run lint:

```bash
npm run lint
```

- [ ] Run full app build:

```bash
npm run build
```

---

## Phase 7: Deployment And Post-Deploy Checks

### Task 7: Prove the contract shrink landed cleanly

**Pre-deploy snapshot**

- [ ] Capture current production DEX metadata from `/api/status` for rollback comparison:

```bash
ADMIN_KEY=$(sed -n 's/^ADMIN_KEY = "\\(.*\\)"/\\1/p' worker/.dev.vars)
curl -s https://api.pharos.watch/api/status \
  -H "X-Admin-Key: $ADMIN_KEY" |
  jq '{
    timestamp,
    dexLiquidity: .crons["sync-dex-liquidity"].lastRun.metadata,
    dexDiscovery: .crons["sync-dex-discovery"].lastRun.metadata
  }'
```

**Post-deploy checks**

- [ ] Verify both DEX cron metadata payloads no longer contain `priceValidationShadow`
- [ ] Verify both DEX jobs still complete with expected status (`ok` or justified `degraded`)
- [ ] Verify no unexpected drop in:
  - `sourceCoverage.currentCoverage`
  - `sourceCoverage.priceObservationCoins`
  - `coinsCrawled`
  - `poolsDiscovered`
- [ ] Verify `/status` still renders:
  - DEX liquidity health
  - cron card summaries
  - raw metadata expanders without errors

**Suggested post-deploy query**

```bash
ADMIN_KEY=$(sed -n 's/^ADMIN_KEY = "\\(.*\\)"/\\1/p' worker/.dev.vars)
curl -s https://api.pharos.watch/api/status \
  -H "X-Admin-Key: $ADMIN_KEY" |
  jq '{
    dexLiquidity: .crons["sync-dex-liquidity"].lastRun.metadata,
    dexDiscovery: .crons["sync-dex-discovery"].lastRun.metadata,
    liquidityHealth
  }'
```

---

## Acceptance Criteria

- [ ] No DEX code path computes legacy-vs-new comparison counters anymore
- [ ] `sync-dex-liquidity` metadata no longer emits `priceValidationShadow`
- [ ] `sync-dex-discovery` metadata no longer emits `priceValidationShadow`
- [ ] `/status` continues to function without DEX-specific shadow handling
- [ ] DEX cron summaries remain useful using existing coverage/failure metrics
- [ ] Relevant tests pass
- [ ] `npm run lint` passes
- [ ] `cd worker && npx tsc --noEmit` passes
- [ ] `npm run build` passes
- [ ] Production post-deploy checks show no unexpected DEX coverage regression

---

## Rollback

If post-deploy checks show a real DEX behavior regression, revert the removal commit as a single unit. Because the shadow path is telemetry-only, rollback should be all-or-nothing rather than a partial reintroduction.

Rollback triggers:

- sudden drop in DEX `currentCoverage` outside normal variance
- sudden drop in `priceObservationCoins`
- discovery crawl output unexpectedly collapsing
- new runtime errors in DEX cron runs or `/status`

---

## Recommendation

Proceed as a focused cleanup. The DEX shadow pipeline appears fully retired in practice; the implementation should remove the telemetry with minimal `/status` churn and without touching the still-active sync shadow systems.
