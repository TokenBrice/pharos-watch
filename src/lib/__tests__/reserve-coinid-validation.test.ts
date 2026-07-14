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
    "frax-frax::FRAX held on the Frax balance sheet::FRAX",
    "FRAX held on its own balance sheet is subject self exposure, not an upstream dependency edge.",
  ],
  [
    "frax-frax::sFRAX::FRAX",
    "sFRAX is a staked claim on FRAX and remains subject self exposure rather than an upstream dependency edge.",
  ],
  [
    "susdt-spark::USDT deposited in Spark Savings vault::USDT",
    "Spark does not publish the current spUSDT-specific split between idle USDT and downstream strategies.",
  ],
  [
    "susdc-spark::USDC deposited in Spark Savings vault::USDC",
    "Spark does not publish the current spUSDC-specific split between idle USDC and downstream strategies.",
  ],
  [
    "usx-solstice::USDC, USDT, and DAI collateral basket::USDC",
    "Solstice publishes the basket constituents but not current constituent weights.",
  ],
  [
    "usx-solstice::USDC, USDT, and DAI collateral basket::USDT",
    "Solstice publishes the basket constituents but not current constituent weights.",
  ],
  [
    "usx-solstice::USDC, USDT, and DAI collateral basket::DAI",
    "Solstice publishes the basket constituents but not current constituent weights.",
  ],
  [
    "usda-avalon::FBTC-backed CDP positions and USDT/USDC 1:1 mint reserves::USDC",
    "Avalon combines CDP and stablecoin mint paths without publishing current path-level weights.",
  ],
  [
    "usda-avalon::FBTC-backed CDP positions and USDT/USDC 1:1 mint reserves::USDT",
    "Avalon combines CDP and stablecoin mint paths without publishing current path-level weights.",
  ],
  [
    "usdf-astherus::USDT-funded spot crypto and corresponding short futures positions::USDT",
    "USDT funds the strategy, but Aster does not publish the retained-USDT and deployed-position weights.",
  ],
  [
    "reusd-re-protocol::Onchain sUSDe-centered liquidity and offchain Regulation 114 trust collateral::USDe",
    "Re documents sUSDe-centered liquidity and trust collateral without a current reconciled split.",
  ],
  [
    "usdu-usdu-finance::USDU constituent of Curve USDU/USDC LP backing::USDC",
    "The named USDU leg is subject self exposure; the separate USDC leg carries the dependency link.",
  ],
  [
    "syrupusdt-maple::USDT (deployed as overcollateralized institutional loans)::USDT",
    "Maple does not publish the current split between retained USDT and deployed institutional-credit strategies.",
  ],
  [
    "xmd-metal-dollar::USDC, PYUSD, and XPAX stablecoin reserve basket::USDC",
    "Metal Dollar discloses the basket constituents but not current constituent weights.",
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
    "iusd-infinifi::Aave Horizon USDC/RLUSD (institutional pools)::USDC",
    "infiniFi's static fallback groups Aave Horizon USDC and RLUSD into one small mixed bucket; live farm data carries exact coinIds when the source separates positions.",
  ],
  [
    "silk-shade-protocol::Stablecoin redemption pools (USDC, other stables)::USDC",
    "SILK reports a mixed stablecoin redemption pool without stable-level weights, so no single tracked stablecoin coinId is representative.",
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
    "weusd-picwe::PicWe WEUSD backing (current 100% USDC claim; legacy basket conflict)::USDC",
    "WEUSD's current USDC claim conflicts with older basket evidence and lacks a reconciled reserve inventory.",
  ],
  [
    "hyusd-hylo::Unresolved Hylo production collateral envelope (V1 SOL-LST pool and documented V2 SOL/BTC/USDC pools)::USDC",
    "Hylo's reviewed reserve envelope does not reconcile the observable V1 deployment with the documented V2 pools or publish production weights, so linking USDC alone would overstate the dependency.",
  ],
  [
    "hbusdt-hyperbeat::Dynamic Hyperbeat hbUSDT strategy portfolio::USDT",
    "The reviewed Hyperbeat portfolio is a dynamic strategy envelope without durable asset or position weights; the hbUSDT product name does not establish a fixed USDT reserve slice.",
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
