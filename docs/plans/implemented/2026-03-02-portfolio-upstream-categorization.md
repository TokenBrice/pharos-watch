# Portfolio Upstream Exposure Categorization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate the portfolio upstream exposure list into canonical risk categories (U.S. Treasury Bills, ETH/LSTs, BTC, etc.) with a "Show detail / Show summary" toggle, defaulting to the categorized view.

**Architecture:** Add a `categorizeCollateral(name)` pure function driven by an ordered regex table, a `computeGroupedExposure` aggregator that collapses raw collateral entries by category while leaving stablecoin dependency entries untouched, expose `upstreamExposureGrouped` from `usePortfolio`, and wire a local toggle in the portfolio UI.

**Tech Stack:** TypeScript, React, Vitest (tests), Next.js 16 (static export)

---

## Task 1: Add `categorizeCollateral` with tests

**Files:**
- Modify: `src/hooks/use-portfolio.ts`
- Create: `src/__tests__/portfolio-categorize.test.ts`

### Step 1: Write the failing tests

Create `src/__tests__/portfolio-categorize.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { categorizeCollateral } from "@/hooks/use-portfolio";

describe("categorizeCollateral", () => {
  it("maps T-bill variants to U.S. Treasury Bills", () => {
    expect(categorizeCollateral("Short-term U.S. Treasury bills")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("BlackRock BUIDL (U.S. T-Bills, cash, repos)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("Hashnote USYC (tokenized T-bills/reverse repos)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("Superstate USTB (tokenized T-bills)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("wM / U.S. Treasury Bills (via M0 Protocol)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("Overnight reverse repos (secured by Treasuries)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("OpenEden TBILL tokens (tokenized U.S. T-bills)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("Money market funds (Fidelity / Amundi)")).toBe("U.S. Treasury Bills");
  });

  it("maps cash deposit variants to USD Cash Deposits", () => {
    expect(categorizeCollateral("Cash deposits (JP Morgan, Lead Bank)")).toBe("USD Cash Deposits");
    expect(categorizeCollateral("USD cash deposits at BNY Mellon (segregated)")).toBe("USD Cash Deposits");
    expect(categorizeCollateral("Cash and cash equivalents")).toBe("USD Cash Deposits");
  });

  it("maps ETH variants to ETH / Liquid Staking", () => {
    expect(categorizeCollateral("ETH (overcollateralized CDP)")).toBe("ETH / Liquid Staking");
    expect(categorizeCollateral("wstETH (Lido)")).toBe("ETH / Liquid Staking");
    expect(categorizeCollateral("WETH (wrapped Ether)")).toBe("ETH / Liquid Staking");
    expect(categorizeCollateral("ETH / wstETH / LsETH")).toBe("ETH / Liquid Staking");
  });

  it("maps BTC variants to Bitcoin (BTC)", () => {
    expect(categorizeCollateral("Bitcoin (BTC) — native and wrapped variants (tBTC, WBTC, SolvBTC, cbBTC)")).toBe("Bitcoin (BTC)");
    expect(categorizeCollateral("WBTC / cbBTC / kBTC (wrapped Bitcoin variants)")).toBe("Bitcoin (BTC)");
    expect(categorizeCollateral("BTC (delta-neutral)")).toBe("Bitcoin (BTC)");
  });

  it("maps perp/delta-neutral variants to Delta-Neutral Positions", () => {
    expect(categorizeCollateral("Delta-neutral ETH basis trade positions (via sUSDe/USDe)")).toBe("Delta-Neutral Positions");
    expect(categorizeCollateral("Perpetual short futures positions (CEX via Ceffu custody)")).toBe("Delta-Neutral Positions");
    expect(categorizeCollateral("Short perp margin (Copper/Ceffu off-exchange)")).toBe("Delta-Neutral Positions");
    expect(categorizeCollateral("BTC-margined perpetual futures (short positions)")).toBe("Delta-Neutral Positions");
  });

  it("maps gold variants to Physical Gold", () => {
    expect(categorizeCollateral("Physical gold bars (LBMA Good Delivery, Brink's London vaults)")).toBe("Physical Gold");
    expect(categorizeCollateral("Physical gold bullion (LBMA-approved, ABX/Brink's/Loomis vaults)")).toBe("Physical Gold");
  });

  it("maps silver to Physical Silver", () => {
    expect(categorizeCollateral("Physical silver bullion (999 fine, ABX global vaults)")).toBe("Physical Silver");
  });

  it("maps EUR/European assets correctly", () => {
    expect(categorizeCollateral("Euro bank deposits (CRR credit institutions, EU)")).toBe("EUR / European Assets");
    expect(categorizeCollateral("EUR bank deposits (Arion Bank, LHV Bank)")).toBe("EUR / European Assets");
  });

  it("maps DeFi positions to DeFi Collateral", () => {
    expect(categorizeCollateral("Morpho vaults (Ethereum, Base, Arbitrum, Unichain)")).toBe("DeFi Collateral");
    expect(categorizeCollateral("Pendle PT/LP positions (leveraged DeFi yield)")).toBe("DeFi Collateral");
    expect(categorizeCollateral("Curve USDC/USDU LP tokens")).toBe("DeFi Collateral");
  });

  it("maps altcoins to Other Crypto", () => {
    expect(categorizeCollateral("Long AVAX spot positions")).toBe("Other Crypto");
    expect(categorizeCollateral("DOT")).toBe("Other Crypto");
    expect(categorizeCollateral("SUI (native token CDPs)")).toBe("Other Crypto");
  });

  it("falls back to Other RWA for unrecognized names", () => {
    expect(categorizeCollateral("U.S. private credit ABS (SMB receivables)")).toBe("Other RWA");
    expect(categorizeCollateral("Asian sovereign bonds (BBB+ min)")).toBe("Other RWA");
    expect(categorizeCollateral("Something completely unknown")).toBe("Other RWA");
  });
});
```

