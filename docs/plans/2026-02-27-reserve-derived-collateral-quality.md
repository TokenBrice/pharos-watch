# Reserve-Derived Collateral Quality Scoring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Derive collateral quality scores from curated reserve composition data (5-tier risk) instead of a coarse enum, starting with ZCHF.

**Architecture:** Expand `ReserveRisk` from 3→5 tiers measuring counterparty risk. Add a weighted-average function that computes collateral quality from reserve slices. Plug into `scoreResilience()` with fallback to existing enum for coins without curated reserves.

**Tech Stack:** TypeScript strict, Next.js 16 static export, shared `src/lib/` consumed by both frontend and Cloudflare Worker.

**Design doc:** `docs/plans/2026-02-27-reserve-derived-collateral-quality-design.md`

---

### Task 1: Expand ReserveRisk type to 5 tiers

**Files:**
- Modify: `src/lib/types.ts:75`

**Step 1: Change the ReserveRisk type**

```typescript
// Before (line 75):
export type ReserveRisk = "low" | "medium" | "high";

// After:
export type ReserveRisk = "very-low" | "low" | "medium" | "high" | "very-high";
```

**Step 2: Verify the build breaks**

Run: `npm run build`
Expected: FAIL — `Record<ReserveRisk, ...>` maps in `reserve-treemap.tsx` are no longer exhaustive.

**Step 3: Commit**

```
feat(types): expand ReserveRisk from 3 to 5 tiers
```

---

### Task 2: Update treemap visualization for 5 tiers

**Files:**
- Modify: `src/components/reserve-treemap.tsx:12-22`

**Step 1: Update RISK_COLORS (line 12-16)**

```typescript
const RISK_COLORS: Record<ReserveRisk, string> = {
  "very-low": "#16a34a",  // dark green (green-600)
  low: "#22c55e",          // green (green-500)
  medium: "#f59e0b",       // amber (amber-500)
  high: "#f97316",         // orange (orange-500)
  "very-high": "#ef4444",  // red (red-500)
};
```

**Step 2: Update RISK_LABELS (line 18-22)**

```typescript
const RISK_LABELS: Record<ReserveRisk, string> = {
  "very-low": "Very Low Risk",
  low: "Low Risk",
  medium: "Medium Risk",
  high: "High Risk",
  "very-high": "Very High Risk",
};
```

**Step 3: Verify build passes for this file**

Run: `npx tsc --noEmit`
Expected: Errors remain in `stablecoins.ts` and `reserve-templates.ts` (old tier values), but `reserve-treemap.tsx` itself is clean.

**Step 4: Commit**

```
feat(ui): update reserve treemap for 5-tier risk colors
```

---

### Task 3: Migrate reserve-templates.ts to 5 tiers

**Files:**
- Modify: `src/lib/reserve-templates.ts:10-79`

**Step 1: Re-classify template slices**

Apply the tier definitions from the design doc. Key migration rules:
- Government securities, cash, repos → `very-low`
- Stablecoins (USDC/USDT), tokenized treasuries → `low`
- ETH, BTC, ETH LSTs, wrapped BTC → `medium` (but check: if native ETH/BTC only → `very-low`)
- Delta-neutral, alt-chain, opaque → `high`
- Governance tokens, exotic strategies → `very-high`

Full replacement for the TEMPLATES object:

