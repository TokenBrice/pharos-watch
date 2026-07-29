import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";

// Known stablecoin tickers that should be linked when referenced in reserves
const KNOWN_TICKERS = [
  "USDC",
  "USDT",
  "DAI",
  "FRAX",
  "USDe",
  "USDtb",
  "BUIDL",
  "USDS",
  "USYC",
  "OUSG",
  "DOLA",
  "GHO",
  "crvUSD",
  "FRXUSD",
  "USD0",
];
const REVIEWED_WARNING_IDS = new Map<string, string>([
  [
    "usdm-mega::USDC and USDtb reserve basket::USDC",
    "MegaUSD's 100% reserve slice is an unsplit USDC/USDtb basket with no published current allocation, so a USDC coinId would overstate the dependency.",
  ],
  [
    "usdm-mega::USDC and USDtb reserve basket::USDT",
    "MegaUSD's 100% reserve slice is an unsplit USDC/USDtb basket with no published current allocation; the USDT substring in USDtb is not evidence of a direct USDT reserve link.",
  ],
  [
    "usdm-mega::USDC and USDtb reserve basket::USDtb",
    "MegaUSD's 100% reserve slice is an unsplit USDC/USDtb basket with no published current allocation, so a USDtb coinId would overstate the dependency.",
  ],
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
    "gho-aave::GhoDirectFacilitator GSM Arbitrum::GHO",
    "This remote GSM facilitator is an issuance rail, not an upstream GHO reserve asset that should inherit coinId linkage.",
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
    "bnusd-balanced::Balanced v2 crypto-loan collateral and USDC/USDT Stability Fund basket::USDC",
    "The complete current backing categories are identified, but Balanced does not publish current constituent balances or weights.",
  ],
  [
    "bnusd-balanced::Balanced v2 crypto-loan collateral and USDC/USDT Stability Fund basket::USDT",
    "The complete current backing categories are identified, but Balanced does not publish current constituent balances or weights.",
  ],
  [
    "dola-inverse-finance::sDOLA-scrvUSD Curve LP and residual LP collateral::DOLA",
    "A two-sided LP position naming the protocol's own token; self-referential collateral is priced by the mechanism review, not a coinId link.",
  ],
  [
    "dola-inverse-finance::sDOLA-scrvUSD Curve LP and residual LP collateral::crvUSD",
    "Same LP row; the crvUSD side is one leg of a mixed LP, not a linkable single-asset slice.",
  ],
  [
    "dola-inverse-finance::Frontier legacy DOLA debt::DOLA",
    "Legacy bad-debt row denominated in the protocol's own token; self-referential, reviewed, no coinId link applies.",
  ],
  [
    "dola-inverse-finance::Endogenous DOLA leg of sUSDe-DOLA Curve LP collateral::USDe",
    "This row isolates the endogenous DOLA half of the LP; sUSDe only identifies the paired pool, while the external sUSDe half carries the upstream coinId.",
  ],
  [
    "dola-inverse-finance::Endogenous DOLA leg of sUSDe-DOLA Curve LP collateral::DOLA",
    "The isolated DOLA half is subject self exposure, not an upstream dependency edge.",
  ],
  [
    "dola-inverse-finance::Endogenous DOLA leg of sUSDS-DOLA Curve LP collateral::USDS",
    "This row isolates the endogenous DOLA half of the LP; sUSDS only identifies the paired pool, while the external sUSDS half carries the upstream coinId.",
  ],
  [
    "dola-inverse-finance::Endogenous DOLA leg of sUSDS-DOLA Curve LP collateral::DOLA",
    "The isolated DOLA half is subject self exposure, not an upstream dependency edge.",
  ],
  [
    "uty-xsy::USDC deposits swept to custodial managed backing::USDC",
    "The reviewed sources establish the USDC mint and redemption envelope but not the current assets or positions held after the custodial sweep.",
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
    "jpyt-dephaser::Locked USDT on Optimism and USDC on Base routed into Aave::USDC",
    "JPYT uses chain-specific USDT and USDC collateral paths, so no single fixed reserve coinId or weight is representative.",
  ],
  [
    "jpyt-dephaser::Locked USDT on Optimism and USDC on Base routed into Aave::USDT",
    "JPYT uses chain-specific USDT and USDC collateral paths, so no single fixed reserve coinId or weight is representative.",
  ],
  [
    "nxusd-nereus::Nereus overcollateralized crypto positions including DAI collateral::DAI",
    "Nereus reports DAI as part of a broader overcollateralized crypto collateral set, so a single DAI coinId would overstate the reserve dependency.",
  ],
  [
    "frax-frax::FRAX::FRAX",
    "FRAX held on its own balance sheet is subject self exposure, not an upstream dependency edge.",
  ],
  [
    "frax-frax::sFRAX::FRAX",
    "sFRAX is a staked claim on FRAX and remains subject self exposure rather than an upstream dependency edge.",
  ],
  [
    "frax-frax::LFRAX::FRAX",
    "LFRAX is a Frax-ecosystem legacy/locked FRAX claim and remains subject self exposure rather than an upstream dependency edge.",
  ],
  [
    "frax-frax::Unmapped Frax balance-sheet assets::FRAX",
    "The label identifies an aggregate Frax balance-sheet bucket rather than a FRAX token holding; its reviewed sub-threshold constituents cannot be represented by one coinId.",
  ],
  [
    "fpi-frax::stkcvxFPIFRAX (staked Convex FPI/FRAX LP)::FRAX",
    "The staked Convex FPI/FRAX LP is an identified protocol position, not an isolable upstream FRAX reserve slice, so no single coinId is representative.",
  ],
  [
    "fpi-frax::Fraxswap V2 FRAX/FPIS::FRAX",
    "The Fraxswap V2 FRAX/FPIS LP is an identified protocol position, not an isolable upstream FRAX reserve slice, so no single coinId is representative.",
  ],
  [
    "yousd-yield-optimizer::USDC-denominated Yield Optimizer strategies::USDC",
    "The reviewed yoUSD reserve is a dynamic USDC-denominated strategy envelope without a durable fixed USDC reserve slice, so the strategy label does not establish a single representative coinId.",
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
    "reusd-re-protocol::reUSD / sUSDe LP position::USDe",
    "Re documents a reUSD/sUSDe LP position; the sUSDe leg is a mixed LP claim without a current reconciled per-asset split.",
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
    "usg-tangent::Productive DeFi collateral (Curve LP tokens, Pendle PTs, and related LP/yield positions, including material USDC-paired LP exposure)::USDC",
    "USG's static reserve slice is an aggregate productive-collateral bucket; USDC is one paired LP route rather than a separately weighted reserve slice.",
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
    "hbusdt-hyperbeat::Dynamic Hyperbeat hbUSDT strategy portfolio::USDT",
    "The reviewed Hyperbeat portfolio is a dynamic strategy envelope without durable asset or position weights; the hbUSDT product name does not establish a fixed USDT reserve slice.",
  ],
  [
    "yzusd-yuzu::Other disclosed small positions (VBILL loop; Aave GHO/RLUSD/USDT dust; Rest_of_Assets)::GHO",
    "Yuzu reports GHO inside an aggregate residual strategy bucket without a separable current weight, so a GHO coinId would overstate the dependency.",
  ],
  [
    "yzusd-yuzu::Other disclosed small positions (VBILL loop; Aave GHO/RLUSD/USDT dust; Rest_of_Assets)::USDT",
    "The Aave USDT dust position sits inside the same aggregate residual bucket without a separable current weight, so a USDT coinId would overstate the dependency.",
  ],
  [
    "ousg-ondo-finance::OUSG tokenized Treasury fund portfolio::OUSG",
    "The reserve label names the subject fund itself, not an upstream OUSG dependency edge.",
  ],
  [
    "pht-pht::Current apcxUSDT-referenced collateral envelope (unreconciled)::USDT",
    "APACX identifies apcxUSDT as an eligible collateral wrapper but does not establish its current PHT balance or reconcile the wrapper to underlying USDT reserves.",
  ],
  [
    "euro3-3a-dao::Whitelisted 3A Vault collateral (USDC.e, DAI, WETH/ETH, USDT, WBTC, wstETH and other approved assets; mix undisclosed)::USDC",
    "3A reports an unweighted multi-asset vault collateral set, so no single tracked stablecoin coinId is representative.",
  ],
  [
    "euro3-3a-dao::Whitelisted 3A Vault collateral (USDC.e, DAI, WETH/ETH, USDT, WBTC, wstETH and other approved assets; mix undisclosed)::USDT",
    "3A reports an unweighted multi-asset vault collateral set, so no single tracked stablecoin coinId is representative.",
  ],
  [
    "euro3-3a-dao::Whitelisted 3A Vault collateral (USDC.e, DAI, WETH/ETH, USDT, WBTC, wstETH and other approved assets; mix undisclosed)::DAI",
    "3A reports an unweighted multi-asset vault collateral set, so no single tracked stablecoin coinId is representative.",
  ],
  [
    "dusd-dialectic::USDC-denominated Dialectic strategy positions across Makina Calibers::USDC",
    "The slice is the deployed Makina strategy envelope (AMM and money-market positions), not held USDC; DUSD's USDC relationship is already carried by variantOf/pegReferenceId, so a coinId here would double-count the dependency.",
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
      "zarm-mento",
      "dusd-dtrinity",
      "buck-buck-assets",
      "frxusd-frax",
      "ftusd-flying-tulip",
      "gbpm-mento",
      "susd1plus-lorenzo",
      "ussd-sonic-labs",
      "wemix-dollar-wemix",
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
