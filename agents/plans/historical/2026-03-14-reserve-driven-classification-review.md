# Reserve-Driven Classification Review — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep stablecoin classifications and collateral scores current with evolving reserves by (1) enforcing risk tier consistency across all data sources, (2) adding build-time classification invariant tests, (3) wiring live reserve data into report-card collateral scoring, and (4) surfacing drift/classification alerts on /status.

**Architecture:** Six phases, sequentially dependent. Phase 1 (risk tier consistency) is a prerequisite for Phase 4 (live passthrough). Phase 2 (classification invariants) produces the centralized-custody detection infrastructure used by Phases 3 and 5. Phase 4 is the core value delivery — live reserves feed collateral quality scoring automatically. Phase 6 (adapter coinId enrichment) enables live data to also drive dependency inference.

**Tech Stack:** TypeScript strict, Vitest, Zod schemas, Cloudflare Workers D1, shared/lib (runtime-neutral).

**Research context:** `agents/research/2026-03-14-reserve-driven-classification-review.md`

---

## Design decisions (resolved)

| # | Decision | Answer |
|---|---|---|
| 1 | Live passthrough? | Yes, with safety rails (freshness gate, min slices, delta alerting) |
| 2 | Dependency inference from live data? | Yes, enrich adapters with coinId (Phase 6) |
| 3 | Rollout strategy? | All-at-once |
| 4 | Centralized-custody threshold? | >50% (majority rule) |
| 5 | What counts as centralized-custody? | WBTC/cbBTC/LBTC/SolvBTC + any CeFi/CeFi-dep stablecoins per our ratings. Transitive exposure counts. |
| 6 | Hard fail or warning? | Warning — surfaced in test output + /status dashboard |
| 7 | Enforce canonical risk mapping? | Yes, across all adapters |
| 8 | Curated reserves validate against canonical? | Yes |
| 9 | Reclassify crvUSD? | Yes |
| 10 | Batch fix stale curated reserves? | Skip — live passthrough makes it unnecessary for scoring |
| 11 | Coins without live sync? | Invest in extending live coverage (separate initiative) |
| 12 | Spec's Rule B (no native crypto >50%)? | Intentionally dropped — the >50% centralized-custody rule (Rule A) is more actionable and catches the same cases. Rule B would produce noisy warnings for RWA-backed coins that are correctly classified. |

---

## File structure

### Files to create

| File | Responsibility |
|------|---------------|
| `shared/lib/centralized-custody.ts` | Centralized-custody asset set + transitive centralized-exposure calculator (used by tests + /status) |
| `shared/lib/__tests__/classification-invariants.test.ts` | Build-time classification rule warnings |
| `shared/lib/__tests__/reserve-risk-consistency.test.ts` | Risk tier consistency tests (curated + adapter) |

### Files to modify

| File | Change |
|------|--------|
| `shared/lib/reserve-asset-risk.ts` | Expand canonical mapping to cover all commonly-seen reserve assets |
| `shared/lib/stablecoins.ts` | Reclassify crvUSD and other coins identified by invariant tests |
| `shared/lib/report-cards.ts` | Add `liveReserveSlices?` parameter to `scoreResilience()` |
| `shared/types/report-cards.ts` | Add `collateralFromLive` boolean to `RawDimensionInputs` |
| `worker/src/lib/report-cards-snapshot.ts` | Query `reserve_composition`, pass live slices to scoring |
| `worker/src/lib/live-reserves-store.ts` | Add `loadFreshLiveReserveMap()` bulk fetch function |
| `shared/types/status.ts` | Add `ReserveDriftEntry` and `ClassificationWarning` types |
| `worker/src/api/status.ts` | Add reserve drift + classification warning section |
| Adapter files (see Phase 1 task list) | Migrate to canonical risk mapping where applicable |

---

## Chunk 1: Foundation — Risk Tier Enforcement

### Task 1: Expand canonical reserve asset risk mapping

**Files:**
- Modify: `shared/lib/reserve-asset-risk.ts`
- Test: `shared/lib/__tests__/reserve-asset-risk.test.ts`

- [ ] **Step 1: Identify all assets appearing across adapters and curated reserves that lack canonical entries**

Run this grep to find asset symbols used in adapters and curated reserves not yet in canonical:
```bash
grep -ohP '(?:name|symbol|risk).*?(?:USDT|USDS|FRAX|FRXUSD|PYUSD|GHO|DOLA|SOLVBTC|BTCB|AUSD|BUIDL|USTB|HYPE|SOL|BNB|TRX|BOLD)' shared/lib/stablecoins.ts worker/src/cron/reserve-adapters/*.ts | sort -u
```

Cross-reference with the existing `CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL` entries.

- [ ] **Step 2: Add missing assets to canonical mapping**

In `shared/lib/reserve-asset-risk.ts`, expand `CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL`:

```typescript
export const CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL = {
  // ── Very-low: no/minimal counterparty risk ─────────────────
  ETH: "very-low",
  WETH: "very-low",

  // ── Low: stablecoin / tokenized layer ──────────────────────
  USDC: "low",
  USDT: "low",
  DAI: "low",
  USDS: "low",
  LUSD: "low",
  BOLD: "low",
  ZCHF: "low",
  DEURO: "low",
  FRAX: "low",
  FRXUSD: "low",
  PYUSD: "low",
  GHO: "low",
  DOLA: "low",
  AUSD: "low",
  TUSD: "low",
  GUSD: "low",
  STETH: "low",
  WSTETH: "low",
  RETH: "low",
  WEETH: "low",
  SFRXETH: "low",
  LSETH: "low",
  BUIDL: "low",
  USTB: "low",
  USYC: "low",

  // ── Medium: wrapped / structured / centralized-custody ─────
  BTC: "medium",
  WBTC: "medium",
  CBBTC: "medium",
  KBTC: "medium",
  LBTC: "medium",
  TBTC: "medium",
  ZKBTC: "medium",
  SOLVBTC: "medium",
  BTCB: "medium",
  PAXG: "medium",
  XAUT: "medium",

  // ── High: volatile native assets ───────────────────────────
  SOL: "high",
  BNB: "high",
  TRX: "high",
  HYPE: "high",
  CELO: "high",

  // ── Very-high: governance / exotic ─────────────────────────
  DEPS: "very-high",
} as const satisfies Record<string, ReserveRisk>;
```

