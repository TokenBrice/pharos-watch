# Mint/Burn Two-Signal Redesign Implementation Plan

> **For the implementing agent:** This document is intended to be self-sufficient. Read it fully before editing code. Do not assume prior context from chat history.

## Goal

Resolve the semantic inconsistency in mint/burn flows where a coin can show a strongly positive `flowIntensity` while still being net-burning over 24h and over trailing windows.

The redesign should make the product answer two distinct questions explicitly:

1. **What is the coin doing right now?**
   Use raw `Net Flow` direction and magnitude.
2. **How does current pressure compare with the coin's recent norm?**
   Use the existing baseline-relative score, but expose it as a separate signal with honest naming.

The target outcome is that a case like `usdf-falcon` can render as:

- `Burning` for current 24h direction
- `Improving vs 30D` for baseline-relative pressure shift

instead of implying minting via a positive score and printer-themed visuals.

---

## Locked Decisions

These decisions are in scope for this implementation and should be treated as fixed unless the user explicitly changes them.

1. **Keep the current scoring formula.**
   Do not change the existing math in `computeFlowIntensity()`. The formula remains:

   ```ts
   denominator = max(baselineDailyAbs * 0.3, 1_000_000)
   z = (currentDailyNet - baselineDailyNet) / denominator
   score = clamp(-100, 100, z * 50)
   ```

2. **Split semantics, not methodology.**
   This is a presentation and contract clarification pass, not a formula migration.

3. **Introduce two first-class per-coin signals.**
   - `Net Flow` = actual 24h direction and magnitude
   - `Pressure Shift vs 30D` = current pressure relative to the 30-day baseline

4. **Stop using the anomaly score as a proxy for direction.**
   All `printer` / `shredder` visuals and all “minting/burning” language must key off actual net flow, not the baseline-relative score.

5. **Use additive API evolution.**
   Keep the existing `flowIntensity` field as a deprecated alias for one compatibility cycle while the frontend migrates to the new field name.

6. **Bump Mint/Burn methodology version to `v4.4`.**
   This is a public semantics/contract change and should be recorded in the methodology changelog even though the underlying formula is unchanged.

---

## Current Problem Summary

The current code conflates two separate concepts:

- `flowIntensity` is computed as a 24h deviation from a 30-day baseline in [worker/src/lib/mint-burn-scoring.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/mint-burn-scoring.ts)
- The aggregate endpoint returns that score alongside raw net windows in [worker/src/api/mint-burn-flows.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows.ts)
- The stablecoin detail summary card uses the score sign to pick `printer` vs `shredder` mode in [src/components/flow-summary-card.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/flow-summary-card.tsx)
- Public copy says positive means minting in [src/app/flows/layout.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/flows/layout.tsx) and [src/app/methodology/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/page.tsx)

That creates a user-visible contradiction for cases where:

- `netFlow24hUsd < 0`
- `pressure relative to baseline > 0`

This is not a math bug. It is a semantics and UX contract bug.

---

## Design Target

### Per-Coin Signals

Each coin should expose and display:

1. **Net Flow 24h**
   - Source: existing `netFlow24hUsd`
   - Meaning: current direction and magnitude
   - Direction labels:
     - `Minting` if `netFlow24hUsd > 0`
     - `Burning` if `netFlow24hUsd < 0`
     - `Flat` if `netFlow24hUsd === 0` and there is activity
     - `No activity` if there is no 24h mint/burn activity

2. **Pressure Shift vs 30D**
   - Source: existing baseline-relative score, renamed
   - Meaning: whether current pressure is stronger or weaker than the coin’s recent norm
   - State labels:
     - `Improving` if score `> 10`
     - `Stable vs 30D` if score is between `-10` and `+10`
     - `Worsening` if score `< -10`
     - `NR` if insufficient history or no current activity

### Composite UI State

Use the two signals together for badge copy and explanatory text.

Primary composite states:

- `Minting + Improving`
- `Minting + Stable`
- `Minting + Worsening`
- `Burning + Improving`
- `Burning + Stable`
- `Burning + Worsening`
- `Flat + Improving`
- `Flat + Stable`
- `Flat + Worsening`
- `No activity / NR`

