# Design: Categorized Upstream Exposure on Portfolio Page

**Date:** 2026-03-02
**Status:** Approved
**Goal:** Consolidate the "Upstream Exposure" section on `/portfolio` into meaningful risk categories so users can see that holding multiple stablecoins often means holding the same underlying collateral type under different branding.

---

## Problem

The upstream exposure walker (`computeUpstreamExposure`) produces one entry per unique reserve slice name. Because slice names are highly granular and inconsistent across coins (e.g. "BlackRock BUIDL (U.S. T-Bills, cash, repos)", "wM / U.S. Treasury Bills (via M0 Protocol)", "Superstate USTB (tokenized T-bills)", "Short-term U.S. Treasury bills"), a portfolio holding USDT + USDC + USDS + USDe can display 10–15 individual T-bill entries that are functionally identical. This obscures the key insight: most USD stablecoins are ultimately backed by the same small set of asset classes.

---

## Approach: Pattern-Matching Categorization (Option A)

No changes to `stablecoins.ts` or the `ReserveSlice` type. A lookup table in `use-portfolio.ts` maps slice names to canonical category labels via ordered regex patterns. The existing computation logic is reused; only the bucket key changes from the raw slice name to the matched category.

Stablecoin dependency entries (`isCollateral: false`) are **not** categorized — they retain individual granularity since they represent specific protocol counterparty risk.

---

## Category Definitions

Ordered by match priority (more specific before more general):

| Category Label | Regex Patterns (case-insensitive) |
|---|---|
| U.S. Treasury Bills | `treasury`, `t-bill`, `tbill`, `buidl`, `usyc`, `ustb`, `openeden`, `tbill`, `repo`, `overnight repo`, `reverse repo`, `money.market`, `wm.*m0`, `m0.*wm`, `iShares.*treasury`, `short.*treasury`, `government.*bond` |
| USD Cash Deposits | `cash deposit`, `bank deposit`, `cash equivalent`, `fiat usd`, `bny mellon`, `usd.*bank`, `segregated.*cash`, `cash.*custody` |
| ETH / Liquid Staking | `\bweth\b`, `wsteth`, `steth`, `lseth`, `\breth\b`, `liquid.*stak.*eth`, `eth.*liquid`, `\beth\b` |
| Bitcoin (BTC) | `\bbtc\b`, `bitcoin`, `wbtc`, `cbbtc`, `tbtc`, `fbtc`, `solvbtc`, `kbtc`, `ubtc` |
| Delta-Neutral Positions | `delta.neutral`, `perpetual`, `\bperp\b`, `basis.trad`, `short.futures`, `short.perp`, `funding.trad` |
| Physical Gold | `\bgold\b`, `lbma`, `bullion`, `pamp.*gold`, `tokenized.*gold` |
| Physical Silver | `silver` |
| EUR / European Assets | `\beur\b`, `euro.*deposit`, `euro.*bond`, `eu.*gov`, `european.*asset`, `societe.generale`, `arion.bank`, `lhv.bank`, `swissquote`, `flowbank` |
| DeFi Collateral | `morpho`, `aave`, `euler`, `pendle`, `curve`, `yearn`, `lp.token`, `lending.position`, `vault.share`, `fraxlend`, `compound` |
| Other Crypto | `\bsol\b`, `\bbnb\b`, `\bavax\b`, `\bdot\b`, `\bsui\b`, `\bxtz\b`, `\bhype\b`, `\bsnx\b`, `\bdoge\b`, `\badaa\b` |
| Other RWA | *(catch-all — anything not matched above)* |

---

## Data Layer Changes — `src/hooks/use-portfolio.ts`

### 1. Add `categorizeCollateral(name: string): string`

```typescript
const COLLATERAL_CATEGORIES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /treasury|t-bill|tbill|buidl|usyc|ustb|openeden|repo|overnight.repo|reverse.repo|money.market|wm.*m0|m0.*wm|ishares.*treasury|short.*treasury|government.*bond/i, label: "U.S. Treasury Bills" },
  { pattern: /cash.deposit|bank.deposit|cash.equivalent|fiat.usd|bny.mellon|usd.*bank|segregated.*cash|cash.*custody/i, label: "USD Cash Deposits" },
  { pattern: /\bweth\b|wsteth|steth|lseth|\breth\b|liquid.*stak.*eth|eth.*liquid|\beth\b/i, label: "ETH / Liquid Staking" },
  { pattern: /\bbtc\b|bitcoin|wbtc|cbbtc|tbtc|fbtc|solvbtc|kbtc|ubtc/i, label: "Bitcoin (BTC)" },
  { pattern: /delta.neutral|perpetual|\bperp\b|basis.trad|short.futures|short.perp|funding.trad/i, label: "Delta-Neutral Positions" },
  { pattern: /\bgold\b|lbma|bullion|pamp.*gold|tokenized.*gold/i, label: "Physical Gold" },
  { pattern: /silver/i, label: "Physical Silver" },
  { pattern: /\beur\b|euro.*deposit|euro.*bond|eu.*gov|european.*asset|societe.generale|arion.bank|lhv.bank|swissquote|flowbank/i, label: "EUR / European Assets" },
  { pattern: /morpho|aave|euler|pendle|curve|yearn|lp.token|lending.position|vault.share|fraxlend|compound/i, label: "DeFi Collateral" },
  { pattern: /\bsol\b|\bbnb\b|\bavax\b|\bdot\b|\bsui\b|\bxtz\b|\bhype\b|\bsnx\b/i, label: "Other Crypto" },
];

function categorizeCollateral(name: string): string {
  for (const { pattern, label } of COLLATERAL_CATEGORIES) {
    if (pattern.test(name)) return label;
  }
  return "Other RWA";
}
```

### 2. Add `computeGroupedExposure(raw: UpstreamExposure[], totalUsd: number): UpstreamExposure[]`

Takes the existing raw exposure array and collapses collateral entries by category. Stablecoin entries (`isCollateral: false`) pass through unchanged. Returns a new array sorted the same way (stablecoin deps first, then collateral by USD descending).

### 3. Update `PortfolioState` interface

Add `upstreamExposureGrouped: UpstreamExposure[]` alongside the existing `upstreamExposure`.

The existing `upstreamExposure` stays unchanged for backwards compatibility (used in detail view).

---

## UI Layer Changes — `src/app/portfolio/client.tsx`

### Toggle state

```tsx
const [showUpstreamDetail, setShowUpstreamDetail] = useState(false);
```

### Section header

```tsx
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
```

### Data source

```tsx
const exposureToShow = showUpstreamDetail
  ? portfolio.upstreamExposure
  : portfolio.upstreamExposureGrouped;
```

`ExposureBar` and the concentration warning banner are passed `exposureToShow` unchanged.

---

## Files Touched

| File | Change |
|---|---|
| `src/hooks/use-portfolio.ts` | Add `COLLATERAL_CATEGORIES`, `categorizeCollateral`, `computeGroupedExposure`; expose `upstreamExposureGrouped` from hook |
| `src/app/portfolio/client.tsx` | Add `showUpstreamDetail` toggle; wire `exposureToShow` |

No changes to `stablecoins.ts`, `types.ts`, or any other file.

---

## Non-Goals

- Categorizing stablecoin dependency entries (`isCollateral: false`) — these stay individual
- Adding `category` field to `ReserveSlice` type or `stablecoins.ts` data
- Changing how `computeUpstreamExposure` builds the raw list