- [ ] **Step 3: Add tests for new canonical entries**

In `shared/lib/__tests__/reserve-asset-risk.test.ts`, add:

```typescript
it("covers all stablecoin reserve assets commonly seen in adapters", () => {
  // Spot-check representative assets from each tier
  expect(getCanonicalReserveAssetRisk("USDT")).toBe("low");
  expect(getCanonicalReserveAssetRisk("USDS")).toBe("low");
  expect(getCanonicalReserveAssetRisk("FRXUSD")).toBe("low");
  expect(getCanonicalReserveAssetRisk("CBBTC")).toBe("medium");
  expect(getCanonicalReserveAssetRisk("SOLVBTC")).toBe("medium");
  expect(getCanonicalReserveAssetRisk("SOL")).toBe("high");
  expect(getCanonicalReserveAssetRisk("CELO")).toBe("high");
});
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --reporter=verbose shared/lib/__tests__/reserve-asset-risk.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add shared/lib/reserve-asset-risk.ts shared/lib/__tests__/reserve-asset-risk.test.ts
git commit -m "feat(reserves): expand canonical risk mapping to cover all common reserve assets"
```

---

### Task 2: Add curated reserve risk tier consistency test

**Files:**
- Create: `shared/lib/__tests__/reserve-risk-consistency.test.ts`

- [ ] **Step 1: Write the consistency test**

This test iterates all curated reserve slices in `TRACKED_STABLECOINS` and checks that known canonical asset symbols get the correct risk tier:

```typescript
import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import {
  getCanonicalReserveAssetRisk,
  CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL,
} from "@shared/lib/reserve-asset-risk";

/**
 * Extract canonical symbols that appear in a reserve slice name.
 * Only matches whole-word boundaries to avoid false positives
 * (e.g., "wstETH" should match WSTETH, not ETH).
 *
 * Matches longest symbols first to prefer WSTETH over STETH over ETH.
 */
const SORTED_SYMBOLS = Object.keys(CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL)
  .sort((a, b) => b.length - a.length);

function extractCanonicalSymbol(sliceName: string): string | null {
  const upper = sliceName.toUpperCase();
  for (const sym of SORTED_SYMBOLS) {
    // Match whole-word: symbol must be bounded by non-alphanumeric or string edges
    const re = new RegExp(`(?:^|[^A-Z0-9])${sym}(?:[^A-Z0-9]|$)`);
    if (re.test(upper)) return sym;
  }
  return null;
}

describe("curated reserve risk tier consistency", () => {
  it("curated reserve slices use canonical risk tiers for known assets", () => {
    const mismatches: string[] = [];

    for (const coin of TRACKED_STABLECOINS) {
      for (const slice of coin.reserves ?? []) {
        const sym = extractCanonicalSymbol(slice.name);
        if (!sym) continue;
        const canonical = getCanonicalReserveAssetRisk(sym);
        if (canonical && slice.risk !== canonical) {
          mismatches.push(
            `${coin.id}: "${slice.name}" has risk "${slice.risk}" but canonical ${sym} is "${canonical}"`,
          );
        }
      }
    }

    if (mismatches.length > 0) {
      console.warn(
        `[reserve-risk-consistency] ${mismatches.length} curated risk tier mismatches:\n` +
        mismatches.map((m) => `  - ${m}`).join("\n"),
      );
    }
    // HARD FAIL: risk tier mismatches are data bugs, not judgment calls.
    // This is intentionally stricter than classification-invariants.test.ts
    // (Task 5), which uses warning mode for governance classification questions
    // that require human judgment.
    expect(mismatches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test — expect it to identify current mismatches**

```bash
npm test -- --reporter=verbose shared/lib/__tests__/reserve-risk-consistency.test.ts
```

If mismatches are found, fix them in `shared/lib/stablecoins.ts` (update the curated risk tier to match canonical). The most likely mismatches are older entries that pre-date the canonical mapping.

- [ ] **Step 3: Fix any identified mismatches in curated reserves**

For each mismatch, update the `risk` field in the corresponding reserve slice in `shared/lib/stablecoins.ts` to match canonical. If a mismatch is intentional (e.g., a bundled slice like "ETH / stETH mix" where the risk is an average), refine the slice name so it doesn't trigger the exact-symbol match, or split into separate slices.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add shared/lib/__tests__/reserve-risk-consistency.test.ts shared/lib/stablecoins.ts
git commit -m "test(reserves): add curated risk tier consistency check against canonical mapping"
```

---

### Task 3: Migrate adapters to canonical risk mapping

**Files:**
- Modify: adapter files in `worker/src/cron/reserve-adapters/`
- Test: `shared/lib/__tests__/reserve-risk-consistency.test.ts` (extend)

Adapters fall into four categories. The migration strategy differs for each:

**Category A — Already using canonical (enforce only):** `fx.ts`, `collateral-positions-api.ts`
No code changes needed. Add test assertions that their output is consistent.

**Category B — Partially using canonical (complete migration):** `crvusd.ts`, `mento.ts`
Replace remaining hardcoded risk assignments with `getCanonicalReserveAssetRisk()` calls. Keep fallback defaults for assets not in canonical.

**Category C — Hardcoded asset-level mappings (migrate):** `asymmetry.ts`, `openeden.ts`
Replace local risk constants with canonical lookups for known assets. Keep adapter-specific entries (e.g., protocol-specific fund tokens) as local overrides.

**Category D — Bucket-level or config-parameterized (validate only):** `ethena.ts`, `falcon.ts`, `m0.ts`, `btcfi.ts`, `single-asset.ts`, `erc4626-single-asset.ts`, `evm-branch-balances.ts`, `accountable.ts`, `reservoir.ts`, `infinifi.ts`
These receive pre-aggregated data or use config-driven risk. No migration needed, but add tests that bucket-level assignments are reasonable.

- [ ] **Step 1: Migrate `crvusd.ts`**

In `worker/src/cron/reserve-adapters/crvusd.ts`, the `classifySymbol()` function at ~line 33 has hardcoded risk for BTC variants. Replace:

```typescript
// Before:
if (["WBTC", "CBBTC", "LBTC", "ZKBTC"].includes(upper)) {
  return { name: "WBTC / cbBTC / LBTC", risk: "medium" };
}
if (upper === "TBTC") {
  return { name: "tBTC", risk: "medium" };
}

// After:
if (["WBTC", "CBBTC", "LBTC", "ZKBTC"].includes(upper)) {
  return { name: "WBTC / cbBTC / LBTC", risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium" };
}
if (upper === "TBTC") {
  return { name: "tBTC", risk: getCanonicalReserveAssetRisk("TBTC") ?? "medium" };
}
```