### Step 2: Run tests to confirm they fail

```bash
npm test -- portfolio-categorize
```

Expected: FAIL — `categorizeCollateral` not exported

### Step 3: Add `COLLATERAL_CATEGORIES` and `categorizeCollateral` to `use-portfolio.ts`

Insert after the `backingFallback` function (around line 156), before the upstream exposure walker comment:

```typescript
// ---------------------------------------------------------------------------
// Collateral category lookup
// ---------------------------------------------------------------------------

const COLLATERAL_CATEGORIES: Array<{ pattern: RegExp; label: string }> = [
  // Most specific first
  {
    pattern: /treasury|t-bill|tbill|buidl|usyc|ustb|openeden|repo|money.market|wm.*m0|m0.*wm|ishares.*treasury|government.money.market/i,
    label: "U.S. Treasury Bills",
  },
  {
    pattern: /cash.deposit|bank.deposit|cash.equivalent|fiat.usd|bny.mellon|usd.*bank|segregated.*cash|cash.*custody|cash.in.bankrupt/i,
    label: "USD Cash Deposits",
  },
  {
    pattern: /\bweth\b|wsteth|steth|lseth|\breth\b|liquid.*stak.*eth|eth.*liquid|\beth\b/i,
    label: "ETH / Liquid Staking",
  },
  {
    pattern: /\bbtc\b|bitcoin|wbtc|cbbtc|tbtc|fbtc|solvbtc|kbtc|ubtc/i,
    label: "Bitcoin (BTC)",
  },
  {
    pattern: /delta.neutral|perpetual|\bperp\b|basis.trad|short.futures|short.perp|funding.trad/i,
    label: "Delta-Neutral Positions",
  },
  {
    pattern: /\bgold\b|lbma|bullion|pamp.*gold|tokenized.*gold/i,
    label: "Physical Gold",
  },
  {
    pattern: /silver/i,
    label: "Physical Silver",
  },
  {
    pattern: /\beur\b|euro.*deposit|euro.*bond|eu.*gov|european.*asset|societe.generale|arion.bank|lhv.bank|swissquote|flowbank/i,
    label: "EUR / European Assets",
  },
  {
    pattern: /morpho|aave|euler|pendle|curve.*lp|yearn|lp.token|lending.position|vault.share|fraxlend|compound/i,
    label: "DeFi Collateral",
  },
  {
    pattern: /\bsol\b|\bbnb\b|\bavax\b|\bdot\b|\bsui\b|\bxtz\b|\bhype\b|\bsnx\b/i,
    label: "Other Crypto",
  },
];

export function categorizeCollateral(name: string): string {
  for (const { pattern, label } of COLLATERAL_CATEGORIES) {
    if (pattern.test(name)) return label;
  }
  return "Other RWA";
}
```

### Step 4: Run tests again

```bash
npm test -- portfolio-categorize
```

Expected: All tests PASS. If any fail, adjust the regex in the category that's failing — check the pattern against the actual slice name.

### Step 5: Commit

```bash
git add src/hooks/use-portfolio.ts src/__tests__/portfolio-categorize.test.ts
git commit -m "feat(portfolio): add collateral categorization lookup table with tests"
```

---

## Task 2: Add `computeGroupedExposure` with tests

**Files:**
- Modify: `src/hooks/use-portfolio.ts`
- Modify: `src/__tests__/portfolio-categorize.test.ts`

### Step 1: Write the failing tests

Append to `src/__tests__/portfolio-categorize.test.ts`:

