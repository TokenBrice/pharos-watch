# Reserve Composition: Category-Based Default Templates (Tier C) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a system of default reserve templates based on stablecoin classification (`backing` + `governance` + `pegCurrency`), so that coins without manually curated reserves still show a representative composition treemap. Templates are applied at render time — no changes to `stablecoins.ts` entries.

**Architecture:** Define ~8 reserve templates in a new file `src/lib/reserve-templates.ts`. Add a function `getReserves(coin)` that returns `coin.reserves` if manually set, or falls back to the best-matching template. Update the detail page to use this function and add a visual indicator distinguishing curated vs. estimated reserves. The treemap component itself stays unchanged.

**Tech Stack:** TypeScript, React (minor component update), Tailwind CSS.

---

## Context

### Classification Axes Available

Every coin in `src/lib/stablecoins.ts` has these classification flags:
```typescript
flags: {
  backing: "rwa-backed" | "crypto-backed" | "algorithmic";  // 87 / 53 / 3 coins
  governance: "centralized" | "centralized-dependent" | "decentralized";  // 77 / 56 / 10 coins
  pegCurrency: "USD" | "EUR" | "GOLD" | "SILVER" | "CHF" | ...;  // 22 options
}
```

Additionally, 53 coins have `collateralQuality` and 20 have `custodyModel`.

### Template Design

Crossing `backing × governance` gives 9 combinations, but only ~6 are meaningfully populated:

| Backing | Governance | Count | Template Name |
|---------|-----------|-------|---------------|
| rwa-backed | centralized | ~65 | `rwa-centralized` |
| rwa-backed | centralized-dependent | ~12 | `rwa-cefi-dependent` |
| rwa-backed | decentralized | 0 | (none needed) |
| crypto-backed | centralized | ~2 | `crypto-centralized` |
| crypto-backed | centralized-dependent | ~40 | `crypto-cefi-dependent` |
| crypto-backed | decentralized | ~10 | `crypto-decentralized` |
| algorithmic | centralized-dependent | ~3 | `algorithmic` |

Special overrides for non-USD pegs:
| Peg | Template Override |
|-----|-----------------|
| GOLD | `commodity-gold` |
| SILVER | `commodity-silver` |

---

### Task 1: Create `src/lib/reserve-templates.ts`

**Files:**
- Create: `src/lib/reserve-templates.ts`

**Step 1: Write the failing type-check**

Create the file with just the type signature first:

```typescript
import type { ReserveSlice, StablecoinMeta } from "./types";

export interface ReserveResult {
  reserves: ReserveSlice[];
  estimated: boolean; // true if using template, false if manually curated
}

/**
 * Returns reserve composition for a coin.
 * Uses manually curated data if available, otherwise falls back to a
 * category-based template derived from the coin's classification flags.
 */
export function getReserves(coin: StablecoinMeta): ReserveResult | null {
  // TODO: implement
  return null;
}
```

**Step 2: Run type-check to verify it compiles**

Run: `npm run build`
Expected: Build succeeds (function exists but returns null).

**Step 3: Define the templates**

Add the template definitions above the function:

