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
    "usd3-reserve-protocol::Steakhouse USDC V1 vault shares::USDC",
    "Untracked Steakhouse USDC Morpho V1 vault shares (0xbeef01735c132ada46aa9aa4c54623caa92a64cb); USDC is the underlying candidate only, and the tracked steakUSDC is the V2 token.",
  ],
  [
    "aid-gaib::USDT held by the BNB Chain AID minter contract::USDT",
    "D5: bridge/intermediary unverified; withheld as insufficient-evidence (ResearchE, 2026-09-30).",
  ],
  [
    "xmd-metal-dollar::XUSDC (bridge-wrapped USDC) held by the xmd.treasury contract::USDC",
    "D5: bridge/intermediary unverified; withheld as insufficient-evidence (ResearchE, 2026-09-30).",
  ],
  [
    "dola-inverse-finance::DOLA-sUSDe LP-secured debt (undecomposed)::USDe",
    "WS1.B7: LP-secured debt is not a measured sUSDe constituent holding; the undecomposed LP remains deliberately unlinked.",
  ],
  [
    "dola-inverse-finance::DOLA-sUSDe LP-secured debt (undecomposed)::DOLA",
    "WS1.B7: the DOLA leg is subject self exposure within undecomposed LP-secured debt, not an upstream token reserve.",
  ],
  [
    "dola-inverse-finance::DOLA-sUSDS LP-secured debt (undecomposed)::DOLA",
    "WS1.B7: the DOLA leg is subject self exposure within undecomposed LP-secured debt, not an upstream token reserve.",
  ],
  [
    "susd1plus-lorenzo::Lorenzo USD1+ OTF mixed strategy portfolio (USD1, USDT, and USDC deposits; RWA, CeFi quant, and DeFi strategies)::USDC",
    "Lorenzo reports a mixed USD1/USDT/USDC and strategy portfolio without current constituent weights, so a USDC coinId would overstate the dependency.",
  ],
  [
    "susd1plus-lorenzo::Lorenzo USD1+ OTF mixed strategy portfolio (USD1, USDT, and USDC deposits; RWA, CeFi quant, and DeFi strategies)::USDT",
    "Lorenzo reports a mixed USD1/USDT/USDC and strategy portfolio without current constituent weights, so a USDT coinId would overstate the dependency.",
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
    "fpi-frax::stkcvxFPIFRAX (staked Convex FPI/FRAX LP)::FRAX",
    "The staked Convex FPI/FRAX LP is an identified protocol position, not an isolable upstream FRAX reserve slice, so no single coinId is representative.",
  ],
  [
    "fpi-frax::Fraxswap V2 FRAX/FPIS::FRAX",
    "The Fraxswap V2 FRAX/FPIS LP is an identified protocol position, not an isolable upstream FRAX reserve slice, so no single coinId is representative.",
  ],
  [
    "susdt-spark::Spark Savings USDT deployed strategy positions::USDT",
    "spUSDT's deployed row is the vault's downstream strategy exposure, not a holding of the USDT token itself, and the strategy framework lacks current constituent weights.",
  ],
  [
    "susds-sky::Sky Savings USDS deployed strategy positions::USDS",
    "sUSDS's deployed row is projected SSR accrual through Sky protocol accounting, not a separate held USDS token.",
  ],
  [
    "satusd-river::Smart Vault USDT-denominated strategy deposits (Ethereum; holdings unreconciled)::USDT",
    "D24: historical USDT deposit denomination is not current direct token backing; strategy holdings and internally minted liabilities remain unreconciled, so no weighted USDT edge is asserted.",
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
    "Re protocol-pooled reserve; token attribution withheld without an attributable denominator and tranche waterfall (WS1.B3 gate, NC-116)",
  ],
  [
    "reusd-re-protocol::sUSDe (delta-neutral ETH basis)::USDe",
    "Re protocol-pooled reserve; token attribution withheld without an attributable denominator and tranche waterfall (WS1.B3 gate, NC-116)",
  ],
  [
    "reusd-re-protocol::USDC reserves::USDC",
    "Re protocol-pooled reserve; token attribution withheld without an attributable denominator and tranche waterfall (WS1.B3 gate, NC-116)",
  ],
  [
    "reusd-re-protocol::USDT reserves::USDT",
    "Re protocol-pooled reserve; token attribution withheld without an attributable denominator and tranche waterfall (WS1.B3 gate, NC-116)",
  ],
  [
    "reusd-re-protocol::USDe (delta-neutral ETH basis)::USDe",
    "Re protocol-pooled reserve; token attribution withheld without an attributable denominator and tranche waterfall (WS1.B3 gate, NC-116)",
  ],
  [
    "reusd-re-protocol::sUSDS (Sky savings USDS)::USDS",
    "Re protocol-pooled reserve; token attribution withheld without an attributable denominator and tranche waterfall (WS1.B3 gate, NC-116)",
  ],
  [
    "usdu-usdu-finance::USDU constituent of Curve USDU/USDC LP backing::USDC",
    "The named USDU leg is subject self exposure; the separate USDC leg carries the dependency link.",
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
    "weusd-picwe::PicWe WEUSD backing (docs 100% USDC claim; Movement dual MOVE+stablecoin mint-state; unreconciled)::USDC",
    "PicWe's Phase-1 100% USDC documentation conflicts with the on-chain Movement dual MOVE+stablecoin mint state and with EVM mint USDC balances that do not match issued supply, so no dated inventory splits the basket.",
  ],
  [
    "buidl-blackrock::BlackRock BUIDL fund shares::BUIDL",
    "The reserve label names the subject fund itself, not an upstream BUIDL dependency edge.",
  ],
  [
    "pht-pht::Current apcxUSDT-referenced collateral envelope (unreconciled)::USDT",
    "APACX identifies apcxUSDT as an eligible collateral wrapper but does not establish its current PHT balance or reconcile the wrapper to underlying USDT reserves.",
  ],
  [
    "iusd-indigo-protocol::USDCx/USDM-collateral iUSD CDP debt and other indexer-uncovered issuance::USDC",
    "Mint transactions prove USDCx-collateral CDPs mint iUSD, but no public endpoint attributes the validator's USDCx/USDM/USDA balances per iAsset or per CDP, so no constituent link or exact split is asserted.",
  ],
  [
    "frax-frax::EREBOR_USD (Erebor Bank frxUSD reserve account)::FRXUSD",
    "Erebor Bank deposit account holding frxUSD reserve cash; a banking relationship, not a holding of the frxUSD token itself.",
  ],
  [
    "frxusd-frax::EREBOR_USD (Erebor Bank frxUSD reserve account)::FRXUSD",
    "Erebor Bank deposit account holding frxUSD reserve cash; a banking relationship and subject self exposure, not an upstream frxUSD dependency edge.",
  ],
  [
    "usdh-hubble::kUSDH-USDC Orca kToken CDP collateral::USDC",
    "Kamino kToken position over an Orca USDH-USDC LP; a protocol position whose USDC leg is not separable as a direct USDC holding.",
  ],
  [
    "trusd-tori::Unverified USDC Morpho dust on Base::USDC",
    "The Base Morpho vault and token representation are unverified, so the dust remains unlinked with its measured share preserved.",
  ],
  [
    "xgld-unitas::XAUt collateral and borrowed-USDT strategy book (net allocation undisclosed)::USDT",
    "Issuer-disclosed leveraged strategy basket lacks net constituent weights after borrowed USDT liabilities; a USDT coinId would misrepresent the undisclosed net allocation.",
  ],
]);