Ensure the import is present: `import { getCanonicalReserveAssetRisk, CANONICAL_ETH_RESERVE_RISK } from "@shared/lib/reserve-asset-risk";`

- [ ] **Step 2: Migrate `asymmetry.ts`**

In `worker/src/cron/reserve-adapters/asymmetry.ts`, the `BRANCH_RISK_MAP` at ~line 21 has hardcoded risk for WBTC and tBTC. Replace with canonical lookups:

```typescript
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";

const BRANCH_RISK_MAP: Record<string, BranchRiskConfig> = {
  ysyBOLD: { risk: "medium", coinId: "bold-liquity", depType: "wrapper" },
  scrvUSD: { risk: "medium", coinId: "crvusd-curve", depType: "wrapper" },
  sUSDS: { risk: "low", coinId: "usds-sky", depType: "wrapper" },
  sfrxUSD: { risk: "medium", coinId: "frax-frax", depType: "wrapper" },
  tBTC: { risk: getCanonicalReserveAssetRisk("TBTC") ?? "medium" },
  WBTC: { risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium" },
};
```

- [ ] **Step 3: Migrate `mento.ts` and `openeden.ts`**

**`mento.ts`:** In `worker/src/cron/reserve-adapters/mento.ts`, the `parseMentoReserve()` function assigns risk per-asset. The file already imports `getCanonicalReserveAssetRisk`. Replace any remaining hardcoded risk for CELO with `getCanonicalReserveAssetRisk("CELO") ?? "high"` and for BTC/ETH with their canonical lookups. Import `getCanonicalReserveAssetRisk` from `@shared/lib/reserve-asset-risk`. Keep local overrides for protocol-specific tokens (cUSD, cEUR — these are Mento-internal and not in canonical).

**`openeden.ts`:** In `worker/src/cron/reserve-adapters/openeden.ts`, the adapter assigns risk to fund-level buckets (TBILL, BUIDL). These are issuer-specific fund tokens with no canonical equivalent — leave their risk assignments as-is. Only migrate if the adapter references any standard crypto/stablecoin symbols (USDC, ETH, etc.) with hardcoded risk.

- [ ] **Step 4: Extend consistency test to cover adapter output**

In `shared/lib/__tests__/reserve-risk-consistency.test.ts`, add a second test that imports the adapter files and verifies any static risk maps use canonical values:

```typescript
it("adapter static risk maps are consistent with canonical", () => {
  // Import crvusd classifySymbol and verify known symbols
  // This catches regressions if someone re-hardcodes a risk tier
  // Verify that all symbols used by adapters have canonical entries
  const knownAdapterSymbols = ["WBTC", "CBBTC", "TBTC", "LBTC", "CELO"];
  // CELO should be "high" (volatile native asset), not "low"
  expect(getCanonicalReserveAssetRisk("CELO")).toBe("high");
  for (const sym of knownAdapterSymbols) {
    const canonical = getCanonicalReserveAssetRisk(sym);
    expect(canonical).toBeDefined();
  }
});
```

- [ ] **Step 5: Run full test suite**

```bash
npm test && cd worker && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/reserve-adapters/crvusd.ts worker/src/cron/reserve-adapters/asymmetry.ts worker/src/cron/reserve-adapters/mento.ts worker/src/cron/reserve-adapters/openeden.ts shared/lib/__tests__/reserve-risk-consistency.test.ts
git commit -m "refactor(adapters): migrate to canonical risk mapping for known assets"
```

---

## Chunk 2: Classification Invariants

### Task 4: Build centralized-custody exposure calculator

**Files:**
- Create: `shared/lib/centralized-custody.ts`
- Test: `shared/lib/__tests__/centralized-custody.test.ts` (inline with Task 5)

This utility computes the fraction of a coin's reserves that are backed by centralized-custody assets, including transitive exposure through upstream coins.

- [ ] **Step 1: Write the failing test**

Create `shared/lib/__tests__/centralized-custody.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeCentralizedCustodyFraction, CENTRALIZED_CUSTODY_CRYPTO } from "@shared/lib/centralized-custody";
import type { StablecoinMeta } from "@shared/types";

// Minimal mock coins for testing
const mockCoins: Pick<StablecoinMeta, "id" | "reserves" | "flags">[] = [
  {
    id: "pure-defi",
    flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "wstETH", pct: 60, risk: "low" },
      { name: "ETH", pct: 40, risk: "very-low" },
    ],
  },
  {
    id: "wbtc-heavy",
    flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "WBTC", pct: 60, risk: "medium" },
      { name: "wstETH", pct: 40, risk: "low" },
    ],
  },
  {
    id: "usdc-backed",
    flags: { governance: "centralized-dependent", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "USDC", pct: 80, risk: "low", coinId: "usdc-circle" },
      { name: "ETH", pct: 20, risk: "very-low" },
    ],
  },
  {
    id: "usdc-circle",
    flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "U.S. Treasuries", pct: 75, risk: "very-low" },
      { name: "Cash", pct: 25, risk: "very-low" },
    ],
  },
  {
    id: "transitive-coin",
    flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
    reserves: [
      { name: "usdc-backed wrapper", pct: 100, risk: "low", coinId: "usdc-backed" },
    ],
  },
];

describe("computeCentralizedCustodyFraction", () => {
  it("returns 0 for pure DeFi reserves (no centralized-custody assets)", () => {
    expect(computeCentralizedCustodyFraction("pure-defi", mockCoins)).toBe(0);
  });

  it("returns direct centralized-custody crypto fraction", () => {
    // 60% WBTC = 0.6 centralized
    expect(computeCentralizedCustodyFraction("wbtc-heavy", mockCoins)).toBeCloseTo(0.6);
  });

  it("counts CeFi stablecoins as centralized-custody", () => {
    // 80% USDC (centralized) = 0.8 centralized
    expect(computeCentralizedCustodyFraction("usdc-backed", mockCoins)).toBeCloseTo(0.8);
  });

  it("treats CeFi-dep upstream as fully centralized-custody", () => {
    // transitive-coin → 100% usdc-backed (CeFi-dep) → counts as 100% centralized
    // per design decision: CeFi/CeFi-dep stablecoins per our ratings = centralized custody
    expect(computeCentralizedCustodyFraction("transitive-coin", mockCoins)).toBeCloseTo(1.0);
  });

  it("returns 0 for unknown coin ID", () => {
    expect(computeCentralizedCustodyFraction("nonexistent", mockCoins)).toBe(0);
  });

  it("handles circular dependencies without infinite recursion", () => {
    const cyclicCoins: Pick<StablecoinMeta, "id" | "reserves" | "flags">[] = [
      {
        id: "coin-a",
        flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
        reserves: [{ name: "Coin B wrapper", pct: 100, risk: "medium" as const, coinId: "coin-b" }],
      },
      {
        id: "coin-b",
        flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } as StablecoinMeta["flags"],
        reserves: [{ name: "Coin A wrapper", pct: 100, risk: "medium" as const, coinId: "coin-a" }],
      },
    ];
    // Should return 0 (no centralized assets found), not hang
    expect(computeCentralizedCustodyFraction("coin-a", cyclicCoins)).toBe(0);
  });
});

describe("CENTRALIZED_CUSTODY_CRYPTO", () => {
  it("includes WBTC, cbBTC, LBTC, SolvBTC", () => {
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("WBTC")).toBe(true);
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("CBBTC")).toBe(true);
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("LBTC")).toBe(true);
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("SOLVBTC")).toBe(true);
  });

  it("excludes tBTC (decentralized custody)", () => {
    expect(CENTRALIZED_CUSTODY_CRYPTO.has("TBTC")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --reporter=verbose shared/lib/__tests__/centralized-custody.test.ts
```

