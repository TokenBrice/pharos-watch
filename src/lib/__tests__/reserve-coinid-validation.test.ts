import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";

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
    "apxusd-apyx::Cash & Equivalents (USDC, U.S. Treasury Bills)::USDC",
    "apxUSD's cash bucket aggregates USDC and short-duration U.S. Treasury Bills, so no single coinId is representative.",
  ],
  [
    "bnusd-balanced::Cross-chain Hub and Stability Fund collateral (BTC, ETH, BNB, AVAX, INJ, USDC, USDT and other bridged assets)::USDC",
    "Balanced reports this as one mixed Hub/Stability Fund collateral bucket, so a single USDC coinId would overstate the reserve dependency.",
  ],
  [
    "bnusd-balanced::Cross-chain Hub and Stability Fund collateral (BTC, ETH, BNB, AVAX, INJ, USDC, USDT and other bridged assets)::USDT",
    "Balanced reports this as one mixed Hub/Stability Fund collateral bucket, so a single USDT coinId would overstate the reserve dependency.",
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
    "jpyt-dephaser::Locked USDT on Optimism and USDC on Base::USDC",
    "JPYT uses chain-specific USDT and USDC collateral paths, so no single fixed reserve coinId or weight is representative.",
  ],
  [
    "jpyt-dephaser::Locked USDT on Optimism and USDC on Base::USDT",
    "JPYT uses chain-specific USDT and USDC collateral paths, so no single fixed reserve coinId or weight is representative.",
  ],
  [
    "jusd-juicedollar::USDC.e/USDT.e/ctUSD bridge reserves::USDC",
    "JUSD's bridge reserve slice is a de minimis combined USDC.e/USDT.e/ctUSD bucket without stablecoin-level weights, so no single coinId is representative.",
  ],
  [
    "jusd-juicedollar::USDC.e/USDT.e/ctUSD bridge reserves::USDT",
    "JUSD's bridge reserve slice is a de minimis combined USDC.e/USDT.e/ctUSD bucket without stablecoin-level weights, so no single coinId is representative.",
  ],
  [
    "nxusd-nereus::Nereus overcollateralized crypto positions including DAI collateral::DAI",
    "Nereus reports DAI as part of a broader overcollateralized crypto collateral set, so a single DAI coinId would overstate the reserve dependency.",
  ],
  [
    "frax-frax::Protocol-owned FRAX, frxUSD, sFRAX, and sfrxUSD liquidity::FRAX",
    "FRAX's intra-protocol slice is a mixed self/protocol-owned bucket, not an upstream reserve asset that should inherit a single coinId.",
  ],
  [
    "frax-frax::Protocol-owned FRAX, frxUSD, sFRAX, and sfrxUSD liquidity::FRXUSD",
    "FRAX's intra-protocol slice mixes frxUSD and related Frax-owned wrappers, so no single tracked coinId is representative.",
  ],
  [
    "usde-ethena::Liquid Stables (USDtb / USDC / USDT)::USDC",
    "Ethena's public collateral API exposes this as one Liquid Cash bucket rather than stablecoin-level weights, so no single tracked coinId is representative.",
  ],
  [
    "usde-ethena::Liquid Stables (USDtb / USDC / USDT)::USDT",
    "Ethena's public collateral API exposes this as one Liquid Cash bucket rather than stablecoin-level weights, so no single tracked coinId is representative.",
  ],
  [
    "usde-ethena::Liquid Stables (USDtb / USDC / USDT)::USDtb",
    "Ethena's public collateral API exposes this as one Liquid Cash bucket rather than stablecoin-level weights, so no single tracked coinId is representative.",
  ],
  [
    "usdf-falcon::Stablecoins (USDC/USDT)::USDC",
    "The static Falcon reserve mix is a coarse fallback bucket; the live adapter preserves exact asset-level USDC/USDT coinIds when the protocol API is available.",
  ],
  [
    "usdf-falcon::Stablecoins (USDC/USDT)::USDT",
    "The static Falcon reserve mix is a coarse fallback bucket; the live adapter preserves exact asset-level USDC/USDT coinIds when the protocol API is available.",
  ],
  [
    "usg-tangent::Productive DeFi collateral (Curve LP tokens, Pendle PTs, and related LP/yield positions, including material USDC-paired LP exposure)::USDC",
    "USG's static reserve slice is an aggregate productive-collateral bucket; USDC is one paired LP route rather than a separately weighted reserve slice.",
  ],
  [
    "ylds-figure::Digital assets (USDC + USDT, operational)::USDC",
    "YLDS reports this as a de minimis mixed operational digital-asset bucket without stablecoin-level weights.",
  ],
  [
    "ylds-figure::Digital assets (USDC + USDT, operational)::USDT",
    "YLDS reports this as a de minimis mixed operational digital-asset bucket without stablecoin-level weights.",
  ],
  [
    "zeusd-zoth::Tokenized U.S. T-Bills & MMFs (USYC, STBT, TBILL, ZTLN-P)::USYC",
    "ZeUSD reports this as a mixed tokenized T-bill/MMF bucket; current metadata lacks reliable per-asset weights for a single coinId.",
  ],
  [
    "iusd-infinifi::Aave Horizon USDC/RLUSD (institutional pools)::USDC",
    "infiniFi's static fallback groups Aave Horizon USDC and RLUSD into one small mixed bucket; live farm data carries exact coinIds when the source separates positions.",
  ],
  [
    "msusd-metronome::Vesper yield tokens (vaUSDC, vaETH, vaSTETH, vaRETH, vaCBETH)::USDC",
    "Metronome reports this as a mixed Vesper vault-token bucket spanning USDC and ETH-family vaults, so a single USDC coinId would overstate the reserve dependency.",
  ],
  [
    "ceur-celo::Other small reserve assets (axlUSDC, USDT0, WETH)::USDC",
    "EURm reports this as one tiny mixed residual bucket across axlUSDC, USDT0, and WETH, so no single stablecoin coinId is representative.",
  ],
  [
    "ceur-celo::Other small reserve assets (axlUSDC, USDT0, WETH)::USDT",
    "EURm reports this as one tiny mixed residual bucket across axlUSDC, USDT0, and WETH, so no single stablecoin coinId is representative.",
  ],
  [
    "silk-shade-protocol::Stablecoin redemption pools (USDC, other stables)::USDC",
    "SILK reports a mixed stablecoin redemption pool without stable-level weights, so no single tracked stablecoin coinId is representative.",
  ],
  [
    "ntbill-nest::Stablecoin liquidity buffer (USDC / pUSD)::USDC",
    "Nest's static fallback bucket mixes USDC with untracked pUSD; the live positions adapter emits USDC coinId when it sees exact liquid USDC balances.",
  ],
  [
    "vndc-jade-labs::Issuer-disclosed VNDC 2.0 USDT/USDC collateral pools::USDC",
    "VNDC reports this as a mixed issuer-disclosed USDT/USDC collateral pool without stablecoin-level weights, so no single tracked coinId is representative.",
  ],
  [
    "vndc-jade-labs::Issuer-disclosed VNDC 2.0 USDT/USDC collateral pools::USDT",
    "VNDC reports this as a mixed issuer-disclosed USDT/USDC collateral pool without stablecoin-level weights, so no single tracked coinId is representative.",
  ],
  [
    "weusd-picwe::Disputed USDC versus USDT/MOVE backing disclosure::USDC",
    "WEUSD's disclosure notes competing stablecoin exposures, and live adapter data is not yet granular enough to attribute a single upstream stablecoin coinId safely.",
  ],
  [
    "weusd-picwe::Disputed USDC versus USDT/MOVE backing disclosure::USDT",
    "WEUSD's disclosure notes competing stablecoin exposures, and live adapter data is not yet granular enough to attribute a single upstream stablecoin coinId safely.",
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
      "audm-mento",
      "brlm-mento",
      "cadm-mento",
      "chfm-mento",
      "copm-mento",
      "ghsm-mento",
      "kesm-mento",
      "phpm-mento",
      "zarm-mento",
      "dusd-dtrinity",
      "buck-buck-assets",
      "frxusd-frax",
      "ftusd-flying-tulip",
      "gbpm-mento",
      "susd1plus-lorenzo",
      "ussd-sonic-labs",
      "wemix-dollar-wemix",
      "xai-silo-finance",
      "xmd-metal-dollar",
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