```typescript
import type { ReserveSlice, StablecoinMeta } from "./types";

export interface ReserveResult {
  reserves: ReserveSlice[];
  estimated: boolean;
}

// ── Default reserve templates by classification ─────────────────────────

const TEMPLATES: Record<string, ReserveSlice[]> = {
  // Centralized fiat-backed (USDC-like): cash + treasuries + repos
  // Typical: regulated issuer holding short-duration government securities
  "rwa-centralized": [
    { name: "U.S. Treasuries / Gov Securities", pct: 70, risk: "low" },
    { name: "Cash & Bank Deposits", pct: 20, risk: "low" },
    { name: "Other Reserves", pct: 10, risk: "medium" },
  ],

  // CeFi-dependent RWA (FRAX v3-like): mix of treasuries + stablecoin PSM
  "rwa-cefi-dependent": [
    { name: "Tokenized Treasuries / RWA", pct: 50, risk: "low" },
    { name: "Stablecoin Reserves (USDC/USDT)", pct: 35, risk: "medium" },
    { name: "Other Assets", pct: 15, risk: "medium" },
  ],

  // Centralized crypto-backed (rare — Aegis YUSD-like): delta-neutral
  "crypto-centralized": [
    { name: "Stablecoins (USDC/USDT)", pct: 40, risk: "medium" },
    { name: "BTC / ETH Positions", pct: 40, risk: "medium" },
    { name: "Other Crypto", pct: 20, risk: "high" },
  ],

  // CeFi-dependent crypto-backed (DAI-like): crypto CDPs + stablecoin PSM
  "crypto-cefi-dependent": [
    { name: "ETH / LSTs", pct: 35, risk: "medium" },
    { name: "Stablecoin Collateral", pct: 30, risk: "medium" },
    { name: "BTC / wBTC", pct: 15, risk: "medium" },
    { name: "Other Vaults / Assets", pct: 20, risk: "high" },
  ],

  // Fully decentralized crypto-backed (LUSD-like): ETH-only CDPs
  "crypto-decentralized": [
    { name: "ETH / LSTs", pct: 80, risk: "medium" },
    { name: "Other On-Chain Collateral", pct: 20, risk: "high" },
  ],

  // Algorithmic: no traditional reserves, seigniorage/stability mechanisms
  "algorithmic": [
    { name: "Protocol-Owned Reserves", pct: 50, risk: "high" },
    { name: "Algorithmic Stabilization", pct: 50, risk: "high" },
  ],

  // Gold-pegged stablecoins
  "commodity-gold": [
    { name: "Physical Gold Bullion", pct: 95, risk: "medium" },
    { name: "Cash / Operational", pct: 5, risk: "low" },
  ],

  // Silver-pegged stablecoins
  "commodity-silver": [
    { name: "Physical Silver Bullion", pct: 95, risk: "medium" },
    { name: "Cash / Operational", pct: 5, risk: "low" },
  ],
};
```

**Step 4: Implement `getReserves`**

```typescript
function templateKey(coin: StablecoinMeta): string | null {
  const { backing, pegCurrency, governance } = coin.flags;

  // Commodity pegs get their own template regardless of other flags
  if (pegCurrency === "GOLD") return "commodity-gold";
  if (pegCurrency === "SILVER") return "commodity-silver";

  // Algorithmic coins share a single template
  if (backing === "algorithmic") return "algorithmic";

  // Cross backing × governance
  const key = `${backing === "rwa-backed" ? "rwa" : "crypto"}-${governance}`;
  return TEMPLATES[key] ? key : null;
}

export function getReserves(coin: StablecoinMeta): ReserveResult | null {
  // Prefer manually curated data
  if (coin.reserves && coin.reserves.length > 0) {
    return { reserves: coin.reserves, estimated: false };
  }

  // Fall back to template
  const key = templateKey(coin);
  if (!key) return null;

  return { reserves: TEMPLATES[key], estimated: true };
}
```

**Step 5: Run type-check**

Run: `npm run build`
Expected: Build succeeds.

**Step 6: Commit**

```bash
git add src/lib/reserve-templates.ts
git commit -m "feat(reserves): add category-based default reserve templates"
```

---

### Task 2: Update the detail page to use `getReserves`

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx:25,378`

**Step 1: Read the current rendering code**

Current code at `src/app/stablecoin/[id]/client.tsx:376-379`:
```tsx
<section id="info">
  <KeyInfoCard meta={coin} />
  {coin.reserves && <ReserveTreemap reserves={coin.reserves} />}
</section>
```

**Step 2: Update import and rendering**

Add import at the top of the file (near line 25):
```typescript
import { getReserves } from "@/lib/reserve-templates";
```

Replace the reserves rendering (line 378) with:
```tsx
<section id="info">
  <KeyInfoCard meta={coin} />
  {(() => {
    const result = getReserves(coin);
    if (!result) return null;
    return (
      <div>
        <ReserveTreemap reserves={result.reserves} />
        {result.estimated && (
          <p className="mt-1 text-center text-xs text-muted-foreground">
            Estimated composition based on {coin.flags.backing.replace("-", " ")} classification
          </p>
        )}
      </div>
    );
  })()}