```typescript
const TEMPLATES: Record<string, ReserveSlice[]> = {
  "rwa-centralized": [
    { name: "U.S. Treasuries / Gov Securities", pct: 70, risk: "very-low" },
    { name: "Cash & Bank Deposits", pct: 20, risk: "very-low" },
    { name: "Other Reserves", pct: 10, risk: "low" },
  ],
  "rwa-centralized-dependent": [
    { name: "Tokenized Treasuries / RWA", pct: 50, risk: "very-low" },
    { name: "Stablecoin Reserves (USDC/USDT)", pct: 35, risk: "low" },
    { name: "Other Assets", pct: 15, risk: "low" },
  ],
  "crypto-centralized": [
    { name: "Stablecoins (USDC/USDT)", pct: 40, risk: "low" },
    { name: "BTC / ETH Positions", pct: 40, risk: "medium" },
    { name: "Other Crypto", pct: 20, risk: "high" },
  ],
  "crypto-centralized-dependent": [
    { name: "ETH / LSTs", pct: 35, risk: "low" },
    { name: "Stablecoin Collateral", pct: 30, risk: "low" },
    { name: "BTC / wBTC", pct: 15, risk: "medium" },
    { name: "Other Vaults / Assets", pct: 20, risk: "high" },
  ],
  "crypto-centralized-dependent-rwa": [
    { name: "RWA (Treasuries / Tokenized)", pct: 40, risk: "very-low" },
    { name: "Stablecoin PSM", pct: 30, risk: "low" },
    { name: "ETH / LSTs", pct: 20, risk: "low" },
    { name: "Other Vaults", pct: 10, risk: "high" },
  ],
  "crypto-centralized-dependent-exotic": [
    { name: "Delta-Neutral Positions (CEX)", pct: 50, risk: "high" },
    { name: "Stablecoins (USDC/USDT)", pct: 25, risk: "low" },
    { name: "Volatile Crypto", pct: 25, risk: "high" },
  ],
  "crypto-decentralized": [
    { name: "ETH / LSTs", pct: 80, risk: "low" },
    { name: "Other On-Chain Collateral", pct: 20, risk: "high" },
  ],
  algorithmic: [
    { name: "Protocol-Owned Reserves", pct: 50, risk: "high" },
    { name: "Algorithmic Stabilization", pct: 50, risk: "very-high" },
  ],
  "commodity-gold": [
    { name: "Physical Gold Bullion", pct: 95, risk: "very-low" },
    { name: "Cash / Operational", pct: 5, risk: "very-low" },
  ],
  "commodity-silver": [
    { name: "Physical Silver Bullion", pct: 95, risk: "very-low" },
    { name: "Cash / Operational", pct: 5, risk: "very-low" },
  ],
};
```

**Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: Errors remain only in `stablecoins.ts` (old tier values in curated reserves).

**Step 3: Commit**

```
feat(reserves): migrate templates to 5-tier risk system
```

---

### Task 4: Migrate curated reserve slices in stablecoins.ts

This is the largest task (~374 slices). **Use parallel subagents per batch.**

**Files:**
- Modify: `src/lib/stablecoins.ts` (all `risk:` values in `reserves` arrays)

**Step 1: Apply migration rules to every `risk:` value**

Rules by slice content (apply in order, first match wins):

**`"low"` → `"very-low"`:**
- U.S. Treasury, Treasury Bills, Overnight Repos, Reverse Repos, Government Securities, Money Market Funds, Cash Deposits, Bank Deposits, FDIC, Cash, Cash Equivalents, Physical Gold, Physical Silver, EUR deposits at banks, Euro cash, Government bonds

**`"low"` → `"low"` (stays):**
- USDC (when it IS the reserve, e.g., "USDC liquidity buffer"), tokenized treasuries as one component among others

**`"medium"` → `"very-low"`:**
- Native ETH (e.g., `"ETH", pct: 100`), native BTC (e.g., `"BTC", pct: X` without "delta-neutral" or "short" in the slice name)

**`"medium"` → `"low"`:**
- ETH LSTs (wstETH, rETH, stETH, cbETH, weETH), sDAI, USDC, USDT, pyUSD (when used as reserve component), BUIDL, USTB, USYC, tokenized treasuries, money market fund tokens, EURC, major stablecoins, Aave/Compound deposit positions (blue-chip DeFi)

**`"medium"` → `"medium"` (stays):**
- Wrapped BTC (WBTC, tBTC, cbBTC, FBTC, BTCB), wrapped ETH (WETH), sUSDe, established DeFi vault tokens, transparent tokenized RWAs, delta-neutral positions with BTC/ETH on major venues, physical gold tokens (PAXG, XAUt — custodied commodity)

