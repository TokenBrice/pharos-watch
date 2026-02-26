# Redesign Resilience Dimension: Binary Blacklistability

## Context

The current Resilience dimension uses chain count (60%) + freeze rate (40%), but both sub-scores are flawed:
- **Chain distribution** penalizes single-chain stablecoins that are genuinely resilient (BOLD, LUSD)
- **Freeze rate** only has data for 4 coins (USDT, USDC, PAXG, XAUT); all others get a neutral 85

Replace with a simple, meaningful binary: **can the token be blacklisted?**
- Not blacklistable → 100
- Blacklistable → 0

Data source: optional `canBeBlacklisted` field on `StablecoinMeta`, falling back to governance type (centralized → true, decentralized/centralized-dependent → false).

---

## Changes

### 1. Types — `src/lib/types.ts`

- Add `canBeBlacklisted?: boolean` to `StablecoinMeta` (after `dependencies`)
- Update `RawDimensionInputs`: replace `chainCount`, `freezeEventsPerMonth`, `hasTrackedFreezeEvents` with `canBeBlacklisted: boolean`

### 2. Stablecoin metadata — `src/lib/stablecoins.ts`

- Add `canBeBlacklisted: true` explicitly to coins where governance doesn't tell the full story (e.g. centralized-dependent coins that DO have blacklist functions)
- Add `canBeBlacklisted: false` to any centralized coins that genuinely cannot blacklist (if any exist)
- Coins without the field use the governance fallback

### 3. Grading engine — `src/lib/report-cards.ts`

- Rewrite `scoreResilience()`:
  - Signature: `scoreResilience(canBeBlacklisted: boolean): ReportCardDimension`
  - Logic: `canBeBlacklisted ? 0 : 100`
  - Detail string: "Token can be blacklisted by issuer" or "Token has no blacklist capability"
- Remove `BluechipGrade`/`BluechipRating` imports if still present (cleanup from safety removal)
- Bump `METHODOLOGY_VERSION` to `"2.1"`

### 4. Worker API handler — `worker/src/api/report-cards.ts`

- Add helper to derive `canBeBlacklisted`:
  ```
  function isBlacklistable(meta: StablecoinMeta): boolean {
    if (meta.canBeBlacklisted !== undefined) return meta.canBeBlacklisted;
    return meta.flags.governance === "centralized";
  }
  ```
- Update `computeCard()`: call `scoreResilience(canBeBlacklisted)` instead of `scoreResilience(chainCount, freezeEventsPerMonth, hasTrackedFreezeEvents)`
- Update `rawInputs`: replace `chainCount`, `freezeEventsPerMonth`, `hasTrackedFreezeEvents` with `canBeBlacklisted`
- Remove `BLACKLIST_NAME_TO_ID`, `COINS_WITH_TRACKED_FREEZE`, freeze rate aggregation query, and `freezeRateById` map — no longer needed for scoring
- **Keep**: blacklist cache loading if used elsewhere (blacklist sync/API stays intact for the blacklist page)

### 5. Frontend — pages and components

- **`src/app/risk-lab/page.tsx`**: No change needed (description already says "Five dimensions")
- **`src/app/about/page.tsx`**: Update Resilience row in weights table — change source description from "Chain count (60%) + freeze rate (40%)" to "Blacklist capability from token metadata"
- **`docs/report-cards.md`**: Rewrite Resilience section — remove chain distribution table, freeze rate details, replace with blacklistability description

### 6. Documentation

- **`docs/report-cards.md`**: Replace entire Resilience Sub-Scores section with blacklistability description
- **`docs/api-reference.md`**: Update `rawInputs` field documentation (remove chainCount/freezeEventsPerMonth/hasTrackedFreezeEvents, add canBeBlacklisted)

---

## Files That Auto-Adapt (NO changes needed)

- `src/components/radar-chart.tsx`, `report-card.tsx`, `report-card-mini.tsx` — display dimension scores dynamically
- `src/hooks/use-stress-test.ts` — doesn't recompute resilience (only dependency risk)
- Blacklist page, sync cron, API endpoint — untouched, still serve blacklist data for display

## Files to KEEP Untouched

- `worker/src/cron/sync-blacklist.ts` — continues syncing freeze events for the blacklist page
- `worker/src/api/blacklist.ts` — continues serving blacklist endpoint
- `worker/src/lib/blacklist-contracts.ts` — still needed for sync

---

## Verification

1. `npm run build` — type-check + static export
2. `cd worker && npx tsc --noEmit` — worker type-check
3. Spot-check: LUSD/BOLD (decentralized, no blacklist) should get Resilience = A+ (100), USDT/USDC (centralized, blacklistable) should get Resilience = F (0)
4. Verify weights still sum: 0.25 + 0.25 + 0.15 + 0.10 + 0.25 = 1.00