</section>
```

**Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds.

**Step 4: Visual check**

Run: `npm run dev`

- Visit `/stablecoin/1` (USDT) → treemap shows, NO "Estimated" label
- Visit `/stablecoin/120` (PYUSD) → treemap shows with "Estimated composition based on rwa backed classification" label
- Visit a crypto-backed coin → different template renders
- Visit a gold coin → gold template renders

**Step 5: Commit**

```bash
git add src/app/stablecoin/[id]/client.tsx
git commit -m "feat(reserves): show estimated reserve composition for coins without curated data"
```

---

### Task 3: Refine template selection with `collateralQuality` (optional enhancement)

**Files:**
- Modify: `src/lib/reserve-templates.ts`

For the 53 coins that have `collateralQuality` set, we can pick more specific templates.

**Step 1: Add refined templates**

Add these additional templates to the `TEMPLATES` record:

```typescript
  // CeFi-dependent crypto with RWA-quality collateral (DAI/USDS pattern)
  "crypto-cefi-dependent-rwa": [
    { name: "RWA (Treasuries / Tokenized)", pct: 40, risk: "low" },
    { name: "Stablecoin PSM", pct: 30, risk: "medium" },
    { name: "ETH / LSTs", pct: 20, risk: "medium" },
    { name: "Other Vaults", pct: 10, risk: "high" },
  ],

  // CeFi-dependent crypto with exotic collateral (USDe pattern)
  "crypto-cefi-dependent-exotic": [
    { name: "Delta-Neutral Positions (CEX)", pct: 50, risk: "high" },
    { name: "Stablecoins (USDC/USDT)", pct: 25, risk: "medium" },
    { name: "Volatile Crypto", pct: 25, risk: "high" },
  ],
```

**Step 2: Update `templateKey` to use `collateralQuality`**

```typescript
function templateKey(coin: StablecoinMeta): string | null {
  const { backing, pegCurrency, governance } = coin.flags;

  if (pegCurrency === "GOLD") return "commodity-gold";
  if (pegCurrency === "SILVER") return "commodity-silver";
  if (backing === "algorithmic") return "algorithmic";

  const base = `${backing === "rwa-backed" ? "rwa" : "crypto"}-${governance}`;

  // Refine crypto-cefi-dependent with collateralQuality if available
  if (base === "crypto-centralized-dependent" && coin.collateralQuality) {
    const refined = `${base}-${coin.collateralQuality}`;
    if (TEMPLATES[refined]) return refined;
  }

  return TEMPLATES[base] ? base : null;
}
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add src/lib/reserve-templates.ts
git commit -m "feat(reserves): refine templates using collateralQuality for crypto-backed coins"
```

---

### Task 4: Final verification

**Step 1: Count coverage**

```bash
# Coins with curated reserves
grep -c 'reserves:' src/lib/stablecoins.ts

# Total coins that will show a treemap (curated + template)
# This should be ~140+ (only coins with no matching template will lack a treemap)
```

**Step 2: Build check**

Run: `npm run build`
Expected: Clean build.

**Step 3: Spot-check rendering**

Run: `npm run dev`

Check these representative coins:
- `/stablecoin/1` (USDT) — curated, no "Estimated" label
- `/stablecoin/120` (PYUSD) — rwa-centralized template
- `/stablecoin/118` (GHO) — crypto-cefi-dependent template
- `/stablecoin/269` (BOLD) — crypto-decentralized template
- `/stablecoin/gold-paxg` (PAX Gold) — commodity-gold template
- `/stablecoin/24` (cUSD) — algorithmic template

All should show a treemap. Curated ones should have no label; template ones should say "Estimated composition based on..."

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(reserves): template rendering adjustments"
```

---

## Completion Criteria

- `src/lib/reserve-templates.ts` exists with 8-10 templates covering all `backing × governance` combinations
- `getReserves()` returns curated data when available, template data otherwise
- ~140 coins show a reserve treemap (vs. 5 currently)
- Curated reserves have no label; template reserves show "Estimated composition" disclaimer
- `npm run build` passes
- Visual rendering confirmed on representative coins from each category

## Trade-offs

**Pros:**
- Instant coverage jump from 5 → ~140 coins
- Zero per-coin research effort
- Easy to maintain (update template = update all coins in that category)
- Clear visual distinction between curated and estimated data

**Cons:**
- Templates are generic approximations, not actual reserve data
- Could mislead users if the "Estimated" label isn't prominent enough
- Some coins within a category have very different reserve profiles (e.g., FRAX v3 vs FRXUSD)
- Requires ongoing calibration as the stablecoin market evolves

**Mitigation:** The "Estimated" label is essential. As Tier A (manual) and Tier B (AI research) populate more coins with real data, the template fallback will naturally apply to fewer coins over time.