```typescript
import { computeGroupedExposure } from "@/hooks/use-portfolio";
import type { UpstreamExposure } from "@/hooks/use-portfolio";

describe("computeGroupedExposure", () => {
  const totalUsd = 100_000;

  it("collapses multiple T-bill collateral entries into one", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__collateral_buidl__", name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)", symbol: "BUIDL", usd: 30_000, pct: 30, isCollateral: true },
      { coinId: "__collateral_wm__", name: "wM / U.S. Treasury Bills (via M0 Protocol)", symbol: "wM", usd: 20_000, pct: 20, isCollateral: true },
      { coinId: "__collateral_ustb__", name: "Superstate USTB (tokenized T-bills)", symbol: "USTB", usd: 10_000, pct: 10, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, totalUsd);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].name).toBe("U.S. Treasury Bills");
    expect(grouped[0].usd).toBe(60_000);
    expect(grouped[0].pct).toBeCloseTo(60);
    expect(grouped[0].isCollateral).toBe(true);
  });

  it("passes stablecoin entries (isCollateral: false) through unchanged", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "2", name: "USD Coin", symbol: "USDC", usd: 50_000, pct: 50, isCollateral: false },
      { coinId: "__collateral_buidl__", name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)", symbol: "BUIDL", usd: 50_000, pct: 50, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, totalUsd);
    const stableEntry = grouped.find((e) => !e.isCollateral);
    expect(stableEntry?.symbol).toBe("USDC");
    expect(stableEntry?.usd).toBe(50_000);
  });

  it("keeps collateral entries from different categories separate", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__collateral_tbills__", name: "Short-term U.S. Treasury bills", symbol: "T-Bills", usd: 40_000, pct: 40, isCollateral: true },
      { coinId: "__collateral_eth__", name: "wstETH (Lido)", symbol: "wstETH", usd: 60_000, pct: 60, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, totalUsd);
    expect(grouped).toHaveLength(2);
    expect(grouped.map((e) => e.name).sort()).toEqual(["ETH / Liquid Staking", "U.S. Treasury Bills"].sort());
  });

  it("returns entries sorted stablecoins first then collateral descending by usd", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__c_eth__", name: "ETH (overcollateralized CDP)", symbol: "ETH", usd: 10_000, pct: 10, isCollateral: true },
      { coinId: "2", name: "USD Coin", symbol: "USDC", usd: 40_000, pct: 40, isCollateral: false },
      { coinId: "__c_tbills__", name: "Short-term U.S. Treasury bills", symbol: "T-Bills", usd: 50_000, pct: 50, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, totalUsd);
    expect(grouped[0].isCollateral).toBe(false);   // USDC first
    expect(grouped[1].name).toBe("U.S. Treasury Bills"); // largest collateral second
    expect(grouped[2].name).toBe("ETH / Liquid Staking");
  });

  it("recalculates pct based on totalUsd", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__c_t__", name: "Short-term U.S. Treasury bills", symbol: "T-Bills", usd: 25_000, pct: 25, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, 100_000);
    expect(grouped[0].pct).toBeCloseTo(25);
  });
});
```

### Step 2: Run tests to confirm they fail

```bash
npm test -- portfolio-categorize
```

Expected: FAIL — `computeGroupedExposure` not exported

### Step 3: Implement `computeGroupedExposure` in `use-portfolio.ts`

Add after `categorizeCollateral`, still before the upstream exposure walker section:

```typescript
export function computeGroupedExposure(
  raw: UpstreamExposure[],
  totalUsd: number,
): UpstreamExposure[] {
  // Stablecoin entries pass through unchanged
  const stablecoinEntries = raw.filter((e) => !e.isCollateral);

  // Collateral entries: collapse by category
  const categoryMap = new Map<string, { usd: number }>();
  for (const entry of raw) {
    if (entry.isCollateral) {
      const category = categorizeCollateral(entry.name);
      const existing = categoryMap.get(category);
      if (existing) {
        existing.usd += entry.usd;
      } else {
        categoryMap.set(category, { usd: entry.usd });
      }
    }
  }

  const collateralEntries: UpstreamExposure[] = Array.from(categoryMap.entries()).map(
    ([category, { usd }]) => ({
      coinId: `__category_${category.toLowerCase().replace(/[^a-z0-9]/g, "_")}__`,
      name: category,
      symbol: category,
      usd,
      pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
      isCollateral: true,
    }),
  );

  // Stablecoins first, then collateral sorted descending by USD
  collateralEntries.sort((a, b) => b.usd - a.usd);
  return [...stablecoinEntries, ...collateralEntries];
}
```

### Step 4: Run tests

```bash
npm test -- portfolio-categorize
```

Expected: All tests PASS.

### Step 5: Commit

```bash
git add src/hooks/use-portfolio.ts src/__tests__/portfolio-categorize.test.ts
git commit -m "feat(portfolio): add computeGroupedExposure collateral aggregator with tests"
```

---

## Task 3: Expose `upstreamExposureGrouped` from `usePortfolio`

