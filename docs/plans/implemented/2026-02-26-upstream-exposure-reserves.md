# Upstream Exposure Reserves Breakdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the vague "Other (OTHER)" bucket and self-referential coin entries in the Portfolio upstream exposure panel with named collateral categories from each coin's `reserves` data (or `backing` type fallback).

**Architecture:** Enhance `computeUpstreamExposure` in `src/hooks/use-portfolio.ts` to look through each holding to its underlying collateral — using the manually-curated `reserves` field on `StablecoinMeta` where available, or `flags.backing` as a fallback. Add `isCollateral: boolean` to `UpstreamExposure` so the UI can render stablecoin entries differently from collateral entries.

**Tech Stack:** TypeScript strict, React 19, TanStack Query (no API changes needed — all data is already in `src/lib/stablecoins.ts`).

---

### Task 1: Extend UpstreamExposure type and enrich the metadata map

**Files:**
- Modify: `src/hooks/use-portfolio.ts`

**Context:**
- `UpstreamExposure` is defined at the top of the file (line ~23)
- The module-level map `idToMeta` stores `{ name, symbol }` per coin id
- `TRACKED_STABLECOINS` is already imported — each entry has `flags.backing` and `reserves?`
- `ReserveSlice` is defined in `src/lib/types.ts` — import it

**Step 1: Add `ReserveSlice` to the import**

Find this line:
```ts
import type {
  ReportCard,
  DimensionKey,
  ReportCardGrade,
  DependencyWeight,
} from "@/lib/types";
```

Replace with:
```ts
import type {
  ReportCard,
  DimensionKey,
  ReportCardGrade,
  DependencyWeight,
  ReserveSlice,
} from "@/lib/types";
```

**Step 2: Add `isCollateral` to `UpstreamExposure`**

Find:
```ts
export interface UpstreamExposure {
  coinId: string;
  name: string;
  symbol: string;
  usd: number;
  pct: number;
}
```

Replace with:
```ts
export interface UpstreamExposure {
  coinId: string;
  name: string;
  symbol: string;
  usd: number;
  pct: number;
  isCollateral: boolean; // true = non-stablecoin collateral (ETH, T-bills, etc.)
}
```

**Step 3: Replace `idToMeta` with a richer map**

Find the existing module-level block:
```ts
const symbolToId = new Map<string, string>();
const idToSymbol = new Map<string, string>();
const idToMeta = new Map<string, { name: string; symbol: string }>();

for (const coin of TRACKED_STABLECOINS) {
  const lower = coin.symbol.toLowerCase();
  symbolToId.set(lower, coin.id);
  idToSymbol.set(coin.id, lower);
  idToMeta.set(coin.id, { name: coin.name, symbol: coin.symbol });
}
```

Replace with:
```ts
const symbolToId = new Map<string, string>();
const idToSymbol = new Map<string, string>();
const idToMeta = new Map<string, {
  name: string;
  symbol: string;
  backing: string;
  reserves?: ReserveSlice[];
}>();

for (const coin of TRACKED_STABLECOINS) {
  const lower = coin.symbol.toLowerCase();
  symbolToId.set(lower, coin.id);
  idToSymbol.set(coin.id, lower);
  idToMeta.set(coin.id, {
    name: coin.name,
    symbol: coin.symbol,
    backing: coin.flags.backing,
    reserves: coin.reserves,
  });
}
```

**Step 4: Type-check**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run build 2>&1 | tail -20
```

Expected: TypeScript errors about `isCollateral` missing from the objects that construct `UpstreamExposure` — this is expected and will be fixed in Task 2. No other new errors.

---

### Task 2: Replace computeUpstreamExposure with the new algorithm

**Files:**
- Modify: `src/hooks/use-portfolio.ts`

**Context:**

The function `computeUpstreamExposure` currently (lines ~129–201) accumulates everything that isn't a tracked stablecoin into a single `otherUsd` bucket. We replace this with:

- **Case A (no deps, has reserves):** USDT, USDC → distribute the full holding across reserve slices proportionally
- **Case B (no deps, no reserves):** PYUSD, USD1, etc. → one entry per backing type
- **Case C (has deps, has reserves):** DAI, USDS, USDe → stablecoin deps unchanged; remainder goes to non-stablecoin reserve slices (normalized)
- **Case D (has deps, no reserves):** USDD, USDf, etc. → stablecoin deps unchanged; remainder → backing type fallback

A reserve slice is "stablecoin-like" if its name (lowercased) contains any of: `usdc`, `usdt`, `dai`, `usds`, `busd`, `frax`, `stablecoin`, `stable`.

Collateral entries are **aggregated by name** across coins — "ETH / stETH" from USDe and USDS merges into one bar.

**Step 1: Replace `computeUpstreamExposure` entirely**

Find the entire function (from `function computeUpstreamExposure(` to its closing `}`). Replace it with:

```ts
// ---------------------------------------------------------------------------
// Helpers for reserve-based collateral breakdown
// ---------------------------------------------------------------------------