The key regression case that must render correctly after implementation:

- `usdf-falcon`
  - `netFlow24hUsd`: negative
  - `pressureShiftScore`: strongly positive
  - expected UI meaning: `Burning + Improving`

---

## Proposed API Contract

### Aggregate Coin Shape

Keep existing fields. Add the following fields to each coin in `/api/mint-burn-flows` aggregate mode.

```ts
{
  stablecoinId: string
  symbol: string

  // Deprecated alias retained for compatibility
  flowIntensity: number | null

  // New primary baseline-relative signal
  pressureShiftScore: number | null

  // Derived interpretation
  pressureShiftState: "improving" | "stable" | "worsening" | "nr"
  netFlowDirection24h: "minting" | "burning" | "flat" | "inactive"
  has24hActivity: boolean

  // Baseline context for UI explanation
  baselineDailyNetUsd: number | null
  baselineDailyAbsUsd: number | null
  baselineDataDays: number | null

  // Existing raw windows
  netFlow24hUsd: number
  mintVolume24hUsd: number
  burnVolume24hUsd: number
  mintCount24h: number
  burnCount24h: number
  netFlow7dUsd: number
  netFlow30dUsd: number
  netFlow90dUsd: number
  largestEvent24h: ...
}
```

### Compatibility Rules

1. `flowIntensity` remains present and equal to `pressureShiftScore` for this release.
2. The frontend must prefer `pressureShiftScore` and fall back to `flowIntensity`.
3. Shared Zod schemas should accept both shapes during rollout.
4. Do not remove `flowIntensity` in this task.

### Gauge Contract

Do **not** redesign the aggregate gauge math in this task.

Keep:

- `gauge.score`
- `gauge.band`
- `gauge.intensitySemantics`

But update product copy and docs so the gauge is explicitly described as a **market pressure shift** signal, not as literal market mint-vs-burn direction.

---

## Recommended New Shared Helper

Add a runtime-neutral helper in:

- `shared/lib/mint-burn-signals.ts`

Purpose:

- centralize naming and interpretation logic
- avoid duplicating thresholds in worker and frontend
- make tests deterministic

Recommended exports:

```ts
export type NetFlowDirection24h = "minting" | "burning" | "flat" | "inactive";
export type PressureShiftState = "improving" | "stable" | "worsening" | "nr";
export type CoinFlowCompositeState =
  | "minting-improving"
  | "minting-stable"
  | "minting-worsening"
  | "burning-improving"
  | "burning-stable"
  | "burning-worsening"
  | "flat-improving"
  | "flat-stable"
  | "flat-worsening"
  | "inactive";

export function getNetFlowDirection24h(input: {
  netFlow24hUsd: number;
  has24hActivity: boolean;
}): NetFlowDirection24h;

export function getPressureShiftState(score: number | null): PressureShiftState;

export function getCoinFlowCompositeState(input: {
  netFlow24hUsd: number;
  has24hActivity: boolean;
  pressureShiftScore: number | null;
}): CoinFlowCompositeState;
```

Thresholds:

- `Improving`: `score > 10`
- `Stable`: `-10 <= score <= 10`
- `Worsening`: `score < -10`

Rationale:

- These match the existing neutral band threshold already used throughout the gauge semantics.

If this file is added, update the file tree in:

- `docs/architecture.md`

---

## Implementation Batches

## Batch 1: Shared Types And Semantics

### Files

- Add: `shared/lib/mint-burn-signals.ts`
- Modify: `shared/types/index.ts`
- Modify: `src/hooks/use-mint-burn-flows.ts`
- Modify: `src/lib/flow-intensity.ts` or replace it with a better-named helper module

### Tasks

1. Add the shared interpretation helper in `shared/lib/`.
2. Extend `MintBurnCoinFlowSchema` in `shared/types/index.ts` with the new additive fields.
3. Mark `flowIntensity` as a deprecated alias in code comments.
4. Prefer a new schema name/comment for the baseline-relative score if that improves clarity, but preserve compatibility.
5. Update the hook normalizer so:
   - `pressureShiftScore` is used when present
   - `flowIntensity` is used as fallback for stale cached responses