// Reviewed wrapper spellings, not arbitrary substrings (USDT is not USDtb).
const WRAPPER_TICKERS: Record<string, string> = {
  SFRAX: "FRAX", LFRAX: "FRAX", SUSDE: "USDE", HBUSDT: "USDT",
  APCXUSDT: "USDT", USDCX: "USDC",
};

function mentionsTicker(label: string, ticker: string): boolean {
  const upperTicker = ticker.toUpperCase();
  const tokens = label.toUpperCase().match(/[A-Z0-9](?:[A-Z0-9]|-[A-Z0-9])*/g) ?? [];
  return tokens.some((token) => {
    if (token.startsWith("NON-")) return false;
    return token.split("-").some((part) => part === upperTicker || WRAPPER_TICKERS[part] === upperTicker);
  });
}

describe("reserve ticker boundaries", () => {
  it("distinguishes embedded text from tickers and reviewed wrappers", () => {
    expect(mentionsTicker("USDtb reserve", "USDT")).toBe(false);
    expect(mentionsTicker("sodaINJ collateral", "DAI")).toBe(false);
    expect(mentionsTicker("NON-USDC collateral", "USDC")).toBe(false);
    expect(mentionsTicker("sUSDe LP", "USDe")).toBe(true);
    for (const ticker of ["USDC", "USDT", "DAI"]) {
      expect(mentionsTicker("IBC USDC/USDT/DAI", ticker)).toBe(true);
    }
  });
});

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
      "susdt-spark", // D11: reviewed USDS mechanism claim coexists with the native USDT reserve wrapper link.
      "susdc-spark", // D11: reviewed USDS mechanism claim coexists with the native USDC reserve wrapper link.
      "usdm-mega", // Reviewed USDtb control-operator role anchor is separate from measured USDC/USDtb reserve holdings.
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
        for (const ticker of KNOWN_TICKERS) {
          if (mentionsTicker(slice.name, ticker)) {
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