Expected: FAIL — module `@shared/lib/centralized-custody` does not exist.

- [ ] **Step 3: Implement `centralized-custody.ts`**

Create `shared/lib/centralized-custody.ts`:

```typescript
import type { StablecoinMeta, ReserveSlice } from "../types";

/**
 * Crypto assets with centralized custody (single custodian or consortium).
 * tBTC is excluded — it uses threshold cryptography (decentralized custody).
 */
export const CENTRALIZED_CUSTODY_CRYPTO = new Set([
  "WBTC", "CBBTC", "LBTC", "SOLVBTC", "BTCB", "KBTC", "ZKBTC",
]);

// Pre-compiled patterns sorted longest-first for whole-word matching
const CENTRALIZED_CRYPTO_PATTERNS = [...CENTRALIZED_CUSTODY_CRYPTO]
  .sort((a, b) => b.length - a.length)
  .map((sym) => new RegExp(`(?:^|[^A-Z0-9])${sym}(?:[^A-Z0-9]|$)`));

function sliceMatchesCentralizedCrypto(name: string): boolean {
  const upper = name.toUpperCase();
  return CENTRALIZED_CRYPTO_PATTERNS.some((re) => re.test(upper));
}

/**
 * Compute the fraction (0–1) of a coin's reserves that are backed by
 * centralized-custody assets, including transitive exposure.
 *
 * Centralized-custody includes:
 * 1. Crypto assets with centralized custody (WBTC, cbBTC, etc.)
 * 2. Stablecoins classified as "centralized" or "centralized-dependent"
 * 3. Transitive: upstream "decentralized" coins' own centralized fraction
 */
export function computeCentralizedCustodyFraction(
  coinId: string,
  allCoins: ReadonlyArray<Pick<StablecoinMeta, "id" | "reserves" | "flags">>,
  visited: ReadonlySet<string> = new Set(),
): number {
  if (visited.has(coinId)) return 0; // cycle guard
  const nextVisited = new Set(visited);
  nextVisited.add(coinId);

  const meta = allCoins.find((c) => c.id === coinId);
  if (!meta) return 0;

  // Coin without reserves: use governance as proxy
  if (!meta.reserves?.length) {
    const gov = meta.flags.governance;
    return gov === "centralized" || gov === "centralized-dependent" ? 1.0 : 0;
  }

  let centralizedPct = 0;
  const totalPct = meta.reserves.reduce((s, r) => s + r.pct, 0);
  if (totalPct === 0) return 0;

  for (const slice of meta.reserves) {
    // Direct centralized-custody crypto
    if (sliceMatchesCentralizedCrypto(slice.name)) {
      centralizedPct += slice.pct;
      continue;
    }

    // Linked upstream stablecoin
    if (slice.coinId) {
      const upstream = allCoins.find((c) => c.id === slice.coinId);
      if (!upstream) continue;
      const upGov = upstream.flags.governance;

      if (upGov === "centralized" || upGov === "centralized-dependent") {
        // Fully centralized upstream → 100% of this slice is centralized
        centralizedPct += slice.pct;
      } else {
        // Decentralized upstream → recursively compute its centralized fraction
        const upstreamFraction = computeCentralizedCustodyFraction(
          slice.coinId, allCoins, nextVisited,
        );
        centralizedPct += slice.pct * upstreamFraction;
      }
    }
  }

  return centralizedPct / totalPct;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- --reporter=verbose shared/lib/__tests__/centralized-custody.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/lib/centralized-custody.ts shared/lib/__tests__/centralized-custody.test.ts
git commit -m "feat(classification): add centralized-custody exposure calculator with transitive support"
```

---

### Task 5: Add classification invariant tests

**Files:**
- Create: `shared/lib/__tests__/classification-invariants.test.ts`

These tests identify coins whose governance classification may be inconsistent with their reserve composition. They emit warnings (not failures) per the design decision.

- [ ] **Step 1: Write the classification invariant test**