6. If `src/lib/flow-intensity.ts` stays, rename helper comments so it no longer implies this score is direction. If a rename is cleaner, add a thin compatibility wrapper and avoid breaking imports all at once.

### Acceptance Criteria

- Frontend can safely consume both old and new API payloads.
- Shared types accurately describe the new two-signal model.

---

## Batch 2: Worker Aggregate Endpoint

### Files

- Modify: `worker/src/api/mint-burn-flows.ts`
- Keep unchanged mathematically: `worker/src/lib/mint-burn-scoring.ts`

### Tasks

1. In the aggregate coin-building loop, keep the current `intensity` calculation.
2. Publish that score as both:
   - `flowIntensity` (deprecated alias)
   - `pressureShiftScore` (new canonical field)
3. Add `has24hActivity` to the response.
4. Add:
   - `baselineDailyNetUsd`
   - `baselineDailyAbsUsd`
   - `baselineDataDays`
   using the existing baseline map already produced by `buildBaselineMap()`.
5. Add derived interpretation fields using the new shared helper:
   - `pressureShiftState`
   - `netFlowDirection24h`
6. Do not change the gauge calculation in this pass.
7. Keep `null` behavior for no-activity and insufficient-history windows exactly as it is today.

### Important Constraint

Do not introduce a partial semantic mismatch where:

- worker emits new fields
- frontend still interprets visuals from score sign

This batch and the UI batches must land together in the same implementation branch.

### Acceptance Criteria

- The aggregate endpoint can describe `Burning + Improving` correctly without the frontend inventing its own interpretation.

---

## Batch 3: Stablecoin Detail Summary Card

### Files

- Modify: `src/components/flow-summary-card.tsx`
- Reuse: `src/components/flow-machine-scene.tsx`
- Potentially modify: `src/lib/mint-burn-timeframes.ts`

### Target UX

Replace the current overloaded “Flow Intensity + printer/shredder” story with a two-signal card:

- Signal 1: `Net 24h`
- Signal 2: `Pressure Shift vs 30D`

The machine scene remains useful, but its mode must follow actual net flow direction:

- `printer` if `netFlow24hUsd > 0`
- `shredder` if `netFlow24hUsd < 0`
- neutral/no-activity handling for `0` or inactive windows

### Tasks

1. Make `sceneMode` depend on `netFlowDirection24h`, not score sign.
2. Replace the current hero headline block with two explicit rows or tiles:
   - `Net 24h`
   - `Pressure Shift vs 30D`
3. Keep the four raw window tiles:
   - current short window
   - current long window
   - `Net 30d`
   - `Net 90d`
4. Add a concise explanatory sentence below the signals when baseline data is available.

Recommended copy pattern:

- `Burning, but pressure is easing versus its 30D average.`
- `Minting, but weaker than its usual 30D issuance pace.`
- `No current activity; pressure shift is NR.`

5. Keep the numeric score visible for advanced users, but label it as `Pressure Shift vs 30D`, not `Flow Intensity`.
6. Avoid showing a `SURGE` / `CRISIS` style badge as if it were direction. If a badge remains, its wording must map to `Improving / Stable / Worsening`.

### Optional Helpful UI Detail

If space allows, add a muted baseline caption:

```text
30D avg daily net: -$7.51M
```

This is especially useful for explaining “still burning, but improving” states.

### Acceptance Criteria

- `usdf-falcon`-style cases render as burn-mode visuals with improving secondary context.
- No part of the card implies minting when `netFlow24hUsd < 0`.

---

## Batch 4: Flows Table

### Files

- Modify: `src/components/flow-table.tsx`

### Target UX

The table should make both questions easy to scan:

- actual direction now
- relative pressure vs baseline

### Tasks

1. Rename the `Flow Intensity` column to `Pressure vs 30D` or `Pressure Shift`.
2. Keep `Net 24h` as the primary directional column.
3. Update the score-cell styling so it communicates:
   - `Improving`
   - `Stable`
   - `Worsening`
   rather than implicitly `minting` vs `burning`
