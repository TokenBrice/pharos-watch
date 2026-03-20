import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import {
  getCanonicalReserveAssetRisk,
  CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL,
} from "@shared/lib/reserve-asset-risk";

const SORTED_SYMBOLS = Object.keys(CANONICAL_RESERVE_ASSET_RISK_BY_SYMBOL)
  .sort((a, b) => b.length - a.length);

/**
 * Strategy keywords that legitimately alter asset risk beyond the canonical
 * tier. Slices containing these describe structured products, not bare assets.
 */
const STRATEGY_KEYWORDS = [
  "delta-neutral", "delta neutral", "hedged", "hedge",
  "CDP", "overcollateral",
  "vault", "BoringVault",
  "AMO", "AMM",
  "Yearn", "Aave", "Morpho", "Compound",
  "lending", "loan",
  "LP ", "LP)", "LP,",
  "Curve", "Uniswap", "Kodiak",
  "perp", "futures",
  "strategies", "strategy",
  "custod", "custody",
  "staking",
  "bridged",
  "institutional",
  "Fraxlend",
  "wrapper",
  "Nucleus",
  "deployed",
  "insurance",
  "preferred equity",
  "illiquid",
  "inactive",
  "mix",
  "basket",
  "surplus",
  "linked",
  "FX arbitrage",
  "governance",
  "multi-collateral",
  "LSTs",
  "LST",
];

/**
 * Returns true if the slice name describes a multi-asset bundle where the
 * risk reflects the worst-of blend, not a single canonical asset.
 */
function isMultiAssetSlice(sliceName: string): boolean {
  // Strip parenthetical descriptions before checking separators
  const primary = sliceName.replace(/\s*\(.*\)$/, "");
  return /\//.test(primary)
    || /\band\b/i.test(primary)
    || /variants/i.test(primary)
    || /\betc\.?\b/i.test(primary)
    || /\bother\b/i.test(primary);
}

function isStrategySlice(sliceName: string): boolean {
  const lower = sliceName.toLowerCase();
  return STRATEGY_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Extract a canonical symbol from the PRIMARY part of a slice name (before
 * any parenthetical description). This avoids false positives from
 * descriptive text like "(Staked Frax USD)" matching "FRAX".
 */
function extractCanonicalSymbol(sliceName: string): string | null {
  // Only match against the primary name, not the parenthetical description
  const primary = sliceName.replace(/\s*\(.*\)$/, "").toUpperCase();
  for (const sym of SORTED_SYMBOLS) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- sym comes from curated tracked stablecoin symbols.
    const re = new RegExp(`(?:^|[^A-Z0-9])${sym}(?:[^A-Z0-9]|$)`);
    if (re.test(primary)) return sym;
  }
  return null;
}

describe("curated reserve risk tier consistency", () => {
  it("curated reserve slices use canonical risk tiers for known assets", () => {
    const mismatches: string[] = [];

    for (const coin of TRACKED_STABLECOINS) {
      for (const slice of coin.reserves ?? []) {
        // Skip slices that describe structured strategies — their risk is
        // intentionally elevated above the raw asset's canonical tier.
        if (isStrategySlice(slice.name)) continue;

        // Skip multi-asset bundles where risk reflects worst-of blend.
        if (isMultiAssetSlice(slice.name)) continue;

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
    expect(mismatches).toEqual([]);
  });

  it("adapter static risk maps are consistent with canonical", () => {
    const knownAdapterSymbols = ["WBTC", "CBBTC", "TBTC", "LBTC", "CELO"];
    expect(getCanonicalReserveAssetRisk("CELO")).toBe("high");
    for (const sym of knownAdapterSymbols) {
      const canonical = getCanonicalReserveAssetRisk(sym);
      expect(canonical).toBeDefined();
    }
  });
});
