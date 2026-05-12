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
const REVIEWED_STABLECOIN_BATCH_AT = "2026-05-05";
const REVIEWED_YIELD_EXPANSION_AT = "2026-05-11";
const REVIEWED_STABLECOIN_AUDIT_AT = "2026-05-12";
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
  "pusd-polymarket": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
    outputAssetType: "stable-basket",
    costModel: documentedVariableFee(
      "Polymarket docs describe PUSD as redeemable through Polymarket withdrawal rails into supported stablecoin balances; public docs reviewed do not publish a standalone fixed redemption fee",
    ),
    notes: [
      "Application-dollar wrapper around Polymarket deposit/withdrawal rails; modeled as a stable-basket route because exits depend on supported USDC/USDC.e withdrawal paths",
    ],
  },
  "susd-solayer": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(
      "Solayer docs describe sUSD mint and redemption through protocol rails; public docs reviewed do not publish a fixed redemption fee",
    ),
  },
  "usx-dforce": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
    outputAssetType: "stable-basket",
    costModel: documentedVariableFee(
      "dForce docs describe USX mint and redemption through supported collateral/stablecoin routes; public docs reviewed do not publish a single fixed redemption fee",
    ),
  },
  "xdai-gnosis": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
    costModel: documentedVariableFee(
      "Gnosis bridge docs describe xDAI/DAI bridge exits; public docs reviewed do not publish a separate fixed xDAI redemption fee",
    ),
    notes: [
      "Modeled as a bridge-backed stablecoin redemption route into DAI rather than an independent fiat issuer rail",
    ],
  },
  "susdd-tron-dao-reserve": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    executionModel: "rules-based-nav",
    costModel: fixedFee(0, "USDD docs describe sUSDD withdrawals to USDD with no lock-up or protocol fee"),
    docs: [
      sourceRef("USDD sUSDD mechanism", "https://docs.usdd.io/susdd-mechanism", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("USDD savings guide", "https://docs.usdd.io/user-guide/usdd-savings", ["route"]),
    ],
    notes: [
      "sUSDD exits to USDD at the savings-vault exchange rate; downstream USDD par exit remains governed by the parent USDD route",
    ],
  },
  "srusd-reservoir": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.0025 },
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("srUSD exits to rUSD, then Reservoir PSM liquidity provides stablecoin redemption when available"),
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    docs: [
      sourceRef("Reservoir Savings (srUSD)", "https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Reservoir Proof of Reserves", "https://docs.reservoir.xyz/products/proof-of-reserves", ["capacity"]),
    ],
    notes: [
      "Fresh reserve telemetry uses Reservoir's balance-sheet feed; the fallback mirrors the reviewed wsrUSD PSM-buffer bound",
    ],
  },
  "steakusdc-steakhouse": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "heuristic", basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("ERC-4626/Morpho vault withdrawals redeem to USDC when vault liquidity is available"),
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    docs: [
      sourceRef("Steakhouse Prime Instant", "https://www.steakhouse.financial/docs/products/vault-products/current/prime-instant", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Morpho vault integration", "https://legacy.docs.morpho.org/morpho-vaults/tutorials/integrate-vaults/", ["route"]),
    ],
  },
  "steakusdt-steakhouse": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "heuristic", basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("ERC-4626/Morpho vault withdrawals redeem to USDT when vault liquidity is available"),
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    docs: [
      sourceRef("Steakhouse Prime Instant", "https://www.steakhouse.financial/docs/products/vault-products/current/prime-instant", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Morpho vault integration", "https://legacy.docs.morpho.org/morpho-vaults/tutorials/integrate-vaults/", ["route"]),
    ],
  },
  "syzusd-yuzu": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    executionModel: "rules-based-nav",
    totalScoreCap: 65,
    costModel: documentedVariableFee("syzUSD unwraps to yzUSD; final yzUSD primary redemption is KYC-gated through Yuzu rails"),
    docs: [
      sourceRef("Yuzu syzUSD docs", "https://yuzu-money.gitbook.io/yuzu-money/defi-suite/staked-yzusd-syzusd", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Yuzu yzUSD docs", "https://yuzu-money.gitbook.io/yuzu-money/defi-suite/yuzu-stablecoin-yzusd", ["route", "access"]),
    ],
  },
  "fxsave-f-x-protocol": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.2, confidence: "heuristic", basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("fxSAVE can exit through fxSP/router routes into fxUSD, USDC, or both depending on available liquidity"),
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    docs: [
      sourceRef("f(x) Stability Pool", "https://fxprotocol.gitbook.io/fx-docs/f-x-protocol-mechanisms/stability-pool", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Integrating fxSAVE", "https://fxprotocol.gitbook.io/fx-docs/developers/integrating-fxsave", ["route"]),
    ],
  },
  "susn-noon": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    accessModel: "whitelisted-onchain",
    executionModel: "rules-based-nav",
    totalScoreCap: 65,
    costModel: documentedVariableFee("sUSN exits to USN; final USN mint/redeem routes are whitelisted and depend on supported stablecoin liquidity"),
    docs: [
      sourceRef("Noon USN and sUSN", "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Noon minting and redemption", "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn/minting-and-redemption", ["route", "access"]),
    ],
  },
  "usdcx-movement": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "deterministic-onchain",
    costModel: documentedVariableFee("Circle xReserve docs describe 1:1 USDCx burn/release against USDC; public materials reviewed do not publish a separate fixed redemption fee"),
    docs: [
      sourceRef("Circle xReserve", "https://www.circle.com/xreserve", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Movement USDCx announcement", "https://www.movementnetwork.xyz/article/introducing-usdcx-movements-native-usdc-backed-stablecoin", ["route", "capacity", "access"]),
    ],
    notes: [
      "USDCx exits into tracked Circle USDC through the xReserve contract; final fiat redemption remains Circle's issuer route.",
    ],
  },
  "susdt-spark": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("Spark savings vault withdrawals redeem spUSDT for USDT at the live vault exchange rate; no separate fixed protocol fee was identified in reviewed public docs"),
    docs: [
      sourceRef("Spark docs", "https://docs.spark.fi/", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Spark app", "https://spark.fi/", ["route"]),
    ],
  },
  "susdc-spark": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("Spark savings vault withdrawals redeem spUSDC for USDC at the live vault exchange rate; no separate fixed protocol fee was identified in reviewed public docs"),
    docs: [
      sourceRef("Spark docs", "https://docs.spark.fi/", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Spark app", "https://spark.fi/", ["route"]),
    ],
  },
  "gtusdc-gauntlet": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "heuristic", basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("MetaMorpho vault withdrawals redeem to USDC when vault liquidity is available; public docs reviewed do not publish one fixed redemption fee"),
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    docs: [
      sourceRef("Morpho vault docs", "https://docs.morpho.org/curation/overview", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Gauntlet USDC Core vault", "https://app.morpho.org/ethereum/vault/0xdd0f28e19c1780eb6396170735d45153d261490d/gauntlet-usdc-core", ["route", "capacity", "access"]),
    ],
  },
  "gtusdcp-gauntlet": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "heuristic", basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("MetaMorpho vault withdrawals redeem to USDC when vault liquidity is available; public docs reviewed do not publish one fixed redemption fee"),
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    docs: [
      sourceRef("Morpho vault docs", "https://docs.morpho.org/curation/overview", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Gauntlet USDC Prime vault", "https://app.morpho.org/ethereum/vault/0x8c106eedad96553e64287a5a6839c3cc78afa3d0/gauntlet-usdc-prime", ["route", "capacity", "access"]),
    ],
  },
  "yvusdc-yearn": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("Yearn v3 vault withdrawals redeem yvUSDC-1 to USDC at the live vault exchange rate; public docs reviewed do not publish one fixed redemption fee"),
    docs: [
      sourceRef("Yearn v3 USDC vault", "https://yearn.fi/v3/1/0xbe53a109b494e5c9f97b9cd39fe969be68bf6204", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Yearn docs", "https://docs.yearn.fi/", ["route", "capacity", "fees", "access", "settlement"]),
    ],
  },
  "sgho-aave": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("Aave sGHO previewRedeem path exits to GHO at the contract exchange rate; public docs reviewed do not publish a separate fixed redemption fee"),
    docs: [
      sourceRef("Aave sGHO guide", "https://aave.com/docs/aave-v3/guides/sgho", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Aave sGHO governance configuration", "https://governance.aave.com/t/arfc-sgho-launch-configuration/24346", ["route", "capacity", "access"]),
    ],
    notes: [
      "This route models the current legacy sGHO/stkGHO-compatible contract's previewRedeem exit into GHO, not the separate Aave Umbrella stkGHO safety-module cooldown route.",
    ],
  },
  "stusds-sky": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    docs: [
      sourceRef("Sky stUSDS docs", "https://developers.skyeco.com/protocol/tokens/stusds/", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Sky protocol token routes", "https://developers.sky.money/quick-start/protocol-token-routes/", ["route", "capacity"]),
    ],
    notes: [
      "stUSDS is an ERC-4626 risk-capital wrapper over USDS: holders can deposit USDS to receive stUSDS or withdraw USDS with their stUSDS balance.",
      "The wrapper leg exits into USDS; downstream USDS par-exit quality remains governed by Sky's PSM route, while stUSDS holder value can reflect module liquidity and slashing risk.",
    ],
  },
  "stcusd-cap": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("stcUSD withdraws to cUSD at the live vault exchange rate; public docs reviewed do not publish a separate fixed stcUSD redemption fee"),
    docs: [
      sourceRef("Cap stcUSD mechanics", "https://docs.cap.app/protocol-overview/stcusd-mechanics", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Cap cUSD mechanics", "https://docs.cap.app/protocol-overview/cusd-mechanics", ["route", "capacity"]),
      sourceRef("Cap vault", "https://docs.cap.app/concepts/vault", ["route", "capacity", "fees"]),
    ],
    notes: [
      "stcUSD is modeled as the wrapper exit into cUSD; final cUSD par exit inherits Cap's proportional reserve-basket redemption route.",
    ],
  },
  "sbold-k3-capital": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("sBOLD ERC-4626 withdraw/redeem returns BOLD at the vault exchange rate; public docs reviewed do not publish one fixed redemption fee"),
    docs: [
      sourceRef("K3 sBOLD introduction", "https://k3-capital.gitbook.io/sbold/introducing-sbold", ["route", "capacity"]),
      sourceRef("K3 sBOLD technical details", "https://k3-capital.gitbook.io/sbold/technical-details", ["route", "capacity", "fees"]),
      sourceRef("K3 sBOLD interactions", "https://k3-capital.gitbook.io/sbold/technical-details/interactions", ["route", "capacity", "access", "settlement"]),
    ],
    notes: [
      "sBOLD exits into BOLD through ERC-4626 withdrawal/redeem mechanics; downstream BOLD par exit remains Liquity's collateral-redemption route.",
      "K3 docs note deposit and withdrawal operations can be temporarily restricted when accumulated collateral exposure exceeds configured operational limits.",
    ],
  },
  "ybold-yearn": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("Yearn yBOLD ERC-4626 withdraw/redeem returns BOLD at the live vault exchange rate; reviewed public docs and app metadata do not publish one fixed redemption fee"),
    docs: [
      sourceRef("Yearn yBOLD vault", "https://yearn.fi/v3/1/0x9f4330700a36b29952869fac9b33f45eedd8a3d8", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Yearn yBOLD docs", "https://docs.yearn.fi/getting-started/products/yvaults/yBold", ["route", "capacity", "fees"]),
      sourceRef("Yearn yBOLD API", "https://ydaemon.yearn.fi/1/vaults/0x9f4330700a36b29952869fac9b33f45eedd8a3d8", ["route", "capacity", "fees"]),
    ],
    notes: [
      "yBOLD exits into BOLD through ERC-4626 withdrawal/redeem mechanics; downstream BOLD par exit remains Liquity's collateral-redemption route.",
      "The Yearn API currently identifies yBOLD as a tokenized BOLD Stability Pool product and reports zero management, performance, deposit, and withdrawal fees, but the modeled route keeps fees as documented-variable rather than a fixed zero-fee guarantee.",
    ],
  },
  "msy-main-street": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    totalScoreCap: 65,
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    docs: [
      sourceRef("Main Street staking model", "https://mainstreet-finance.gitbook.io/mainstreet.finance/staking-model", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Main Street msY vault", "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/strategy-vaults/msy-the-options-box-spread", ["route", "capacity"]),
      sourceRef("Main Street redemption process", "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/redemption-process", ["route", "capacity", "settlement"]),
    ],
    notes: [
      "msY exits to msUSD at the live staking exchange rate; final USDC redemption inherits Main Street's primary-market capacity limits and cooldown.",
      "Config-level cap reflects that the wrapper exit alone does not return holders to USDC, and downstream msUSD redemption can be capped or delayed during strategy unwinds.",
    ],
  },
  "yusd-yieldfi": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee("YieldFi docs describe yToken redemption requests processed after a cooldown by keeper automation; public docs reviewed do not publish one fixed redemption fee"),
    docs: [
      sourceRef("YieldFi yUSD", "https://docs.yield.fi/technical-docs/ytokens/yusd", ["route", "capacity"]),
      sourceRef("YieldFi smart contract interaction", "https://docs.yield.fi/technical-docs/smart-contract-interaction", ["route", "capacity", "access", "settlement"]),
      sourceRef("YieldFi fees", "https://docs.yield.fi/fees", ["fees"]),
    ],
    notes: [
      "yUSD is an ERC-4626 vault over USDC; redemption burns shares immediately but underlying USDC is delivered through a queued request after the cooldown period.",
    ],
  },
  "said-gaib": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    outputAssetType: "nav",
    costModel: documentedVariableFee("sAID exits to AID through a monthly FIFO withdrawal cycle at unstaking NAV; public docs reviewed do not publish one fixed unstaking fee"),
    docs: [
      sourceRef("GAIB sAID docs", "https://docs.gaib.ai/products/gaib-products/staked-ai-dollar-said", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("GAIB AID docs", "https://docs.gaib.ai/products/gaib-products/ai-dollar-aid", ["route", "access"]),
    ],
    notes: [
      "sAID is not a $1-pegged wrapper; this route models the holder-exercisable withdrawal into AID at unstaking NAV, including possible unrealized-loss haircuts.",
      "Final AID redemption into supported stablecoins remains whitelisted for primary-market users, while regular users generally exit AID through app or DEX liquidity.",
    ],
  },
  "zys-zephyr-protocol": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    outputAssetType: "nav",
    costModel: documentedVariableFee(
      "Zephyr conversion fees are absorbed by reserves and depend on protocol conversion-rate mechanics rather than a single published fixed bps fee",
    ),
    docs: [
      sourceRef("Zephyr integration documentation", "https://zephyrprotocol.com/documentation", ["route", "capacity", "access"]),
      sourceRef("Zephyr conversions dashboard", "https://zephyrprotocol.com/network/conversions", ["route", "fees", "settlement"]),
      sourceRef("Zephyr emission and yield reserve", "https://zephyrprotocol.com/network/emission", ["capacity"]),
    ],
    notes: [
      "ZYS is a Zephyr yield-share asset rather than a flat $1 token; the route is modeled as protocol conversion / redemption of the yield share's ZSD reserve value.",
      "Final dollar exit inherits the underlying ZSD protocol collateral redemption route.",
    ],
  },
  "aa-falconx-mev-capital": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "nav",
    costModel: documentedVariableFee("Idle Perpetual Yield Tranches expose CDO tranche redemption mechanics; public materials reviewed do not publish one fixed senior-tranche redemption fee"),
    docs: [
      sourceRef("Idle Yield Tranches methods", "https://docs.idle.finance/developers/yield-tranches/methods", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Pareto credit vault addresses", "https://docs.pareto.credit/developers/addresses/product/credit-vaults", ["route", "capacity", "access"]),
    ],
    notes: [
      "Modeled as a NAV tranche exit to underlying USDC exposure, with whitelist and CDO-liquidity constraints rather than an issuer fiat redemption route.",
    ],
  },
  "weusd-picwe": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    costModel: fixedFee(100, "PicWe docs describe a 1% WEUSD redemption fee"),
    docs: [
      sourceRef("PicWe WEUSD", "https://docs.picwe.org/what-is-weusd", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("PicWe mint and redeem", "https://docs.picwe.org/mint-and-redeem", ["route", "fees"]),
    ],
  },
};

applyTrackedReviewedDocs(STABLECOIN_REDEEM_BACKSTOP_CONFIGS, ["ousg-ondo-finance", "u-united-stables", "usd0-usual"]);

applyTrackedReviewedDocs(STABLECOIN_REDEEM_BACKSTOP_CONFIGS, ["dusd-dtrinity", "yousd-yield-optimizer"], REVIEWED_REMEDIATION_AT);

applyTrackedReviewedDocs(STABLECOIN_REDEEM_BACKSTOP_CONFIGS, [
  "pusd-polymarket",
  "susd-solayer",
  "usx-dforce",
  "xdai-gnosis",
], REVIEWED_STABLECOIN_BATCH_AT);
