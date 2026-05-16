import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

// Known stablecoin tickers that should be linked when referenced in reserves
const KNOWN_TICKERS = ["USDC", "USDT", "DAI", "FRAX", "USDe", "USDtb", "BUIDL", "USDS", "USYC", "OUSG", "DOLA", "GHO", "crvUSD", "FRXUSD", "USD0"];
const REVIEWED_WARNING_IDS = new Map<string, string>([
  [
    "gho-aave::GhoDirectFacilitator GSMs Mainnet::GHO",
    "GHO facilitator labels describe issuance rails, not upstream GHO reserve assets that should inherit coinId linkage.",
  ],
  [
    "gho-aave::CoreGhoDirectMinter::GHO",
    "GHO direct-minter labels describe facilitator issuance rails, not upstream GHO reserve assets that should inherit coinId linkage.",
  ],
  [
    "gho-aave::LidoGhoDirectMinter::GHO",
    "GHO direct-minter labels describe facilitator issuance rails, not upstream GHO reserve assets that should inherit coinId linkage.",
  ],
  [
    "gho-aave::GhoDirectFacilitator Plasma::GHO",
    "GHO facilitator labels describe issuance rails, not upstream GHO reserve assets that should inherit coinId linkage.",
  ],
  [
    "gho-aave::HorizonGhoDirectMinter::GHO",
    "GHO direct-minter labels describe facilitator issuance rails, not upstream GHO reserve assets that should inherit coinId linkage.",
  ],
  [
    "dola-inverse-finance::Stablecoin collateral (sUSDe, sUSDS, scrvUSD)::USDe",
    "DOLA live reserves aggregate multiple stablecoin markets into one mixed collateral bucket, so no single coinId is representative.",
  ],
  [
    "dola-inverse-finance::Stablecoin collateral (sUSDe, sUSDS, scrvUSD)::USDS",
    "DOLA live reserves aggregate multiple stablecoin markets into one mixed collateral bucket, so no single coinId is representative.",
  ],
  [
    "dola-inverse-finance::Stablecoin collateral (sUSDe, sUSDS, scrvUSD)::crvUSD",
    "DOLA live reserves aggregate multiple stablecoin markets into one mixed collateral bucket, so no single coinId is representative.",
  ],
  [
    "xai-silo-finance::Silo ETH and USDC credit-line collateral::USDC",
    "XAI reserve metadata describes a mixed Silo credit-line collateral bucket, so no single stablecoin coinId is representative.",
  ],
  [
    "apxusd-apyx::Cash & Equivalents (USDC, U.S. Treasury Bills)::USDC",
    "apxUSD's cash bucket aggregates USDC and short-duration U.S. Treasury Bills, so no single coinId is representative.",
  ],
  [
    "ist-agoric::Parity Stability Module stablecoin reserves (IBC USDC/USDT/DAI)::USDC",
    "IST's PSM bucket aggregates multiple IBC stablecoins, so no single tracked stablecoin coinId is representative.",
  ],
  [
    "ist-agoric::Parity Stability Module stablecoin reserves (IBC USDC/USDT/DAI)::USDT",
    "IST's PSM bucket aggregates multiple IBC stablecoins, so no single tracked stablecoin coinId is representative.",
  ],
  [
    "ist-agoric::Parity Stability Module stablecoin reserves (IBC USDC/USDT/DAI)::DAI",
    "IST's PSM bucket aggregates multiple IBC stablecoins, so no single tracked stablecoin coinId is representative.",
  ],
  [
    "lvusd-leverup::USDC and MON liquidity-layer collateral::USDC",
    "lvUSD's reserve slice mixes USDC with MON protocol collateral, so no single tracked stablecoin coinId is representative.",
  ],
  [
    "xmd-metal-dollar::USDC, PYUSD, and Paxos dollar stablecoin basket::USDC",
    "XMD's reserve slice aggregates a multi-stablecoin Paxos-dollar basket, so no single tracked stablecoin coinId is representative.",
  ],
  [
    "jpyt-dephaser::Locked USDT on Optimism and USDC on Base::USDC",
    "JPYT uses chain-specific USDT and USDC collateral paths, so no single fixed reserve coinId or weight is representative.",
  ],
  [
    "jpyt-dephaser::Locked USDT on Optimism and USDC on Base::USDT",
    "JPYT uses chain-specific USDT and USDC collateral paths, so no single fixed reserve coinId or weight is representative.",
  ],
  [
    "frax-frax::Intra-protocol Frax-owned tokens (sFRAX, frxUSD, sfrxUSD)::FRAX",
    "FRAX's intra-protocol slice is a mixed self/protocol-owned bucket, not an upstream reserve asset that should inherit a single coinId.",
  ],
  [
    "frax-frax::Intra-protocol Frax-owned tokens (sFRAX, frxUSD, sfrxUSD)::FRXUSD",
    "FRAX's intra-protocol slice mixes frxUSD and related Frax-owned wrappers, so no single tracked coinId is representative.",
  ],
  [
    "frax-frax::Other tokenized assets (BUIDL, USCC, AUSD, JTRSY)::BUIDL",
    "FRAX's other-tokenized-assets slice aggregates BUIDL with USCC, AUSD, and JTRSY, so no single tracked coinId is representative.",
  ],
  [
    "hbusdt-hyperbeat::hoUSDT strategy exposure (Hyperbeat USDT strategy product)::USDT",
    "hoUSDT is a Hyperbeat strategy wrapper that uses USDT underneath rather than a direct USDT reserve, so coinId inheritance is two layers removed and not representative.",
  ],
]);

