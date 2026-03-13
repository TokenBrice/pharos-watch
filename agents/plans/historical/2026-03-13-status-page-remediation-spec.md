# Status Page Accuracy Remediation — Spec

**Date:** 2026-03-13
**Source:** `agents/plans/2026-03-13-status-page-audit.md`
**Scope:** 21 issues across threshold duplication, ungrounded UI copy, data contract mismatches, and validation gaps.

---

## Design Decisions

Each decision optimizes for **truthfulness** (status page reflects actual system state) and **actionability** (operators can act on what they see).

---

## Change 1: Shared Status Thresholds Module

**Issues:** 1.1, 1.2, 1.3, 1.4, 1.5

### What

Move `worker/src/lib/status-thresholds.ts` to `shared/lib/status-thresholds.ts`. Add cache ratio thresholds, missing price thresholds, and price source confidence severity bands. Both worker and frontend import from one source.

### New shared module contents

```typescript
// shared/lib/status-thresholds.ts

// --- Blacklist gap thresholds ---
export const BLACKLIST_RECENT_WINDOW_SEC = 24 * 3600;
export const STATUS_BLACKLIST_THRESHOLDS = {
  missingRatioDegraded: 0.005,
  missingRatioStale: 0.02,
  missingRecentStale: 25,
} as const;

// --- On-chain supply thresholds ---
export const STATUS_ONCHAIN_THRESHOLDS = {
  ratioDegraded: 0.1,
  ratioStale: 0.25,
  staleAbsoluteStale: 10,
  divergenceAbsoluteStale: 25,
} as const;
export const STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC = 3 * 24 * 3600;
export const STATUS_ONCHAIN_FRESH_WINDOW_SEC = 2 * 3600;
export const STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD = 0.05;

// --- Missing price thresholds ---
export const STATUS_MISSING_PRICE_THRESHOLDS = {
  ratioDegraded: 0.15,
  ratioStale: 0.4,
} as const;

// --- Cache ratio thresholds (availability status) ---
export const STATUS_CACHE_RATIO_THRESHOLDS = {
  degraded: 1.5,
  stale: 2,
} as const;

// --- Price source confidence severity bands ---
export const STATUS_PRICE_CONFIDENCE_BANDS = {
  highPctGreen: 85,
  highPctAmber: 70,
  missingCountAmber: 3,
  lowCountAmber: 5,
  lowCountRed: 10,
} as const;

// --- Mint/burn reconciliation thresholds ---
export const STATUS_RECONCILIATION_THRESHOLDS = {
  criticalAbsoluteUsd: 100_000_000,
  criticalRatio: 0.3,
  warnAbsoluteUsd: 25_000_000,
  warnRatio: 0.12,
} as const;
```

### Consumers to update

- `worker/src/api/status.ts` — import from `@shared/lib/status-thresholds` instead of `../lib/status-thresholds`
- `worker/src/api/status-data-quality.ts` — same
- `worker/src/api/status-derived-data.ts` — use `STATUS_RECONCILIATION_THRESHOLDS` instead of inline `100_000_000` / `0.3` / etc.
- `src/components/status/data-quality-cards.tsx` — import thresholds for severity logic and detail strings
- `src/components/status/cache-freshness-table.tsx` — import `STATUS_CACHE_RATIO_THRESHOLDS` for both severity logic and description text
- `src/components/status/price-source-health.tsx` — import `STATUS_PRICE_CONFIDENCE_BANDS`
- Delete `worker/src/lib/status-thresholds.ts` after migration

---

## Change 2: Discovery Min Market Cap to Shared

**Issue:** 2.4

### What

Move `DISCOVERY_MIN_MCAP` from `worker/src/cron/discovery-scan.ts` to `shared/lib/status-thresholds.ts`. Import in both the cron and the UI component.

### Consumers

- `worker/src/cron/discovery-scan.ts` — import from shared
- `src/components/status/discovery-candidates.tsx` — import and use in empty-state copy: `` `No untracked stablecoins above $${(DISCOVERY_MIN_MCAP / 1_000_000).toFixed(0)}M found.` ``

---

## Change 3: Fix Reserve Composition Double-Count

**Issue:** 4.4

### What

In `worker/src/lib/live-reserves-store.ts:computeReserveCompositionOverview()`, restructure the per-coin loop so categories are mutually exclusive.

### New logic

```
for each coin:
  if no successAt or no composition:
    → missing (and skip rest)
  if stale (age > freshness window):
    → stale (check degraded flag too — degraded+stale = stale)
  if sync status !== "ok" or snapshot inconsistent:
    → degraded
  else:
    → fresh
```

The key change: the `missing` check runs first and `continue`s, preventing the degraded counter from also firing.

---

## Change 4: Add `onchain_monitor_unavailable` Cause to Backend

**Issue:** 3.2