**`"medium"` → `"high"`:**
- Alt-chain tokens used as collateral (BNB, SOL, DOT, TRX, SUI, XTZ, HYPE, CELO), delta-neutral with altcoins, opaque/poorly-audited RWAs, Asian bond funds, private credit

**`"high"` → `"high"` (stays):**
- Alt-L1 LSTs (slisBNB, JitoSOL, vDOT), bridged altcoins, complex DeFi yield (Pendle PT, Curve Lend vaults, Fraxlend), LP tokens, BTC LSTs (SolvBTC, LBTC, pumpBTC), delta-neutral perp strategies, opaque custody

**`"high"` → `"very-high"`:**
- Governance tokens (CRV, GNO, SNX, INV, UNI), algorithmic stabilization, opaque/exotic (Russian ruble deposits at sanctioned banks, First Digital Trust opaque), leveraged DeFi (GM tokens, xSUSHI), BMMF Turkey FX arb, HYPE/kHYPE

**Step 2: After full migration, verify build**

Run: `npx tsc --noEmit`
Expected: PASS — all `risk` values now match the 5-tier type.

**Step 3: Commit**

```
refactor(reserves): migrate ~374 curated reserve slices to 5-tier risk

Re-classify all reserve slices from 3-tier (low/medium/high) to 5-tier
(very-low/low/medium/high/very-high) system measuring counterparty risk.
```

---

### Task 5: Add collateral quality scoring from reserves

**Files:**
- Modify: `src/lib/report-cards.ts:211-321`
- Modify: `src/lib/types.ts` (add `ReserveSlice` to report-cards imports if needed)

**Step 1: Add the score map and computation function**

After the existing `COLLATERAL_QUALITY_SCORE` map (line 217), add:

```typescript
import type { ReserveRisk, ReserveSlice } from "./types";

const RESERVE_QUALITY_SCORE: Record<ReserveRisk, number> = {
  "very-low": 100,
  low: 75,
  medium: 50,
  high: 25,
  "very-high": 5,
};

const COLLATERAL_QUALITY_DISPLAY: [number, string][] = [
  [88, "Very low risk"],
  [62, "Low risk"],
  [37, "Medium risk"],
  [15, "High risk"],
  [0, "Very high risk"],
];

export function computeCollateralQualityFromReserves(reserves: ReserveSlice[]): number {
  const totalPct = reserves.reduce((s, r) => s + r.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce(
    (s, r) => s + r.pct * RESERVE_QUALITY_SCORE[r.risk],
    0,
  );
  return Math.round(weighted / totalPct);
}

function collateralScoreLabel(score: number): string {
  for (const [threshold, label] of COLLATERAL_QUALITY_DISPLAY) {
    if (score >= threshold) return label;
  }
  return "Very high risk";
}
```

**Step 2: Update scoreResilience() to use computed score**

Replace lines 304-315 of `scoreResilience()`:

```typescript
  const chainScore = CHAIN_RISK_SCORE[factors.chainRisk];
  const custodyScore = CUSTODY_MODEL_SCORE[factors.custodyModel];

  // Prefer computed score from curated reserves; fall back to enum
  const hasReserves = meta.reserves && meta.reserves.length > 0;
  const collateralScore = hasReserves
    ? computeCollateralQualityFromReserves(meta.reserves!)
    : COLLATERAL_QUALITY_SCORE[factors.collateralQuality];
  const collateralLabel = hasReserves
    ? collateralScoreLabel(collateralScore)
    : COLLATERAL_QUALITY_LABEL[factors.collateralQuality];

  const score = Math.round(
    (chainScore + collateralScore + custodyScore + blacklistScore) / 4,
  );

  const parts = [
    `Chain: ${CHAIN_RISK_LABEL[factors.chainRisk]} (${chainScore})`,
    `Collateral: ${collateralLabel} (${collateralScore})`,
    `Custody: ${CUSTODY_MODEL_LABEL[factors.custodyModel]} (${custodyScore})`,
    `Blacklist: ${blacklistLabel} (${blacklistScore})`,
  ];
```

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```
feat(scoring): derive collateral quality from reserve composition

Coins with curated reserves now get a weighted-average collateral
quality score (0-100) computed from their 5-tier reserve slices.
Coins without reserves fall back to the existing enum inference.
```