**Files:**
- Modify: `src/hooks/use-portfolio.ts`

### Step 1: Add to `PortfolioState` interface

In the `PortfolioState` interface (around line 33), add one line:

```typescript
upstreamExposureGrouped: UpstreamExposure[];
```

Place it directly after `upstreamExposure: UpstreamExposure[];`.

### Step 2: Add computation in the hook's `useMemo`

The existing upstream exposure memo (around line 409):

```typescript
const upstreamExposure = useMemo(
  () => (cards ? computeUpstreamExposure(holdings, cards) : []),
  [holdings, cards],
);
```

Add immediately after it:

```typescript
const upstreamExposureGrouped = useMemo(
  () => computeGroupedExposure(upstreamExposure, totalUsd),
  [upstreamExposure, totalUsd],
);
```

### Step 3: Add to return object

In the `return` statement at the bottom of `usePortfolio`, add `upstreamExposureGrouped` next to `upstreamExposure`:

```typescript
return {
  holdings,
  totalUsd,
  portfolioGrade,
  portfolioScore,
  dimensionScores,
  upstreamExposure,
  upstreamExposureGrouped,  // ← add this
  isFromUrl,
  addCoin,
  removeCoin,
  setAmount,
  clearAll,
  shareUrl,
};
```

### Step 4: Build to check types

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: No type errors. If TypeScript complains about `PortfolioState`, verify the interface update was saved correctly.

### Step 5: Commit

```bash
git add src/hooks/use-portfolio.ts
git commit -m "feat(portfolio): expose upstreamExposureGrouped from usePortfolio hook"
```

---

## Task 4: Wire the toggle in the portfolio UI

**Files:**
- Modify: `src/app/portfolio/client.tsx`

### Step 1: Add the toggle state

Find the `CompareClient`/`PortfolioClient` function body (look for existing `useState` calls near the top of the component). Add:

```typescript
const [showUpstreamDetail, setShowUpstreamDetail] = useState(false);
```

### Step 2: Replace the upstream exposure section header and data source

Find this block (around line 423–450):

```tsx
{portfolio.upstreamExposure.length > 0 && (
  <div>
    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
      Upstream Exposure
    </h3>
    <div className="space-y-3">
      {portfolio.upstreamExposure.map((exp) => (
        <ExposureBar
          key={exp.coinId}
          ...
        />
      ))}
    </div>
    {portfolio.upstreamExposure.some((e) => !e.isCollateral && e.pct > 80) && (
      ...warning banner...
    )}
  </div>
)}
```

Replace with:

```tsx
{(portfolio.upstreamExposureGrouped.length > 0 || portfolio.upstreamExposure.length > 0) && (
  <div>
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Upstream Exposure
      </h3>
      <button
        onClick={() => setShowUpstreamDetail((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {showUpstreamDetail ? "Show summary" : "Show detail"}
      </button>
    </div>
    {(() => {
      const exposureToShow = showUpstreamDetail
        ? portfolio.upstreamExposure
        : portfolio.upstreamExposureGrouped;
      return (
        <>
          <div className="space-y-3">
            {exposureToShow.map((exp) => (
              <ExposureBar
                key={exp.coinId}
                name={exp.name}
                symbol={exp.symbol}
                usd={exp.usd}
                pct={exp.pct}
                isWarning={!exp.isCollateral && exp.pct > 80}
                isCollateral={exp.isCollateral}
              />
            ))}
          </div>
          {exposureToShow.some((e) => !e.isCollateral && e.pct > 80) && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                High concentration: a single upstream stablecoin accounts for over 80% of
                your portfolio exposure.
              </span>
            </div>
          )}
        </>
      );
    })()}
  </div>
)}
```

### Step 3: Build

```bash
npm run build 2>&1 | tail -15
```

Expected: Clean build, no errors.

### Step 4: Manual smoke test

```bash
npm run dev
```

Open `http://localhost:3000/portfolio`. Add USDT + USDC + USDe + USDS to the portfolio with any amounts. Verify:
- Default view shows ~3–5 category bars (U.S. Treasury Bills dominant, possibly Delta-Neutral Positions, ETH/LSTs, etc.)
- "Show detail" toggle switches to the granular per-slice view (current behavior)
- "Show summary" toggles back
- Warning banner still appears if any stablecoin dep exceeds 80%

### Step 5: Commit

```bash
git add src/app/portfolio/client.tsx
git commit -m "feat(portfolio): categorized upstream exposure with summary/detail toggle"
```

---

## Task 5: Final verification and push

### Step 1: Run full test suite

```bash
npm test
```

Expected: All tests pass including the new `portfolio-categorize` suite.

### Step 2: Full build

```bash
npm run build
```

Expected: Clean build, zero TypeScript errors.

### Step 3: Push

```bash
git push
```