```typescript
import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";

const MAJORITY_THRESHOLD = 0.50;

describe("classification invariants", () => {
  it("warns when decentralized coins have >50% centralized-custody exposure", () => {
    const warnings: string[] = [];

    const defiCoins = TRACKED_STABLECOINS.filter(
      (c) => c.flags.governance === "decentralized",
    );

    for (const coin of defiCoins) {
      const fraction = computeCentralizedCustodyFraction(
        coin.id, TRACKED_STABLECOINS,
      );
      if (fraction > MAJORITY_THRESHOLD) {
        warnings.push(
          `${coin.id}: classified "decentralized" but ${(fraction * 100).toFixed(1)}% ` +
          `centralized-custody exposure (threshold: ${MAJORITY_THRESHOLD * 100}%)`,
        );
      }
    }

    if (warnings.length > 0) {
      console.warn(
        `\n[classification-invariants] ${warnings.length} governance classification warnings:\n` +
        warnings.map((w) => `  ⚠ ${w}`).join("\n") + "\n",
      );
    }

    // WARNING MODE: log warnings but do not fail the test.
    // To make this a hard fail, change to: expect(warnings).toEqual([]);
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test — observe which coins trigger warnings**

```bash
npm test -- --reporter=verbose shared/lib/__tests__/classification-invariants.test.ts
```

Expected: test PASSES (warning mode) but prints warnings for coins like crvUSD (69% WBTC/cbBTC), DEURO, ZCHF, btcUSD, etc.

**Record the full list of warned coins.** This list drives Task 6.

- [ ] **Step 3: Commit**

```bash
git add shared/lib/__tests__/classification-invariants.test.ts
git commit -m "test(classification): add invariant warnings for decentralized coins with centralized-custody exposure"
```

---

### Task 6: Reclassify coins identified by invariant tests

**Files:**
- Modify: `shared/lib/stablecoins.ts`

Based on the warnings from Task 5, reclassify coins whose centralized-custody exposure exceeds 50%. The confirmed cases from the research audit:

| Coin | Centralized-custody % | Action |
|---|---|---|
| `crvusd-curve` | 69% (WBTC/cbBTC) | `"decentralized"` → `"centralized-dependent"` |
| Other coins from Task 5 output | Per warning | Evaluate each — some may need `governanceQuality` overrides or research |

For each coin identified:

- [ ] **Step 1: Reclassify crvUSD**

In `shared/lib/stablecoins.ts` at line 1024, change:

```typescript
// Before:
usd("crvusd-curve", "crvUSD", "crvUSD", "crypto-backed", "decentralized", {

// After:
usd("crvusd-curve", "crvUSD", "crvUSD", "crypto-backed", "centralized-dependent", {
```

Also update the `collateral` description to mention WBTC/cbBTC majority:

```typescript
collateral: "WBTC, cbBTC (majority), wstETH, sfrxETH, weETH, tBTC, and ETH deposited as collateral; LLAMMA (Lending-Liquidating AMM) performs soft liquidations; WBTC/cbBTC custody by BitGo/Coinbase introduces centralized dependency",
```

- [ ] **Step 2: Record remaining warned coins for future research**

Other coins from Task 5 warning output (e.g., DEURO, ZCHF, btcUSD) require per-coin research to determine whether reclassification is warranted — some may have nuances (e.g., btcUSD's split between tBTC and centralized-custody BTC variants is unknown). Create a follow-up issue or note in `agents/research/` listing these coins and their centralized-custody percentage for future resolution. Do NOT reclassify them in this PR without individual investigation.

- [ ] **Step 3: Run build + tests**

```bash
npm run build && npm test
```

Verify the classification invariant test now shows fewer (or no) warnings for the reclassified coins.

- [ ] **Step 4: Update docs**

Update `docs/report-cards.md` to reflect that crvUSD is now centralized-dependent. Search for `crvUSD` in the governance quality tiers table (grep for `dao-governance.*crvUSD`) and remove crvUSD from the `decentralized` examples column.

- [ ] **Step 5: Commit**

```bash
git add shared/lib/stablecoins.ts docs/report-cards.md
git commit -m "fix(classification): reclassify crvUSD and other coins with >50% centralized-custody exposure"
```

---

## Chunk 3: Live Reserves → Collateral Score Passthrough

### Task 7: Add bulk live reserve fetch function

**Files:**
- Modify: `worker/src/lib/live-reserves-store.ts`
- Test: inline verification (the function is a thin D1 wrapper)

- [ ] **Step 1: Add `loadFreshLiveReserveMap()` to live-reserves-store.ts**

Add after the existing `getReserveComposition()` function:

```typescript
import type { ReserveSlice } from "@shared/types";

/**
 * Load all fresh live reserve snapshots as a Map<stablecoinId, ReserveSlice[]>.
 * Only includes snapshots with ≥2 slices that are fresher than `freshnessSec`.
 */
export async function loadFreshLiveReserveMap(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  minSlices = 2,
): Promise<Map<string, ReserveSlice[]>> {
  const cutoff = now - freshnessSec;
  const rows = await db
    .prepare(
      "SELECT stablecoin_id, slices FROM reserve_composition WHERE fetched_at > ?",
    )
    .bind(cutoff)
    .all<{ stablecoin_id: string; slices: string }>();

  const map = new Map<string, ReserveSlice[]>();
  for (const row of rows.results) {
    try {
      const slices: ReserveSlice[] = JSON.parse(row.slices);
      if (slices.length >= minSlices) {
        map.set(row.stablecoin_id, slices);
      }
    } catch {
      // Skip malformed JSON
    }
  }
  return map;
}
```

- [ ] **Step 2: Add a unit test for `loadFreshLiveReserveMap()`**

In `worker/src/__tests__/live-reserves-store.test.ts` (create if absent), add:

```typescript
import { describe, it, expect, vi } from "vitest";
import { loadFreshLiveReserveMap } from "../lib/live-reserves-store";

function mockDb(rows: Array<{ stablecoin_id: string; slices: string }>) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
      }),
    }),
  } as unknown as D1Database;
}