---

### Task 6: Add build-time drift validation

**Files:**
- Modify: `src/lib/report-cards.ts` (add validation function, exported)

**Step 1: Add the validation function**

After `computeCollateralQualityFromReserves`, add:

```typescript
/**
 * Detect drift between computed reserve quality and enum classification.
 * Returns warnings for coins where the two disagree by more than 30 points.
 * Run during build or as a manual audit.
 */
export function validateCollateralQualityDrift(
  coins: StablecoinMeta[],
): string[] {
  const warnings: string[] = [];
  for (const coin of coins) {
    if (!coin.reserves || coin.reserves.length === 0) continue;
    const computed = computeCollateralQualityFromReserves(coin.reserves);
    const factors = resolveResilienceFactors(coin);
    const enumScore = COLLATERAL_QUALITY_SCORE[factors.collateralQuality];
    const drift = Math.abs(computed - enumScore);
    if (drift > 30) {
      warnings.push(
        `${coin.symbol} (${coin.id}): reserve-derived=${computed}, enum=${enumScore}, drift=${drift}`,
      );
    }
  }
  return warnings;
}
```

Note: This function is exported for use in scripts/tests but is not called automatically during build. It can be invoked manually or integrated into CI later.

**Step 2: Verify build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```
feat(scoring): add collateral quality drift validation
```

---

### Task 7: Create migration audit log

**Files:**
- Create: `docs/plans/2026-02-27-reserve-tier-migration-log.md`

**Step 1: Generate the log**

Write a script or manually produce a table with columns:
- Coin symbol
- Slice name
- Old tier (low/medium/high)
- New tier (very-low/low/medium/high/very-high)

Only include slices that changed tier (not slices that stayed the same, e.g., `medium` → `medium`).

**Step 2: Commit**

```
docs: add reserve tier migration audit log
```

---

### Task 8: Final verification

**Step 1: Full frontend build**

Run: `npm run build`
Expected: PASS — clean build, no type errors, static export succeeds.

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS — worker imports `src/lib/report-cards.ts` and `src/lib/types.ts`.

**Step 3: Spot-check ZCHF score**

After build, verify ZCHF's expected computed score:
- Wrapped Bitcoin 45% × medium(50) = 2250
- ETH/wstETH/LsETH 30% × low(75) = 2250
- Gold tokens 10% × medium(50) = 500
- Tokenized RWAs 10% × high(25) = 250
- Governance tokens 5% × very-high(5) = 25
- Total: 5275 / 100 = **53** (was 20)

**Step 4: Run drift validation manually**

In a Node REPL or one-off script, run `validateCollateralQualityDrift(TRACKED_STABLECOINS)` and review any warnings. Coins with >30 point drift may need their `collateralQuality` enum updated or their reserves re-examined.

**Step 5: Commit any final fixes**

```
chore: final verification and drift fixes
```

---

## Task Dependency Graph

```
Task 1 (type)
  └→ Task 2 (treemap) ─────────┐
  └→ Task 3 (templates) ───────┤
  └→ Task 4 (stablecoins.ts) ──┤ (all three can run in parallel after Task 1)
                                │
                                └→ Task 5 (scoring function) ──→ Task 6 (drift validation)
                                                                         │
                                                                         └→ Task 7 (audit log) ──→ Task 8 (final verify)
```

Tasks 2, 3, 4 can be parallelized. Task 4 is the largest (~374 slice re-classifications).

## Methodology Version

Bump `METHODOLOGY_VERSION` from `"3.2"` to `"3.3"` in `src/lib/report-cards.ts:28` as part of Task 5, since the scoring formula changes.