const STABLECOIN_SLICE_KEYWORDS = ["usdc", "usdt", "dai", "usds", "busd", "frax", "stablecoin", "stable"];

function isStablecoinSlice(name: string): boolean {
  const lower = name.toLowerCase();
  return STABLECOIN_SLICE_KEYWORDS.some((kw) => lower.includes(kw));
}

function collateralKey(name: string): string {
  return `__collateral_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}__`;
}

function backingFallback(backing: string): { name: string; symbol: string } {
  if (backing === "algorithmic") return { name: "Algorithmic Mechanism", symbol: "ALGO" };
  if (backing === "crypto-backed") return { name: "Crypto Collateral", symbol: "CRYPTO" };
  return { name: "Real-World Assets (RWA)", symbol: "RWA" };
}

// ---------------------------------------------------------------------------
// Upstream exposure walker
// ---------------------------------------------------------------------------

function computeUpstreamExposure(
  holdings: PortfolioHolding[],
  cards: ReportCard[],
): UpstreamExposure[] {
  const cardMap = new Map<string, ReportCard>();
  for (const c of cards) cardMap.set(c.id, c);

  // Stablecoin upstream exposure: keyed by tracked coin id
  const stablecoinUsd = new Map<string, number>();
  // Collateral exposure: keyed by slug (same name = same bucket across coins)
  const collateralUsd = new Map<string, { name: string; symbol: string; usd: number }>();

  function addCollateral(name: string, symbol: string, usd: number): void {
    if (usd < 0.01) return;
    const key = collateralKey(name);
    const existing = collateralUsd.get(key);
    if (existing) {
      existing.usd += usd;
    } else {
      collateralUsd.set(key, { name, symbol, usd });
    }
  }

  function applyReservesToRemainder(
    reserves: ReserveSlice[],
    remainderUsd: number,
    backing: string,
  ): void {
    const nonStable = reserves.filter((r) => !isStablecoinSlice(r.name));
    if (nonStable.length === 0) {
      const { name, symbol } = backingFallback(backing);
      addCollateral(name, symbol, remainderUsd);
      return;
    }
    const totalPct = nonStable.reduce((s, r) => s + r.pct, 0);
    for (const slice of nonStable) {
      addCollateral(slice.name, slice.name, remainderUsd * (slice.pct / totalPct));
    }
  }

  for (const holding of holdings) {
    const card = cardMap.get(holding.coinId);
    const deps: DependencyWeight[] = card?.rawInputs?.dependencies ?? [];
    const meta = idToMeta.get(holding.coinId);
    const backing = meta?.backing ?? "rwa-backed";
    const reserves = meta?.reserves;

    if (deps.length === 0) {
      // No stablecoin dependencies — look through to collateral
      if (reserves && reserves.length > 0) {
        const totalPct = reserves.reduce((s, r) => s + r.pct, 0);
        for (const slice of reserves) {
          addCollateral(slice.name, slice.name, holding.amount * (slice.pct / totalPct));
        }
      } else {
        const { name, symbol } = backingFallback(backing);
        addCollateral(name, symbol, holding.amount);
      }
      continue;
    }

    // Has stablecoin dependencies
    let allocatedWeight = 0;
    for (const dep of deps) {
      const depUsd = holding.amount * dep.weight;
      if (idToMeta.has(dep.id)) {
        stablecoinUsd.set(dep.id, (stablecoinUsd.get(dep.id) ?? 0) + depUsd);
      }
      // Untracked deps count toward allocatedWeight but go into remainder
      allocatedWeight += dep.weight;
    }

    const remainder = 1 - allocatedWeight;
    if (remainder > 0.001) {
      const remainderUsd = holding.amount * remainder;
      if (reserves && reserves.length > 0) {
        applyReservesToRemainder(reserves, remainderUsd, backing);
      } else {
        const { name, symbol } = backingFallback(backing);
        addCollateral(name, symbol, remainderUsd);
      }
    }
  }

  const totalUsd = holdings.reduce((s, h) => s + h.amount, 0);
  const result: UpstreamExposure[] = [];

  for (const [coinId, usd] of stablecoinUsd) {
    const meta = idToMeta.get(coinId);
    if (!meta) continue;
    result.push({
      coinId,
      name: meta.name,
      symbol: meta.symbol,
      usd,
      pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
      isCollateral: false,
    });
  }

  for (const [key, { name, symbol, usd }] of collateralUsd) {
    result.push({
      coinId: key,
      name,
      symbol,
      usd,
      pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
      isCollateral: true,
    });
  }

  // Stablecoin entries first (most actionable risk), then collateral; descending USD within each group
  result.sort((a, b) => {
    if (a.isCollateral !== b.isCollateral) return a.isCollateral ? 1 : -1;
    return b.usd - a.usd;
  });

  return result;
}
```

**Step 2: Type-check**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run build 2>&1 | tail -20
```

Expected: the only remaining error is in `client.tsx` where `ExposureBar` doesn't yet accept `isCollateral`. All hook logic should compile cleanly.