describe("reserve coinId validation", () => {
  it("no coin has both dependencies and reserve-linked coinIds (unless allowed)", () => {
    // Coins that intentionally use both: dependencies for dependency-map
    // weights and coinId on reserves for blacklist inheritance.
    // USSD is a wrapper of frxUSD (dependencies) but its reserve slices attribute to
    // underlying treasury products (BUIDL/USTB) via coinId for blacklist inheritance.
    const ALLOWED_BOTH = new Set([
      "aa-falconx-mev-capital",
      "dusd-dtrinity",
      "buck-buck-assets",
      "frxusd-frax",
      "ftusd-flying-tulip",
      "susd1plus-lorenzo",
      "ussd-sonic-labs",
    ]);
    const conflicts: string[] = [];
    for (const meta of TRACKED_STABLECOINS) {
      if (ALLOWED_BOTH.has(meta.id)) continue;
      const hasManualDeps = meta.dependencies && meta.dependencies.length > 0;
      const hasLinkedReserves = meta.reserves?.some((r) => r.coinId);
      if (hasManualDeps && hasLinkedReserves) {
        conflicts.push(`${meta.symbol} (${meta.id}): has both dependencies and reserve coinIds`);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("warns about reserve names that look like tracked stablecoins without coinId", () => {
    const warnings: Array<{ id: string; message: string }> = [];
    for (const meta of TRACKED_STABLECOINS) {
      if (!meta.reserves) continue;
      for (const slice of meta.reserves) {
        if (slice.coinId) continue; // already linked
        const upperName = slice.name.toUpperCase();
        for (const ticker of KNOWN_TICKERS) {
          if (upperName.includes(ticker.toUpperCase()) && !upperName.includes("NON-" + ticker.toUpperCase())) {
            warnings.push({
              id: `${meta.id}::${slice.name}::${ticker}`,
              message: `${meta.symbol} (${meta.id}): reserve "${slice.name}" mentions ${ticker} but has no coinId`,
            });
          }
        }
      }
    }

    const unreviewedWarnings = warnings.filter((warning) => !REVIEWED_WARNING_IDS.has(warning.id));
    const staleReviewedEntries = [...REVIEWED_WARNING_IDS.keys()].filter(
      (warningId) => !warnings.some((warning) => warning.id === warningId),
    );

    if (warnings.length > 0) {
      const reviewedLines = warnings
        .filter((warning) => REVIEWED_WARNING_IDS.has(warning.id))
        .map((warning) => `${warning.message}\n  reviewed: ${REVIEWED_WARNING_IDS.get(warning.id)}`);
      console.warn("Reserve slices that may need coinId:\n" + reviewedLines.join("\n"));
    }

    expect(unreviewedWarnings.map((warning) => warning.message)).toEqual([]);
    expect(staleReviewedEntries).toEqual([]);
  });
});
