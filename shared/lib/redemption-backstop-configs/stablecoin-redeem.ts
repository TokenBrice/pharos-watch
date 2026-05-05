import type { RedemptionBackstopConfig } from "./shared";
import {
  applyTrackedReviewedDocs,
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  sourceRef,
  stablecoinRedeemBase,
} from "./shared";

const REVIEWED_DIRECT_REDEMPTION_AT = "2026-03-23";
const REVIEWED_REMEDIATION_AT = "2026-03-30";
const REVIEWED_ZCHF_BRIDGE_AT = "2026-04-06";
const REVIEWED_WRAPPER_REDEMPTION_AT = "2026-04-21";
const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_DIRECT_REDEMPTION_AT,
);

export const STABLECOIN_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "dusd-dtrinity": {
    ...stablecoinRedeemBase,
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "supply-ratio", ratio: 0.4, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: fixedFee(50, "Protocol docs describe redemption fees of up to 50 bps"),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("dTrinity documentation", "https://docs.dtrinity.org/", ["route", "capacity", "fees"]),
    ],
    notes: [
      "The 40% ratio is a reviewed heuristic reflecting tracked stable-bucket share rather than a published instant-liquidity floor",
    ],
  },
  "ousd-origin-protocol": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(25, "Origin docs list a 0.25% exit fee on OUSD redemptions"),
    docs: [
      sourceRef(
        "Origin Dollar (OUSD)",
        "https://docs.originprotocol.com/yield-bearing-tokens/origin-dollar-ousd",
        ["route", "capacity"],
      ),
      sourceRef(
        "Origin March 2023 token holder update",
        "https://www.originprotocol.com/blog/march-2023-token-holder-update?lang=en",
        ["route", "fees"],
      ),
      sourceRef(
        "Origin pricing and peg management",
        "https://docs.originprotocol.com/security-and-risk/price-oracles",
        ["route", "capacity"],
      ),
    ],
    notes: ["Origin docs still describe pro-rata basket redemption semantics; current OUSD collateral is USDC only"],
  },
  "ousg-ondo-finance": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(
      "Instant mint/redemption at daily NAV via OUSGInstantManager against USDC (T+0 via BUIDL on-chain liquidity)",
    ),
    notes: ["Token transfers restricted to KYC-verified whitelisted addresses on-chain"],
  },
  "usde-ethena": {
    ...stablecoinRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "immediate",
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.005,
    },
    costModel: documentedVariableFee(
      "Ethena docs describe direct USDe redemption for whitelisted mint users at $1 into supported stable assets, with users reimbursing transaction gas and execution costs rather than paying a separate fixed protocol fee",
    ),
    reviewedAt: "2026-03-23",
    docs: [
      sourceRef(
        "Ethena peg arbitrage mechanism",
        "https://docs.ethena.fi/solution-overview/peg-arbitrage-mechanism",
        ["route", "capacity", "access"],
      ),
      sourceRef(
        "USDe terms and conditions",
        "https://docs.ethena.fi/resources/usde-terms-and-conditions",
        ["route", "fees", "access"],
      ),
      sourceRef(
        "Ethena collateral API",
        "https://app.ethena.fi/api/positions/current/collateral",
        ["capacity"],
      ),
    ],
    notes: [
      "Fresh live reserve metadata scores against Ethena's current Liquid Cash bucket, while the 0.5% fallback ratio reflects the smaller hot-contract stable buffer documented for on-demand redemptions",
    ],
  },
  "zchf-frankencoin": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.014 },
    costModel: fixedFee(
      0,
      "Reviewed StablecoinBridge source burns ZCHF and transfers the same amount of VCHF with no fee logic",
    ),
    reviewedAt: REVIEWED_ZCHF_BRIDGE_AT,
    docs: [
      sourceRef(
        "Frankencoin StablecoinBridge (VCHF)",
        "https://etherscan.io/address/0x3b71ba73299f925a837836160c3e1fec74340403",
        ["route", "capacity", "fees"],
      ),
      sourceRef(
        "Frankencoin overview",
        "https://docs.frankencoin.com/",
        ["route"],
      ),
      sourceRef(
        "VNX docs",
        "https://vnx.gitbook.io/vnx-platform/",
        ["capacity"],
      ),
    ],
    notes: [
      "Fresh live reserve metadata uses the bridge's current VCHF balance as the immediate redeemable lower bound for permissionless ZCHF -> VCHF exits",
      "Fallback retains a conservative 1.4% bridge-buffer ratio derived from the reviewed bridge inventory relative to ZCHF supply on April 6, 2026",
    ],
  },
  "yousd-yield-optimizer": {
    ...stablecoinRedeemBase,
    settlementModel: "immediate",
    executionModel: "rules-based-nav",
    capacityModel: { kind: "supply-ratio", ratio: 0.2, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "ERC-4626 vault; instant redemptions up to liquidity buffer, larger withdrawals up to 24h as cross-chain positions unwind",
    ),
    reviewedAt: "2026-04-16",
    notes: [
      "The 20% ratio is a reviewed heuristic reflecting ERC-4626 vault liquidity-buffer behavior rather than a published instant-liquidity floor",
    ],
  },
  "wsrusd-reservoir": {
    ...stablecoinRedeemBase,
    executionModel: "rules-based-nav",
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.0025,
      confidence: "documented-bound",
      basis: "hot-buffer",
    },
    costModel: documentedVariableFee("ERC-4626 unwrap to rUSD, then PSM exit to USDC; no separate fee disclosed"),
    reviewedAt: "2026-04-04",
    docs: [
      sourceRef("Reservoir Savings (srUSD)", "https://docs.reservoir.xyz/products/savings-srusd", ["route", "capacity"]),
      sourceRef(
        "Reservoir Peg Stability Module",
        "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module",
        ["route", "capacity"],
      ),
      sourceRef("Reservoir Proof of Reserves", "https://docs.reservoir.xyz/products/proof-of-reserves", ["capacity"]),
    ],
    notes: [
      "Fresh live reserve telemetry uses the current USDC position as the immediate redeemable lower bound",
      "When the timestamp-less Reservoir balance-sheet feed cannot meet scoring-grade freshness requirements, the route falls back to the reviewed 25 bps minimum USDC PSM balance documented by Reservoir",
    ],
  },
  "susds-sky": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_WRAPPER_REDEMPTION_AT),
    executionModel: "rules-based-nav",
    costModel: fixedFee(0, "Sky docs describe sUSDS vault deposits and withdrawals with no fee"),
    docs: [
      sourceRef("Sky sUSDS docs", "https://developers.sky.money/core-protocol/susds/", ["route", "capacity", "fees"]),
      sourceRef("Sky protocol token routes", "https://developers.sky.money/quick-start/protocol-token-routes/", ["route", "capacity"]),
    ],
    notes: [
      "sUSDS is an ERC-4626 savings wrapper over USDS: holders can deposit USDS to mint sUSDS and redeem back into USDS at the live vault exchange rate",
      "The wrapper exits immediately into USDS, after which the underlying Sky stablecoin keeps its own direct PSM-backed exit quality",
    ],
  },
  "sdai-sky": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_WRAPPER_REDEMPTION_AT),
    executionModel: "rules-based-nav",
    costModel: fixedFee(0, "Spark documents withdrawals from savings vaults without slippage or platform fees"),
    docs: [
      sourceRef("Spark website", "https://spark.fi/", ["route", "fees"]),
      sourceRef("Spark docs portal", "https://docs.spark.fi/", ["route", "capacity"]),
    ],
    notes: [
      "sDAI is the Dai Savings Rate wrapper: holders exit at the live ERC-4626 exchange rate into DAI rather than through a queued or discretionary process",
      "The wrapper leg is immediate; downstream par-exit quality is inherited from DAI's own PSM-backed redemption surface",
    ],
  },
  "sfrxusd-frax": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_WRAPPER_REDEMPTION_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    docs: [
      sourceRef("Frax sfrxUSD docs", "https://docs.frax.com/protocol/assets/frxusd/sfrxusd", ["route", "capacity"]),
      sourceRef("Frax frxUSD addresses", "https://docs.frax.com/protocol/assets/frxusd/addresses", ["route"]),
    ],
    notes: [
      "sfrxUSD is an ERC-4626-like savings wrapper over frxUSD and exits immediately back into the underlying at the current exchange rate",
      "The wrapper does not add a separate queue or access gate beyond the base frxUSD system",
    ],
  },
  "scrvusd-curve": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_WRAPPER_REDEMPTION_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    docs: [
      sourceRef("Curve scrvUSD month-in-review", "https://news.curve.finance/savings-crvusd-a-month-in-review/", ["route", "capacity"]),
      sourceRef("Curve resources", "https://resources.curve.finance/", ["route"]),
    ],
    notes: [
      "scrvUSD is Curve's savings wrapper over crvUSD and exits into the underlying at the live vault exchange rate",
      "The wrapper route is immediate; actual par-exit quality then depends on the underlying crvUSD redemption and peg-defense surface",
    ],
  },
  "cusdo-openeden": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_WRAPPER_REDEMPTION_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    docs: [
      sourceRef("OpenEden cUSDO token docs", "https://docs.openeden.com/usdo/cusdo-token", ["route", "capacity"]),
      sourceRef("OpenEden integration guide", "https://docs.openeden.com/usdo/developers/integration-guide", ["route"]),
    ],
    notes: [
      "cUSDO is the non-rebasing wrapper over USDO and can be wrapped or unwrapped on demand at the current conversion rate",
      "The wrapper leg is immediate; downstream primary-market USDO redemption remains governed by OpenEden's own issuer flow",
    ],
  },
  "usdf-astherus": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "documented-bound" },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef("Aster docs", "https://docs.asterdex.com/", ["route", "capacity"]),
      sourceRef("Aster USDF page", "https://www.asterdex.com/en/usdf", ["route"]),
    ],
    notes: [
      "Tracked metadata describes 1:1 USDT mint and redeem semantics for USDF",
      "The reviewed 50% bound matches the tracked USDT custody share rather than assuming the strategy-deployed delta-neutral book is instantly withdrawable",
    ],
  },
  "usr-resolv": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef("Resolv docs", "https://docs.resolv.xyz/", ["route", "capacity"]),
      sourceRef("Resolv Apostro reserves", "https://info.apostro.xyz/resolv-reserves", ["capacity"]),
    ],
    notes: [
      "Resolv docs describe USR as mintable and redeemable 1:1 by users against collateral",
      "The reviewed 10% bound matches the tracked USD stablecoin buffer rather than assuming the full delta-neutral reserve stack is immediately withdrawable",
    ],
  },
  "yusd-aegis": {
    ...stablecoinRedeemBase,
    accessModel: "whitelisted-onchain",
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee("Aegis documents 1:1 minting and redemption for approved users, but does not publish a fixed redemption fee"),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef("Aegis liquidity", "https://docs.aegis.im/overview/liquidity", ["route", "capacity", "access"]),
      sourceRef("Aegis FAQ", "https://docs.aegis.im/aegis-faq/how-can-i-get-my-earned-yusd", ["route"]),
      sourceRef("Aegis Accountable dashboard", "https://aegis.accountable.capital/", ["capacity"]),
    ],
    notes: [
      "Direct mint and redemption are reserved for approved primary-market users, while most secondary users access YUSD via DEX liquidity or supported venues",
      "Because YUSD relies on a delta-neutral BTC hedge rather than a pure cash-equivalent reserve bucket, the reviewed route keeps a conservative 15% immediate-capacity bound instead of scoring against full supply",
    ],
  },
  "usn-noon": {
    ...stablecoinRedeemBase,
    accessModel: "whitelisted-onchain",
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee("Noon documents 1:1 minting and redemption for approved users, but does not publish a fixed redemption fee"),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef("Noon USN documentation", "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn/return-generation", ["route", "capacity"]),
      sourceRef("Noon smart contract audits", "https://docs.noon.capital/built-for-safety/smart-contract-audits", ["route", "access"]),
      sourceRef("Noon Accountable dashboard", "https://noon.accountable.capital/", ["capacity"]),
    ],
    notes: [
      "Direct mint and redemption are reserved for approved primary-market users; current model does not treat Noon strategy collateral as a separately measured instant stablecoin buffer",
      "Because USN relies on delta-neutral exchange strategies rather than a pure cash-equivalent reserve bucket, the reviewed route keeps a conservative 15% immediate-capacity bound instead of scoring against full supply",
    ],
  },
  "aid-gaib": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: fixedFee(
      10,
      "GAIB docs currently show a 10 bps sell fee in the dApp, while direct AID minting and redemption are reserved for whitelisted users and partners",
    ),
    docs: [
      sourceRef(
        "GAIB AI Dollar (AID)",
        "https://docs.gaib.ai/products/gaib-products/ai-dollar-aid",
        ["route", "capacity", "access", "fees"],
      ),
      sourceRef(
        "GAIB economy",
        "https://docs.gaib.ai/gaib-overview/gaib-economy",
        ["route", "capacity"],
      ),
    ],
    notes: [
      "Regular users typically exit AID through the GAIB app or DEX liquidity, while the modeled primary redemption rail is the whitelisted direct burn-and-withdraw contract path",
    ],
  },
  "u-united-stables": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Smart contract mint/burn 1:1 against whitelisted stablecoins (USDC, USDT, USD1); on-chain oracles enforce collateral backing",
    ),
  },
  "usx-solstice": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Direct minting and redemption of USX is reserved for KYC'd institutional investors depositing or withdrawing USDC and USDT through the Solstice protocol; public fee schedule not disclosed",
    ),
    docs: [
      sourceRef("Solstice USX", "https://solstice.finance/usx", ["route", "capacity", "access"]),
    ],
    notes: ["Retail users access USX primarily through DEX liquidity or the Solstice platform, while the primary mint/redeem rail is institution-only"],
  },
  "usda-avalon": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(
      "USDa docs state holders can convert USDa to USDT 1:1 by bridging to Ethereum mainnet and depositing into the conversion vault, with claims available within one business day",
    ),
    docs: [
      sourceRef(
        "How to Use USDa",
        "https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda/how-to-use-usda",
        ["route", "capacity", "settlement"],
      ),
      sourceRef(
        "USDa risk management",
        "https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda/risk-management",
        ["capacity"],
      ),
    ],
    notes: ["The modeled redemption rail is the documented USDa-to-USDT conversion vault on Ethereum mainnet rather than offchain BTC collateral withdrawals"],
  },
  "usd0-usual": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Redeemable 1:1 for underlying RWA assets via DaoCollateral contract; minting accepts USYC or USDC via gateway",
    ),
  },
  "usdai-usd-ai": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: "2026-04-03",
    costModel: documentedVariableFee(
      "USD.AI's current app flow and issuer guidance indicate base USDai is minted and redeemed instantly against PYUSD, while the longer unstaking queue applies to sUSDai rather than base USDai",
    ),
    docs: [
      sourceRef("USD.AI buy / stake", "https://docs.usd.ai/app-guide/buy-stake", ["route", "capacity"]),
      sourceRef("USD.AI app buy flow", "https://app.usd.ai/buy", ["route"]),
    ],
    notes: ["Current route models the base USDai burn-and-withdraw path into PYUSD; the asynchronous queue applies to sUSDai unstaking, not direct USDai redemption"],
  },
  "frxusd-frax": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: documentedVariableFee(
      "Direct Ethereum mint and redeem contracts support 1:1 conversion between frxUSD and USDC; public docs do not publish a fixed redemption fee",
    ),
    docs: [
      sourceRef(
        "frxUSD mint and redeem overview",
        "https://docs.frax.com/frxusd/mint-and-redeem-overview",
        ["route", "capacity"],
      ),
      sourceRef(
        "frxUSD USDC quickstart",
        "https://docs.frax.com/frxusd/mint-and-redeem-quickstarts/usdc",
        ["route"],
      ),
      sourceRef(
        "FraxNetDeposit contract",
        "https://docs.frax.com/fraxnet/contracts/fraxnetDeposit",
        ["route", "capacity"],
      ),
    ],
    notes: [
      "Cross-chain and fiat off-ramp flows exist too, but the modeled backstop focuses on the direct onchain USDC redemption rail",
      "If the Frax balance-sheet snapshot is unavailable or stale, the route is intentionally left unrated rather than falling back to a static heuristic buffer",
    ],
  },
  "jupusd-jupiter": {
    ...stablecoinRedeemBase,
    accessModel: "whitelisted-onchain",
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.1,
      confidence: "documented-bound",
      basis: "hot-buffer",
    },
    costModel: documentedVariableFee(
      "JupUSD's primary mint and redeem rail is benefactor-gated and settles against USDC; public materials do not publish one universal fixed redemption fee",
    ),
    reviewedAt: "2026-03-23",
    docs: [
      sourceRef("JupUSD homepage", "https://jupusd.money/", ["route", "capacity"]),
      sourceRef("Offside Labs JupUSD audit", "https://jupusd.money/homepage/audits/offsidelabs.pdf", ["route", "capacity", "access", "fees"]),
    ],
    notes: ["Current model keeps the reviewed 10% USDC liquidity buffer disclosed in public materials as the immediate bound rather than assuming the full reserve stack is always user-accessible through the primary mint/redeem rail"],
  },
  "msusd-main-street": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    docs: [
      sourceRef("Main Street docs", "https://mainstreet-finance.gitbook.io/mainstreet.finance/", ["route", "capacity"]),
      sourceRef("Main Street website", "https://mainstreet.finance/", ["route"]),
    ],
    notes: [
      "Tracked metadata describes direct 1:1 USDC redemption with msUSD held fully against USDC reserves, while yield generation sits in the separate msY staking layer",
    ],
  },
  "wm-m0": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    totalScoreCap: 70,
    costModel: fixedFee(0, "wM docs describe wrap and unwrap as fee-free permissionless calls against the underlying M token"),
    docs: [
      sourceRef("M0 wM token", "https://www.m0.org/faq", ["route", "capacity", "fees"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "Permissionless ERC-20 wrapper: wrap() deposits M and mints wM; unwrap() redeems 1:1 back to M with no fee or queue",
      "Config-level cap reflects that the wM->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail (institution-only M0 mint/burn) still gates actual par exit",
    ],
  },
  "ftusd-flying-tulip": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "Flying Tulip's MintAndRedeem contract supports permissionless 1:1 mint and redemption against USDC or USDT; public docs reviewed do not publish a fixed redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("Flying Tulip documentation", "https://docs.flyingtulip.com/", ["route", "capacity"]),
    ],
    notes: [
      "ftUSD uses delta-neutral stablecoin lending + short perpetual hedging",
      "The 10% ratio is a reviewed heuristic reflecting typical delta-neutral protocol on-hand stable buffers rather than a published instant-liquidity floor for this specific protocol",
    ],
  },
  "usdz-anzen": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Qualified Market Makers mint and redeem 1:1 USDz/USDC against SPCT collateral; public docs reviewed do not publish a fixed retail redemption fee",
    ),
    docs: [
      sourceRef("Anzen Finance", "https://www.anzen.finance/", ["route"]),
      sourceRef("Anzen documentation", "https://docs.anzen.finance/", ["route", "capacity"]),
    ],
    notes: [
      "Primary mint and redeem rail is reserved for whitelisted Qualified Market Makers; retail holders exit via DEX liquidity while arbitrage by QMMs maintains the peg against SPCT collateral",
    ],
  },
  "usdsc-startale": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    totalScoreCap: 70,
    costModel: fixedFee(0, "Startale docs describe USDSC as a fee-free 1:1 wrapper around M0's M token on Soneium"),
    docs: [
      sourceRef("Startale USDSC", "https://startale.com/usdsc", ["route", "capacity", "fees"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "1:1 wrapper around M: mint by wrapping, redeem by unwrapping; underlying M is backed by T-bill collateral attested by M0 Validators",
      "Config-level cap reflects that the USDSC->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail still gates actual par exit",
    ],
  },
  "apxusd-apyx": {
    ...stablecoinRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Apyx docs describe mint and redeem against approved assets for whitelisted participants, with offchain execution spreads and expenses reflected in the price rather than a fixed protocol fee",
    ),
    docs: [
      sourceRef(
        "How to Buy apxUSD",
        "https://docs.apyx.fi/app-guide/how-to-buy-apxusd",
        ["route", "access"],
      ),
      sourceRef(
        "How Apyx Works",
        "https://docs.apyx.fi/apyx-overview/how-apyx-works",
        ["route", "capacity", "fees"],
      ),
      sourceRef(
        "Peg Stability Model",
        "https://docs.apyx.fi/solution-overview/peg-stability-model",
        ["route", "capacity"],
      ),
    ],
    notes: ["Retail users primarily access apxUSD via the Curve pool, while direct minting and redemption are reserved for whitelisted participants who rebalance the market"],
  },
};

applyTrackedReviewedDocs(STABLECOIN_REDEEM_BACKSTOP_CONFIGS, ["ousg-ondo-finance", "u-united-stables", "usd0-usual"]);

applyTrackedReviewedDocs(STABLECOIN_REDEEM_BACKSTOP_CONFIGS, ["dusd-dtrinity", "yousd-yield-optimizer"], REVIEWED_REMEDIATION_AT);