**Step 3: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add src/hooks/use-portfolio.ts
git commit -m "feat(portfolio): look through holdings to reserve-level collateral in upstream exposure"
```

---

### Task 3: Update ExposureBar and call site in portfolio client

**Files:**
- Modify: `src/app/portfolio/client.tsx`

**Context:**

`ExposureBar` (lines ~155–195) currently shows:
- Blue bar for all entries
- Amber warning when `isWarning` (pct > 80%)
- `name (symbol)` label

New behaviour:
- **Stablecoin entries** (`!isCollateral`): blue bar, amber warning if pct > 80%
- **Collateral entries** (`isCollateral`): teal bar (`bg-teal-500/50`), no warning, no `(symbol)` suffix

The call site (line ~448) passes `isWarning={exp.pct > 80}` — add `isCollateral={exp.isCollateral}`.

**Step 1: Update `ExposureBar` props and rendering**

Find:
```tsx
function ExposureBar({
  name,
  symbol,
  usd,
  pct,
  isWarning,
}: {
  name: string;
  symbol: string;
  usd: number;
  pct: number;
  isWarning: boolean;
}) {
  const widthPct = Math.min(100, Math.round(pct));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate font-medium">
          {name}{" "}
          <span className="text-muted-foreground">({symbol})</span>
          {isWarning && (
            <AlertTriangle className="inline h-3 w-3 ml-1 text-amber-500" />
          )}
        </span>
        <span className="text-muted-foreground ml-2 shrink-0">
          {formatUsd(usd)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={
            isWarning
              ? "h-full rounded-full bg-amber-500/70"
              : "h-full rounded-full bg-blue-500/50"
          }
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}
```

Replace with:
```tsx
function ExposureBar({
  name,
  symbol,
  usd,
  pct,
  isWarning,
  isCollateral,
}: {
  name: string;
  symbol: string;
  usd: number;
  pct: number;
  isWarning: boolean;
  isCollateral: boolean;
}) {
  const widthPct = Math.min(100, Math.round(pct));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate font-medium">
          {name}
          {!isCollateral && (
            <span className="text-muted-foreground"> ({symbol})</span>
          )}
          {isWarning && (
            <AlertTriangle className="inline h-3 w-3 ml-1 text-amber-500" />
          )}
        </span>
        <span className="text-muted-foreground ml-2 shrink-0">
          {formatUsd(usd)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={
            isCollateral
              ? "h-full rounded-full bg-teal-500/50"
              : isWarning
                ? "h-full rounded-full bg-amber-500/70"
                : "h-full rounded-full bg-blue-500/50"
          }
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}
```

**Step 2: Update the call site**

Find:
```tsx
                    {portfolio.upstreamExposure.map((exp) => (
                      <ExposureBar
                        key={exp.coinId}
                        name={exp.name}
                        symbol={exp.symbol}
                        usd={exp.usd}
                        pct={exp.pct}
                        isWarning={exp.pct > 80}
                      />
                    ))}
```

Replace with:
```tsx
                    {portfolio.upstreamExposure.map((exp) => (
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
```

Also update the amber alert banner condition (the `some()` check below the list):

Find:
```tsx
                  {portfolio.upstreamExposure.some((e) => e.pct > 80) && (
```

Replace with:
```tsx
                  {portfolio.upstreamExposure.some((e) => !e.isCollateral && e.pct > 80) && (
```

**Step 3: Full build**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run build 2>&1 | tail -20
```

Expected: clean build, no TypeScript errors.

**Step 4: Commit**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add src/app/portfolio/client.tsx
git commit -m "feat(portfolio): render collateral entries in teal, suppress symbol label"
```

---

### Task 4: Final verification

**Step 1: Run dev server**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run dev
```

**Step 2: Navigate to `/portfolio` and add test holdings**

Add a mix of:
- **USDC** ($50,000) — no deps, has reserves → should show T-bills, Repos, Cash in teal
- **DAI** ($30,000) — 35% USDC dep, has reserves → USDC entry (blue) + RWA/ETH/WBTC entries (teal)
- **USDe** ($20,000) — 30% stablecoin deps, has reserves → USDT+USDC entries (blue) + ETH/BTC/SOL entries (teal)

**Expected result:**
- No "Other (OTHER)" entry
- No coin appearing as its own upstream exposure (e.g., USDC showing as "USD Coin (USDC)")
- Teal bars for collateral: "U.S. Treasuries", "U.S. Treasury Bills", "ETH / stETH", "BTC", etc.
- Blue bars for stablecoin deps: "USD Coin (USDC)", "Tether (USDT)"
- Amber warning only fires when a stablecoin entry exceeds 80%

**Step 3: Commit design docs**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git add docs/plans/2026-02-26-upstream-exposure-reserves-design.md docs/plans/2026-02-26-upstream-exposure-reserves.md
git commit -m "docs: add upstream exposure reserves breakdown design and plan"
```