### What

When on-chain monitoring is `"unavailable"`, the backend currently emits no cause — the operator sees nothing. Add an `info`-level cause so the condition is visible.

### Backend change

In `worker/src/api/status.ts`, after the on-chain integrity cause block, add:

```typescript
if (!hasActiveOnchainMonitor && dataQuality.onchainSupplyMonitoring === "unavailable") {
  pushCause(dataQualityCauses, {
    code: "onchain_monitor_unavailable",
    layer: "data-quality",
    severity: "info",
    message: "On-chain supply monitor has no active producer. On-chain integrity checks are skipped.",
  });
}
```

This makes the existing action-recommendation mapping in `action-recommendations.ts:18` live code instead of dead code. The test at `status.test.ts:802-803` needs updating to expect this cause when monitoring is unavailable.

---

## Change 5: Align Cause Filtering in StatusFacts

**Issue:** 3.4

### What

Change `status-facts.tsx` to use `causes.overall` instead of `[...causes.availability, ...causes.dataQuality]`. This aligns with action-recommendations (which also uses `causes.overall`) and the top-fold causes in client.tsx (which uses the model's `topCauses` derived from `overall`).

Rationale: `overall` is the severity-sorted, deduplicated merge. Using raw arrays in one place and `overall` in another creates inconsistency. `overall`'s cap of 12 is generous for a blocker list.

### Change

`src/components/status/status-facts.tsx:143`:
```typescript
// Before
const activeCauses = [...causes.availability, ...causes.dataQuality];
// After
const activeCauses = causes.overall;
```

---

## Change 6: Add `reclassify-atomic-roundtrips` to Status Page

**Issue:** 3.3

### What

Add a `statusPageAction` config to the endpoint definition in `shared/lib/api-endpoints.ts`. This makes it available as an operator action after mint/burn backfills.

```typescript
{
  key: "reclassify-atomic-roundtrips",
  path: "/api/reclassify-atomic-roundtrips",
  methods: ["POST"],
  adminRequired: true,
  mutatingAdmin: true,
  cacheBypass: true,
  probeGroup: "manual",
  statusPageAction: {
    label: "Reclassify Roundtrips",
    confirm: "Reclassify atomic roundtrips in mint/burn data?",
    method: "POST",
  },
},
```

---

## Change 7: Recovery Hold — Show Remaining Checks

**Issue:** 2.5

### What

When the status banner shows a recovery hold, add the remaining consecutive healthy checks needed. The data is already in `state.consecutiveRaw` and `state.thresholds`.

### Change in `status-banner.tsx`

Replace the generic hold copy with computed remaining-checks text:

```
Effective status is still holding {status} while raw is {rawStatus}.
{remainingChecks} more consecutive {rawStatus} check(s) needed before transition.
```

Where `remainingChecks` = `thresholds.recoverToHealthy - consecutiveRaw.healthy` (when raw is healthy) or `thresholds.recoverToDegraded - consecutiveRaw.degraded` (when raw is degraded and effective is stale).

The `StatusBanner` component needs the `state` prop added (it already receives the data through to `client.tsx`).

---

## Change 8: Liquidity Guard Labels — Show Actual Coverage

**Issue:** 2.6

### What

Replace generic "near threshold" / "normal" labels with actual coverage values. The component already has `health.currentCoverage` and `health.previousCoverage`.

### Change in `liquidity-health.tsx`

```typescript
// Before
Row guard: {health.nearCoverageGuard ? "near threshold" : "normal"}

// After
Row guard: {health.nearCoverageGuard
  ? `${health.currentCoverage} coins (near guard)`
  : `${health.currentCoverage} coins`}
```

Similarly for value guard (show TVL) and major coverage guard (show top-10 TVL).

---

## Change 9: Reconciliation Detail Text — Show Thresholds

**Issue:** 2.1

### What

Update the mint-burn reconciliation card description to include the actual thresholds instead of saying "large gaps".

### Change in `mint-burn-reconciliation.tsx`

Import `STATUS_RECONCILIATION_THRESHOLDS` and update the description:

```
Compares 24h Ethereum mint/burn net flow against the stablecoins cache's Ethereum chain-supply delta.
Warn at $${(THRESHOLDS.warnAbsoluteUsd / 1e6).toFixed(0)}M or ${(THRESHOLDS.warnRatio * 100)}% divergence.
Critical at $${(THRESHOLDS.criticalAbsoluteUsd / 1e6).toFixed(0)}M or ${(THRESHOLDS.criticalRatio * 100)}% divergence.
```

---

## Change 10: Endpoint Health Grid — Show Actual Skip List

**Issue:** 2.2

### What

Replace the generic "skips routes that require volatile parameters" copy with the actual list of unprobed endpoints, derived from `ENDPOINT_DEFINITIONS`.

### Change in `endpoint-health-grid.tsx`

Import `ENDPOINT_DEFINITIONS` from `@shared/lib/api-endpoints` and compute the unprobed public endpoints (those with no `probeGroup`):

```typescript
const unprobedEndpoints = ENDPOINT_DEFINITIONS
  .filter(e => !e.probeGroup && !e.adminRequired)
  .map(e => e.key);
```

Then render: `Skipped: ${unprobedEndpoints.join(", ")}` (or nothing if empty).

---

## Change 11: `snapshot-supply` — Fix Dual Scheduling Metadata

**Issue:** 3.1

### What

Change `intervalSec` to `900` and `scheduleKey` to `quarterHourly` in `shared/lib/cron-jobs.ts`. The daily trigger is a safety net, not the primary schedule. The cron card should reflect the actual expected cadence.

Add a comment in the definition noting the daily fallback.

---

## Change 12: System Diagnostics — Null Guard on Timestamps

**Issue:** 4.3

### What

In `system-diagnostics.tsx`, guard `lastEvaluatedAt` and `lastChangedAt` against zero values. Show "pending" instead of "just now" when either is 0.

---

## Change 13: Dataset Freshness Table — Document UI Bands

**Issue:** 3.6

### What

Add a parenthetical to the freshness table description noting the visual band thresholds: "Bands are visual heuristics: on time (<2x interval), aging (2–3x), late (>3x)."

This makes it transparent that these are UI-only visual indicators, not backend status thresholds.

---

## Change 14: Doc Updates

**Issues:** 3.3, 3.5, 2.1

### What

1. `docs/status-dashboard.md` — Remove `POST /api/reclassify-atomic-roundtrips` from the plain inline actions list (now it's auto-derived from endpoint definitions). Add reconciliation thresholds to the Mint/Burn Reconciliation Card section. Add `onchain_monitor_unavailable` cause code to the data quality causes documentation.
2. `CLAUDE.md:125` — Fix count from "23 scheduled jobs / 22 status-tracked jobs" to "24 scheduled jobs / 23 status-tracked jobs".
3. `AGENTS.md:96` — Same fix.
4. `docs/worker-infrastructure.md` — No change needed (already says "24 ... track 23").

---

## Explicitly Not Changed

- **2.3 Recommended Action Strip empty-state copy** — Editorial guidance text. Not data-driven by design; no truthfulness issue.
- **4.1 Telegram metadata parsing** — Defensive parsing with null fallbacks is correct behavior. Adding console warnings for dev mode is over-engineering for the status page.
- **4.2 Cron metadata summarizers coverage** — 8/23 jobs have summarizers; the rest have simple metadata shown via raw JSON disclosure. No truthfulness issue.

---

## File Change Summary

| File | Action |
|------|--------|
| `shared/lib/status-thresholds.ts` | **Create** (from worker version + new constants) |
| `worker/src/lib/status-thresholds.ts` | **Delete** |
| `worker/src/api/status.ts` | Edit imports, add `onchain_monitor_unavailable` cause |
| `worker/src/api/status-data-quality.ts` | Edit imports |
| `worker/src/api/status-derived-data.ts` | Edit: use shared reconciliation thresholds |
| `worker/src/lib/live-reserves-store.ts` | Edit: fix double-count |
| `worker/src/cron/discovery-scan.ts` | Edit: import `DISCOVERY_MIN_MCAP` from shared |
| `shared/lib/cron-jobs.ts` | Edit: `snapshot-supply` intervalSec/scheduleKey |
| `shared/lib/api-endpoints.ts` | Edit: add `reclassify-atomic-roundtrips` statusPageAction |
| `src/components/status/data-quality-cards.tsx` | Edit: import shared thresholds |
| `src/components/status/cache-freshness-table.tsx` | Edit: import shared thresholds |
| `src/components/status/price-source-health.tsx` | Edit: import shared bands |
| `src/components/status/discovery-candidates.tsx` | Edit: import shared min mcap |
| `src/components/status/status-facts.tsx` | Edit: use `causes.overall` |
| `src/components/status/status-banner.tsx` | Edit: show remaining recovery checks |
| `src/components/status/liquidity-health.tsx` | Edit: show actual coverage in guard labels |
| `src/components/status/mint-burn-reconciliation.tsx` | Edit: show thresholds in description |
| `src/components/status/endpoint-health-grid.tsx` | Edit: show actual skip list |
| `src/components/status/dataset-freshness-table.tsx` | Edit: document band heuristics |
| `src/components/status/system-diagnostics.tsx` | Edit: null guard timestamps |
| `worker/src/api/__tests__/status.test.ts` | Edit: update for new cause code |
| `docs/status-dashboard.md` | Edit: thresholds, cause code, action list |
| `CLAUDE.md` | Edit: fix job count |
| `AGENTS.md` | Edit: fix job count |