4. Keep the numeric score visible, but ensure the surrounding UI language is baseline-relative.
5. Consider a compact two-part cell:
   - badge/state text
   - signed numeric score
6. Update sorting:
   - keep sort support for pressure shift
   - change the default sort to `Net 24h` absolute magnitude or another directional-first choice
7. Do not sort the pressure column as if it were a net flow direction field.

### Acceptance Criteria

- A row can show negative `Net 24h` and positive `Pressure vs 30D` without looking contradictory.

---

## Batch 5: Flows Landing Page Overview

### Files

- Modify: `src/components/flow-brrr-overview.tsx`
- Modify: `src/app/flows/page.tsx`
- Modify: `src/components/flow-gauge.tsx` only if label text or semantics need updating

### Problem To Fix

The current overview uses meme-style printer/shredder logic that still risks implying `positive score = printing`.

### Tasks

1. Keep the aggregate gauge, but explicitly frame it as **market pressure vs baseline**.
2. Make the overview headline depend on both:
   - aggregate `Net 24h`
   - gauge score

Examples:

- `Net burn day, but market pressure is easing`
- `Broad minting with rising pressure`
- `Balanced net flow, neutral market pressure`

3. Audit all current “printer go BRRR” copy and replace any line that treats the gauge sign as literal mint/burn direction.
4. If the meme visual is retained, ensure its mode follows aggregate `net24h`, not gauge sign.
5. Keep `Bank Run Gauge` labels and thresholds intact, but describe them as ecosystem-wide pressure states.

### Acceptance Criteria

- The flows landing page no longer teaches users the wrong interpretation.

---

## Batch 6: Public Copy, FAQ, And Methodology Pages

### Files

- Modify: `src/app/flows/layout.tsx`
- Modify: `src/app/methodology/page.tsx`
- Modify: `src/app/flows/page.tsx`

### Tasks

1. Update the FAQ answer for “How is the Flow Intensity Score calculated?” in `src/app/flows/layout.tsx`.
2. Rename the public concept there from `Flow Intensity Score` to `Pressure Shift vs 30D` or clearly explain that the old score is baseline-relative and separate from net direction.
3. Update the methodology page section so it explicitly separates:
   - `Net Flow`
   - `Pressure Shift vs 30D`
   - `Bank Run Gauge`
4. Add one worked example on the methodology page:

Example:

- current 24h net = `-$0.2M`
- 30D average daily net = `-$7.5M`
- interpretation = `still burning, but dramatically lighter than normal`

5. Update the flows page intro copy so it states:
   - raw net windows tell you whether tokens are being minted or burned
   - the pressure score tells you whether today is stronger or weaker than the recent norm

### Acceptance Criteria

- A new user can understand why a coin can be `Burning + Improving` without reading source code.

---

## Batch 7: API Reference And Internal Docs

### Files

- Modify: `docs/api-reference.md`
- Modify: `docs/mint-burn-flows.md`
- Modify: `docs/mint-burn-flows-timeline.md`
- Modify: `docs/architecture.md`
- Modify: `shared/lib/mint-burn-flow-version.ts`
- Modify: `src/app/methodology/mint-burn-flow-changelog/page.tsx` only if needed indirectly by version change
- Modify: `src/app/sitemap.ts`

### Tasks

1. Update `docs/api-reference.md`:
   - add the new coin fields
   - mark `flowIntensity` as deprecated alias
   - clarify that `pressureShiftScore` is baseline-relative
   - clarify that `netFlow24hUsd` is the true current direction field
2. Update `docs/mint-burn-flows.md`:
   - revise the scoring section
   - add the new two-signal interpretation model
   - document the helper module if added
   - explain the compatibility alias
3. Add a new methodology version entry `v4.4` in `shared/lib/mint-burn-flow-version.ts`:
   - title should reflect semantic split / two-signal interpretation
   - include methodology impact bullets
