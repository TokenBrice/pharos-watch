import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

// Known stablecoin tickers that should be linked when referenced in reserves
const KNOWN_TICKERS = ["USDC", "USDT", "DAI", "FRAX", "USDe", "USDtb", "BUIDL", "USDS", "USYC", "OUSG", "DOLA", "GHO", "crvUSD", "FRXUSD", "USD0"];
const REVIEWED_WARNING_IDS = new Map<string, string>([
  [
    "usdu-unitas::JLP (Jupiter Perps LP: BTC, ETH, SOL, USDC basket)::USDC",
    "JLP is a mixed basket reserve slice, not a direct USDC holding.",
  ],
  [
    "dusd-dtrinity::sfrxUSD (Staked Frax USD)::FRAX",
    "dUSD uses dependency modeling for its underlying stablecoin exposure; wrapper slices stay unlinked.",
  ],
  [
    "dusd-dtrinity::sfrxUSD (Staked Frax USD)::FRXUSD",
    "dUSD uses dependency modeling for its underlying stablecoin exposure; wrapper slices stay unlinked.",
  ],
  [
    "dusd-dtrinity::Curve AMO positions (dUSD/sfrxUSD LP)::FRXUSD",
    "Curve AMO LP positions are composite reserves and are intentionally modeled through dependencies instead of direct coin links.",
  ],
  [
    "dusd-dtrinity::frxUSD / DAI / sDAI (Fraxtal)::DAI",
    "Fraxtal reserve slice is a multi-asset basket already covered by dependency weights.",
  ],
  [
    "dusd-dtrinity::frxUSD / DAI / sDAI (Fraxtal)::FRAX",
    "Fraxtal reserve slice is a multi-asset basket already covered by dependency weights.",
  ],
  [
    "dusd-dtrinity::frxUSD / DAI / sDAI (Fraxtal)::FRXUSD",
    "Fraxtal reserve slice is a multi-asset basket already covered by dependency weights.",
  ],
  [
    "dusd-dtrinity::vbUSDT / vbUSDC (Katana Vault Bridge)::USDC",
    "Katana Vault Bridge reserve slice is a wrapper basket and should not mix dependency modeling with direct links.",
  ],
  [
    "dusd-dtrinity::vbUSDT / vbUSDC (Katana Vault Bridge)::USDT",
    "Katana Vault Bridge reserve slice is a wrapper basket and should not mix dependency modeling with direct links.",
  ],
  [
    "dusd-dtrinity::sUSDS (Sky Savings Rate)::USDS",
    "sUSDS is a yield-bearing wrapper and the coin already tracks stablecoin exposure through dependencies.",
  ],
  [
    "ftusd-flying-tulip::USDC (Aave lending positions)::USDC",
    "ftUSD uses dependency modeling for its USDC/USDT collateral exposure.",
  ],
  [
    "ftusd-flying-tulip::USDT (Aave lending positions)::USDT",
    "ftUSD uses dependency modeling for its USDC/USDT collateral exposure.",
  ],
  [
    "silk-shade-protocol::Stablecoin redemption pools (USDC, other stables)::USDC",
    "SILK redemption pools are a mixed basket of stablecoins on Secret Network; no single tracked coinId applies.",
  ],
]);

describe("reserve coinId validation", () => {
  it("no coin has both dependencies and reserve-linked coinIds", () => {
    const conflicts: string[] = [];
    for (const meta of TRACKED_STABLECOINS) {
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
