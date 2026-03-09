---
title: "Bump mint/burn flow methodology to v4.5 with data quality changelog"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Document all Phase 1 data quality changes publicly via methodology version bump and changelog entry.

## Context

Phase 1 made four data quality changes to the mint/burn flows feature:
1. Q1: Atomic roundtrip detection — flash loans/atomic arb excluded from aggregation
2. Q3: Auto price backfill — NULL amount_usd self-healed within 48h
3. Q4: Activity gate — coins with < $50K 24h flow return NR pressure shift

These changes alter what users see (some scores disappear, burn volumes change). Users making financial decisions based on this data deserve to know what changed.

## Task

1. **`shared/lib/mint-burn-flow-version.ts`**:
   - Update `currentVersion` from `"4.4"` to `"4.5"` (line 6).
   - Add new changelog entry at the TOP of the `changelog` array (before the v4.4 entry at line 9):
     ```typescript
     {
       version: "4.5",
       title: "Data quality: noise filtering, auto-heal, and activity gating",
       date: "2026-03-XX", // Use today's date or the merge date
       effectiveAt: 0, // Set to the unix timestamp of the deploy
       summary:
         "Improves flow data reliability by excluding flash-loan roundtrips from aggregation, auto-healing missing USD prices, and gating pressure shift for low-activity coins.",
       impact: [
         "Transactions containing both mint and burn for the same token (flash loans, atomic arb) are now flagged as atomic_roundtrip and excluded from all flow aggregates",
         "Events synced without USD price are now automatically backfilled within 48h by the sync cron",
         "Coins with less than $50K absolute 24h flow now return NR instead of a potentially misleading pressure shift score",
         "New observability counters in cron metadata: atomicRoundtripsDetected, nullPricesHealed",
       ],
       commits: ["unreleased"],
       reconstructed: false,
     },
     ```

2. **`docs/mint-burn-flows.md`**:
   - Update methodology version reference from `v4.4` to `v4.5` (find the line `**Current methodology version:** \`v4.4\`` and change to `v4.5`).
   - In the **Constants & Thresholds** table, add a new row:
     ```
     | `MIN_ACTIVITY_USD` | 50,000 | 24h absolute flow below this returns NR pressure shift |
     ```
   - In the **Contract Configurations** section (around line 59), update the intro text to mention `flow_type`:
     Add a note: "Events are also classified by `flow_type` (`standard` or `atomic_roundtrip`) to exclude flash loan / atomic arb noise from aggregation."
   - In the **Scoring** section, add a paragraph after the pressure shift formula description:
     "**Activity gate:** If the coin's 24h absolute flow (mint volume + burn volume) is below `MIN_ACTIVITY_USD` ($50,000), pressure shift returns `null` (NR). This prevents misleading scores for dormant or low-activity coins."
   - In the **Database Schema** section for `mint_burn_events`, add the `flow_type` column:
     ```
     flow_type TEXT DEFAULT 'standard',    -- "standard" or "atomic_roundtrip"
     ```

## Acceptance Criteria

- `npm run build` — builds successfully (methodology page renders)
- `cd worker && npx tsc --noEmit` — no type errors
- `grep -c '"4.5"' shared/lib/mint-burn-flow-version.ts` — returns 2 (currentVersion + changelog entry)
- `grep -c 'v4.5' docs/mint-burn-flows.md` — returns at least 1
- `grep -c 'MIN_ACTIVITY_USD' docs/mint-burn-flows.md` — returns at least 1
- `grep -c 'flow_type' docs/mint-burn-flows.md` — returns at least 1
- `grep -c 'atomic_roundtrip' docs/mint-burn-flows.md` — returns at least 1