4. Mirror that change in `docs/mint-burn-flows-timeline.md`.
5. If `shared/lib/mint-burn-signals.ts` is added, update `docs/architecture.md`.
6. Update sitemap `lastModified` dates for methodology routes touched by the version bump.

### Recommended `v4.4` Changelog Summary

Suggested title:

- `Two-signal flow semantics and baseline-aware UI interpretation`

Suggested impact bullets:

- `Per-coin flow UI now separates raw 24h net flow from baseline-relative pressure shift`
- `API now exposes canonical pressureShiftScore and interpretation fields while retaining flowIntensity as a deprecated alias`
- `Frontend printer/shredder visuals now key off actual net flow direction instead of score sign`
- `Methodology docs now distinguish current flow direction from pressure-vs-baseline context`

---

## Batch 8: Tests

### Files

- Add or modify: `worker/src/api/__tests__/mint-burn-flows.test.ts`
- Add: `src/lib/__tests__/mint-burn-signals.test.ts` or equivalent shared-helper test file
- Modify: `src/lib/__tests__/mint-burn-flow-version.test.ts`

### Tasks

1. Add unit tests for the new shared interpretation helper.
2. Cover these cases explicitly:
   - negative net flow + positive score => `burning-improving`
   - negative net flow + negative score => `burning-worsening`
   - positive net flow + positive score => `minting-improving`
   - positive net flow + negative score => `minting-worsening`
   - zero net flow + activity => `flat-*`
   - no activity => `inactive`
   - `null` score => `nr`
3. Update endpoint tests to assert new fields are present and correctly derived.
4. Add a regression test representing the `USDf-Falcon` pattern:
   - `netFlow24hUsd < 0`
   - `pressureShiftScore > 0`
   - interpretation must not collapse to a minting state
5. Update methodology version tests for `v4.4`.

### Important Constraint

Do not remove old tests that still assert `flowIntensity` exists unless the API contract is intentionally updated to document it as deprecated but present.

---

## Batch 9: Verification And Manual QA

### Required Commands

Run all of these before considering the implementation done:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

### Manual QA Checklist

Validate at minimum:

1. **Stablecoin detail page**
   - detail card renders two signals clearly
   - machine scene matches `Net 24h` direction
   - explanatory copy is coherent for all states

2. **Flows table**
   - column labels are clear
   - default sort feels direction-first
   - negative net + positive pressure no longer feels contradictory

3. **Flows landing page overview**
   - aggregate headline does not imply `positive gauge = printing`
   - gauge copy reads as pressure/regime context

4. **NR / no-activity windows**
   - render as `No activity` / `NR`
   - do not show misleading printer or shredder claims

5. **Backward compatibility**
   - stale cached response containing only `flowIntensity` does not break the frontend

### Suggested Spot Checks

Use whichever coins happen to match these states at test time, or create deterministic test fixtures if live data does not cooperate:

- burning + improving
- burning + worsening
- minting + improving
- minting + worsening
- no activity

---

## Recommended Rollout Order

Implement in this order:

1. Shared helper and types
2. Worker additive fields
3. Hook normalization / compatibility fallback
4. Stablecoin detail card
5. Flows table
6. Flows landing page overview
7. Public docs and methodology version bump
8. Tests
9. Full verification

This order reduces the chance of landing a partially migrated state.

---

## Non-Goals

These are intentionally out of scope for this task:

- changing the actual `computeFlowIntensity()` formula
- redesigning the Bank Run Gauge weighting
- renaming or removing `gauge.score`
- removing `flowIntensity` from the public API immediately
- changing the ingestion pipeline or database schema

---

## Completion Criteria

This plan is complete only when all of the following are true:

1. The product exposes two explicit per-coin signals: `Net Flow` and `Pressure Shift vs 30D`.
2. The stablecoin detail card no longer uses score sign to imply minting or burning.
3. The flows table and flows landing page no longer teach the old semantics.
4. Public docs and methodology pages explain the two-signal model clearly.
5. The Mint/Burn methodology version is bumped to `v4.4` with changelog entries.
6. Compatibility with cached `flowIntensity` responses is preserved.
7. Lint, tests, build, and worker type-check all pass.