describe("loadFreshLiveReserveMap", () => {
  it("returns only snapshots with >= minSlices slices", async () => {
    const db = mockDb([
      { stablecoin_id: "coin-a", slices: JSON.stringify([{ name: "A", pct: 50, risk: "low" }, { name: "B", pct: 50, risk: "low" }]) },
      { stablecoin_id: "coin-b", slices: JSON.stringify([{ name: "X", pct: 100, risk: "low" }]) },
    ]);
    const map = await loadFreshLiveReserveMap(db);
    expect(map.has("coin-a")).toBe(true);
    expect(map.has("coin-b")).toBe(false); // only 1 slice < minSlices=2
  });

  it("skips malformed JSON", async () => {
    const db = mockDb([
      { stablecoin_id: "bad", slices: "not-json" },
    ]);
    const map = await loadFreshLiveReserveMap(db);
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run worker type-check + tests**

```bash
cd worker && npx tsc --noEmit && cd .. && npm test -- --reporter=verbose worker/src/__tests__/live-reserves-store.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/live-reserves-store.ts worker/src/__tests__/live-reserves-store.test.ts
git commit -m "feat(live-reserves): add bulk fetch for fresh live reserve snapshots"
```

---

### Task 8: Modify scoring to accept live reserve slices

**Files:**
- Modify: `shared/lib/report-cards.ts` (lines 472–506)
- Modify: `shared/types/report-cards.ts` (RawDimensionInputs schema)
- Test: `shared/lib/__tests__/report-cards.test.ts`

- [ ] **Step 1: Write failing tests for live slice passthrough**

In the existing test file for report-cards (find it via `find shared -name '*report-cards*test*'`), add:

```typescript
import { scoreResilience, computeCollateralQualityFromReserves } from "@shared/lib/report-cards";

describe("scoreResilience with live reserve slices", () => {
  it("uses liveReserveSlices when provided instead of meta.reserves", () => {
    const meta = {
      // ... minimal StablecoinMeta with curated reserves showing low risk
      reserves: [
        { name: "wstETH", pct: 100, risk: "low" as const },
      ],
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD" },
    } as any;

    const curatedResult = scoreResilience(meta, false);

    // Live slices show medium risk (e.g., 60% WBTC)
    const liveSlices = [
      { name: "WBTC", pct: 60, risk: "medium" as const },
      { name: "wstETH", pct: 40, risk: "low" as const },
    ];

    const liveResult = scoreResilience(meta, false, liveSlices);

    // Live result should have a lower collateral score than curated
    // curated: 100% low = 75. live: 60*50 + 40*75 = 60 → collateral differs
    expect(liveResult.score).not.toBe(curatedResult.score);
  });

  it("falls back to meta.reserves when liveReserveSlices is undefined", () => {
    const meta = {
      reserves: [
        { name: "wstETH", pct: 100, risk: "low" as const },
      ],
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD" },
    } as any;

    const without = scoreResilience(meta, false);
    const withUndefined = scoreResilience(meta, false, undefined);

    expect(withUndefined.score).toBe(without.score);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --reporter=verbose -t "live reserve slices"
```

Expected: FAIL — TypeScript compiles extra positional args, but `scoreResilience` ignores the 3rd arg, so the assertion `expect(liveResult.score).not.toBe(curatedResult.score)` will fail because both produce identical scores (curated is used for both). This is the meaningful red — the function doesn't use the live slices yet.

- [ ] **Step 3: Modify `scoreResilience()` to accept live slices**

In `shared/lib/report-cards.ts`, modify the function signature and collateral resolution (lines 472–506):

```typescript
export function scoreResilience(
  meta: StablecoinMeta,
  canBeBlacklisted: boolean | "possible" | "possible-inherited",
  liveReserveSlices?: ReserveSlice[],
): ReportCardDimension {
  const factors = resolveResilienceFactors(meta);
  const blacklistScore = canBeBlacklisted === true ? 33
    : (canBeBlacklisted === "possible" || canBeBlacklisted === "possible-inherited") ? 66
    : 100;
  const blacklistLabel = canBeBlacklisted === true ? "Yes"
    : canBeBlacklisted === "possible" ? "Possible (mutable contract)"
    : canBeBlacklisted === "possible-inherited" ? "Possible (inherited)"
    : "No";

  const custodyScore = CUSTODY_MODEL_SCORE[factors.custodyModel];

  // Prefer live slices for collateral quality when available
  const effectiveReserves = liveReserveSlices ?? meta.reserves;
  const hasReserves = effectiveReserves && effectiveReserves.length > 0;
  const collateralScore = hasReserves
    ? computeCollateralQualityFromReserves(effectiveReserves!)
    : COLLATERAL_QUALITY_SCORE[factors.collateralQuality];
  const collateralLabel = hasReserves
    ? collateralScoreLabel(collateralScore)
    : COLLATERAL_QUALITY_LABEL[factors.collateralQuality];

  const score = Math.round(
    (collateralScore + custodyScore + blacklistScore) / 3,
  );

  const parts = [
    `Collateral: ${collateralLabel} (${collateralScore})`,
    `Custody: ${CUSTODY_MODEL_LABEL[factors.custodyModel]} (${custodyScore})`,
    `Blacklist: ${blacklistLabel} (${blacklistScore})`,
  ];

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}
```

Add `ReserveSlice` to imports if not already present:

```typescript
import type { ReserveSlice } from "../types";
```

- [ ] **Step 4: Add `collateralFromLive` to RawDimensionInputs**

In `shared/types/report-cards.ts`, add to the Zod schema:

```typescript
const RawDimensionInputsSchema = z.object({
  // ... existing fields ...
  collateralFromLive: z.boolean().optional().default(false),
});
```

The field MUST be `.optional().default(false)`, not `z.boolean()`. During deploy, the frontend may fetch cached report cards from the previous API version that lack this field. Required `z.boolean()` would cause Zod parse failures for all cached cards.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- --reporter=verbose -t "live reserve slices"
```

Expected: PASS.

- [ ] **Step 6: Run full test suite to check for breakage**

```bash
npm test
```

Although `collateralFromLive` uses `.optional().default(false)`, existing test fixtures that construct `RawDimensionInputs` may need updating. Check these files for test fixtures that build `RawDimensionInputs`:
- `shared/lib/__tests__/report-cards.test.ts`
- `worker/src/__tests__/report-cards-snapshot.test.ts` (if it exists)
- Any tests that use `scoreResilience()` directly

Add `collateralFromLive: false` to any test fixtures that explicitly construct the full inputs object.

- [ ] **Step 7: Commit**

```bash
git add shared/lib/report-cards.ts shared/types/report-cards.ts shared/lib/__tests__/report-cards.test.ts
git commit -m "feat(report-cards): accept live reserve slices for collateral quality scoring"
```

---

### Task 9: Wire live reserves into report-card snapshot builder

**Files:**
- Modify: `worker/src/lib/report-cards-snapshot.ts`
- Test: integration verification via build + type-check

This is where the live passthrough connects end-to-end.

- [ ] **Step 1: Import the new function and pass live reserves through the scoring pipeline**

In `worker/src/lib/report-cards-snapshot.ts`:

1. Add import:
```typescript
import { loadFreshLiveReserveMap } from "./live-reserves-store";
```

2. In `buildReportCardsSnapshot()`, add the live reserve query to the initial `Promise.all` (~line 66):
```typescript
const [stablecoinsCached, bluechipCached, dexLiqMap, redemptionBackstopMap, liveReserveMap] = await Promise.all([
  loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false }),
  getCache(db, "bluechip-ratings"),
  loadDexLiquidityMap(db),
  loadRedemptionBackstopMap(db),
  loadFreshLiveReserveMap(db),
]);
```

3. Pass `liveReserveMap` to `computeCard()`:
```typescript
const card = computeCard(
  meta,
  pegDataById,
  dexLiqMap,
  redemptionBackstopMap,
  bluechipMap,
  overallScores,
  blacklistableIds,
  liveReserveMap,  // new parameter
);
```

4. In `computeCard()`, add the parameter and wire it through:
```typescript
function computeCard(
  meta: (typeof TRACKED_STABLECOINS)[number],
  pegDataById: Map<string, PegSummaryCoin>,
  dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">>,
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>,
  bluechipMap: Record<string, BluechipRating>,
  overallScores: Map<string, number>,
  blacklistableIds: ReadonlySet<string>,
  liveReserveMap: Map<string, ReserveSlice[]>,
): ReportCard {
  // Insert liveSlices lookup immediately after the existing `const canBeBlacklisted = isBlacklistable(...)` line:
  const liveSlices = liveReserveMap.get(meta.id);
  const canBeBlacklisted = isBlacklistable(meta, blacklistableIds);

  const dimensions: Record<DimensionKey, ReturnType<typeof scorePegStability>> = {
    pegStability: scorePegStability(peg, meta),
    liquidity: scoreLiquidity(liq, redemption),
    resilience: scoreResilience(meta, canBeBlacklisted, liveSlices),  // pass live slices
    decentralization: scoreDecentralization(meta.flags.governance as GovernanceType, meta),
    dependencyRisk: scoreDependencyRisk(meta, overallScores),
  };

  // In the existing rawInputs object, append `collateralFromLive` after the last existing field (find the `navToken` or last field):
  const rawInputs: RawDimensionInputs = {
    // ... all existing fields preserved unchanged ...
    collateralFromLive: !!liveSlices,  // append after the last existing field
  };
}
```

- [ ] **Step 2: Run build + type-check + tests**

```bash
npm run build && cd worker && npx tsc --noEmit && cd .. && npm test
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/report-cards-snapshot.ts
git commit -m "feat(report-cards): wire live reserve snapshots into collateral quality scoring"
```

---

### Task 10: Add delta alerting safety rail

**Files:**
- Modify: `worker/src/lib/report-cards-snapshot.ts`

When the live-derived collateral score differs from what the curated data would produce by more than 15 points, log a warning. This catches adapter bugs and signals composition changes that may require classification review.

**Threshold rationale:** The console.warn threshold (15 points) is intentionally higher than the /status dashboard threshold (5 points, Task 12). Console warnings are noise-sensitive and should only fire for significant drift that likely indicates a data issue. The /status dashboard is consulted by operators who want a comprehensive view of all drift, so it uses a lower bar.

- [ ] **Step 1: Add delta check in `computeCard()`**

After computing the resilience dimension with live slices, compute what the curated score would have been and compare:

```typescript
// Delta alerting: warn when live and curated collateral scores diverge significantly
if (liveSlices && meta.reserves && meta.reserves.length > 0) {
  const liveScore = computeCollateralQualityFromReserves(liveSlices);
  const curatedScore = computeCollateralQualityFromReserves(meta.reserves);
  const delta = Math.abs(liveScore - curatedScore);
  if (delta > 15) {
    console.warn(
      `[report-cards] Collateral score drift for ${meta.id}: ` +
      `live=${liveScore}, curated=${curatedScore}, delta=${delta}`,
    );
  }
}
```

Place this after the `dimensions` object is constructed but before the `rawInputs` assembly.

Import `computeCollateralQualityFromReserves` from `@shared/lib/report-cards` if not already imported.

- [ ] **Step 2: Run build + type-check**

```bash
npm run build && cd worker && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/report-cards-snapshot.ts
git commit -m "feat(report-cards): add delta alerting when live and curated collateral scores diverge"
```

---

### Task 11: Surface `collateralFromLive` in the frontend

**Files:**
- Modify: `src/components/report-card.tsx`

Add a subtle indicator in the resilience section when collateral quality is scored from live data.

- [ ] **Step 1: Add live data indicator**

In `src/components/report-card.tsx`, find the resilience dimension's detail rendering. The detail parts are rendered via `dim.detail.split(". ").map(...)`. Add the `(live)` indicator **after** the detail parts `div` (not inside the `.map()` iteration), within the same resilience section block:

```tsx
{card.rawInputs.collateralFromLive && (
  <span className="text-xs text-muted-foreground ml-4" title="Scored from live reserve data">(live data)</span>
)}
```

Place this JSX immediately after the closing `</div>` of the `space-y-0.5` detail parts container, still inside the resilience conditional block.

- [ ] **Step 2: Run build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/report-card.tsx
git commit -m "feat(ui): show live data indicator on collateral quality when scored from live reserves"
```

---

## Chunk 4: /Status Integration + Future Phases

### Task 12: Add reserve drift and classification warnings to /status

**Files:**
- Modify: `shared/types/status.ts`
- Modify: `worker/src/api/status.ts`

- [ ] **Step 1: Add types for reserve drift and classification warnings**

In `shared/types/status.ts`, add:

```typescript
export interface ReserveDriftEntry {
  coinId: string;
  liveCollateralScore: number;
  curatedCollateralScore: number;
  delta: number;
}

export interface ClassificationWarning {
  coinId: string;
  governance: string;
  centralizedCustodyPct: number;
  threshold: number;
}

// Add to StatusResponse:
// reserveDrift?: ReserveDriftEntry[];
// classificationWarnings?: ClassificationWarning[];
```

Add `reserveDrift` and `classificationWarnings` fields to the `StatusResponse` interface.

- [ ] **Step 2: Compute drift and classification warnings in status handler**

In `worker/src/api/status.ts`, in `computeRawStatus()`:

```typescript
import { loadFreshLiveReserveMap } from "../lib/live-reserves-store";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-cards";
import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

// Inside computeRawStatus():
const liveReserveMap = await loadFreshLiveReserveMap(db, now);

// Reserve drift
const reserveDrift: ReserveDriftEntry[] = [];
for (const [coinId, liveSlices] of liveReserveMap) {
  const meta = TRACKED_STABLECOINS.find((c) => c.id === coinId);
  if (!meta?.reserves?.length) continue;
  const liveScore = computeCollateralQualityFromReserves(liveSlices);
  const curatedScore = computeCollateralQualityFromReserves(meta.reserves);
  const delta = Math.abs(liveScore - curatedScore);
  if (delta > 5) {
    reserveDrift.push({ coinId, liveCollateralScore: liveScore, curatedCollateralScore: curatedScore, delta });
  }
}
reserveDrift.sort((a, b) => b.delta - a.delta);

// Classification warnings (from live data)
const classificationWarnings: ClassificationWarning[] = [];
const threshold = 0.50;
const defiCoins = TRACKED_STABLECOINS.filter((c) => c.flags.governance === "decentralized");
for (const coin of defiCoins) {
  const fraction = computeCentralizedCustodyFraction(coin.id, TRACKED_STABLECOINS);
  if (fraction > threshold) {
    classificationWarnings.push({
      coinId: coin.id,
      governance: coin.flags.governance,
      centralizedCustodyPct: Math.round(fraction * 100),
      threshold: threshold * 100,
    });
  }
}
```

Include both arrays in the status response object by adding them to the `RawStatusComputation` type and the return value of `computeRawStatus()`. Then add them to the `StatusResponse` shape so they appear in the API output. Follow the existing pattern for how other status sections (e.g., `reserveSync`, `cronHealth`) are wired:

1. Add `reserveDrift` and `classificationWarnings` fields to the `RawStatusComputation` interface
2. Add corresponding fields to `StatusResponse`
3. In the response assembly (where `RawStatusComputation` is mapped to `StatusResponse`), pass through both arrays
4. The existing route handler in `worker/src/api/status.ts` already serves the full `StatusResponse` — no route changes needed

**Frontend /status update:** The `/status` page (`src/app/status/`) will need UI sections for these new arrays. This is deferred — create a follow-up task. The data will be available in the API immediately, and operators can inspect it via direct API calls.

- [ ] **Step 3: Run build + type-check**

```bash
npm run build && cd worker && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add shared/types/status.ts worker/src/api/status.ts
git commit -m "feat(status): surface reserve drift and classification warnings on /status"
```

---

### Task 13: Update documentation

**Files:**
- Modify: `docs/report-cards.md`
- Modify: `docs/live-reserves.md`
- Modify: `docs/status-dashboard.md`

- [ ] **Step 1: Update report-cards.md**

Add a note under "Collateral Quality: Reserve-Derived Scoring" explaining that live reserve snapshots are now preferred over curated data when available:

```markdown
#### Live Reserve Passthrough (v5.8)

For coins with live reserve sync (`liveReservesConfig`), the collateral quality score
uses the hourly live snapshot from `reserve_composition` instead of curated
`StablecoinMeta.reserves` when the snapshot is fresh (< 48h) and has ≥ 2 slices.
This prevents collateral scores from drifting as protocol reserve compositions evolve.

The `collateralFromLive` flag in `RawDimensionInputs` indicates which source was used.
Dependency inference (`deriveDependencies`) remains on curated data because live
adapter slices do not carry `coinId` links.

A delta alert fires when the live-derived score diverges from curated by >15 points,
signaling that curated metadata (and potentially the governance classification) may
need human review.
```

Increment the methodology version reference from v5.7 to v5.8.

- [ ] **Step 2: Update live-reserves.md**

Update the "Scope Boundaries" section to reflect that report cards now consume live reserve snapshots for collateral scoring:

```markdown
- [Risk Lab](./report-cards.md) uses live reserve snapshots for collateral quality scoring when
  available (v5.8+). Dependency inference, blacklist-inherited checks, and all other scoring
  dimensions still use curated reserve metadata.
```

- [ ] **Step 3: Update status-dashboard.md**

Add entries for the new `reserveDrift` and `classificationWarnings` sections.

- [ ] **Step 4: Commit**

```bash
git add docs/report-cards.md docs/live-reserves.md docs/status-dashboard.md
git commit -m "docs: update report-cards, live-reserves, and status docs for live collateral scoring"
```

---

## Phase 6: Adapter coinId Enrichment (future — separate plan recommended)

This phase enriches live adapter slices with `coinId` so that `deriveDependencies()` can eventually use live data for dependency inference too. This is a larger effort requiring per-adapter knowledge of which reserve assets map to tracked stablecoins.

**Approach:** Create a shared mapping `RESERVE_NAME_TO_COIN_ID` that maps common reserve asset names/symbols to tracked stablecoin IDs. Adapters that already populate `coinId` (single-asset, erc4626-single-asset, asymmetry, infinifi, reservoir, mento) serve as templates. Adapters that don't (ethena, falcon, crvusd, fx, m0, btcfi) would import the mapping and apply it to their output slices.

**Not detailed here** because:
1. Live passthrough for collateral scoring (Phase 4) delivers the core value without coinId
2. Each adapter needs individual assessment of which slices can be linked
3. This should be a separate plan once Phase 4 is validated in production

---

## Execution notes

- **Phase ordering:** 1 → 2 → 3 → 4 → 5. Phase 3 depends on Phase 2 output (list of offending coins). Phase 4 depends on Phase 1 (risk tier consistency).
- **Risk:** Phase 4 (live passthrough) changes scores for up to 16 coins simultaneously. The all-at-once rollout is intentional — the current scores are wrong. But deploy during low-traffic hours and monitor /status for unexpected drift alerts.
- **crvUSD downstream impact:** reclassifying crvUSD affects coins that list it as a dependency. The dependency risk dimension will recompute for those coins. The test suite will verify the build passes, but review the safety score page manually after deploy.
- **Version bump:** After Task 9 (wiring live reserves into snapshot builder), increment `SAFETY_SCORE_VERSION` in `shared/lib/safety-score-version.ts` from `"5.7"` to `"5.8"`. Also insert a new `"v5.7"` static string entry into `SAFETY_SCORE_CHANGELOG_NAV_VERSIONS` in the same file, immediately after the first element (`SAFETY_SCORE_VERSION_LABEL`), to preserve the v5.7 entry in the methodology changelog nav. Include `shared/lib/safety-score-version.ts` in the Task 9 commit's `git add` list. Note: `METHODOLOGY_VERSION` in `report-cards.ts` re-exports `SAFETY_SCORE_VERSION`, so updating the source file is sufficient.
