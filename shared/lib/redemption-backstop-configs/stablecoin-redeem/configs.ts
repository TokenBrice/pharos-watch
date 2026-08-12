import { defineBackstopRegistry, defineRecordEntries } from "../factory";
import {
  applyTrackedReviewedDocs,
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  undisclosedReviewedFee,
} from "../shared";
import {
  defineStablecoinRedeemConfig,
  gauntletMorphoConfig,
  REVIEWED_DIRECT_REDEMPTION_AT,
  REVIEWED_EXIT_CREDIT_WAVE_AT,
  REVIEWED_EXIT_CREDIT_WAVE2_AT,
  REVIEWED_EXIT_CREDIT_WAVE3_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
  REVIEWED_FXSAVE_LIVE_REDEMPTION_AT,
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
  REVIEWED_STABLECOIN_BATCH_AT,
  REVIEWED_WRAPPER_REDEMPTION_AT,
  REVIEWED_YIELD_EXPANSION_AT,
  REVIEWED_ZCHF_BRIDGE_AT,
  reviewedDirectRedemptionSupplyFull,
  steakhousePrimeInstantConfig,
} from "./shared";

const SOURCE_FILE_PATH = "shared/lib/redemption-backstop-configs/stablecoin-redeem/configs.ts";
const REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT = "2026-07-19";

const RAW_STABLECOIN_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "usd3-3jane": defineStablecoinRedeemConfig({
    executionModel: "rules-based-nav",
    capacityModel: { kind: "reserve-sync-metadata", basis: "live-direct-telemetry" },
    costModel: fixedFee(
      0,
      "3Jane documents fee-free USD3 withdrawals; the vault implementation returns USDC at current NAV subject to available strategy liquidity.",
    ),
    routeExitCorrelation: "same-protocol-liquidity",
    reviewedAt: "2026-07-13",
    docs: [
      sourceRef("3Jane supplier withdrawals", "https://docs.3jane.xyz/architecture/core-money-market/suppliers", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "3Jane USD3 implementation",
        "https://github.com/3jane-protocol/moneymarket-contracts/blob/main/src/usd3/USD3.sol",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
    ],
    notes: [
      "Fresh 3Jane onchain reserve telemetry reads availableWithdrawLimit(address(0)) as the current direct USDC exit bound and preserves any configured commitment delay; private-credit NAV outside that bound is not treated as immediately redeemable.",
    ],
  }),
  "dusd-dtrinity": defineStablecoinRedeemConfig({
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    unresolvedOutputAssetKeys: [
      "usdc-circle",
      "usdt-tether",
      "usds-sky",
      "susds-sky",
      "frxusd-frax",
      "sfrxusd-frax",
      "dai-makerdao",
      "sdai-sky",
      "asset:vbusdc",
      "asset:vbusdt",
      "ausd-agora",
    ],
    unresolvedOutputDisposition: "reviewed-external",
    capacityModel: { kind: "supply-ratio", ratio: 0.4, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: fixedFee(50, "Protocol docs describe redemption fees of up to 50 bps"),
    reviewedAt: "2026-07-27",
    docs: [
      sourceRef("dTRINITY dUSD reserve assets", "https://docs.dtrinity.org/protocol-components/dusd", [
        "route",
        "capacity",
        "fees",
        "settlement",
      ]),
    ],
    notes: [
      "The 40% ratio is a reviewed heuristic reflecting tracked stable-bucket share rather than a published instant-liquidity floor.",
      "2026-07-27 recheck (Kimi data review): the dTRINITY reserve table marks 11 symbols redeem-eligible across Ethereum (USDC, USDT, USDS, sUSDS, frxUSD, sfrxUSD), Fraxtal (adds DAI, sDAI), and Katana (adds vbUSDC, vbUSDT, AUSD); the two Curve LP receipts are mint-only and correctly excluded from the redeem set.",
      "outputAssets remains unset so the route resolves as an unresolved basket: vbUSDC and vbUSDT (Katana Vault Bridge) have no tracked Pharos ids. unresolvedOutputAssetKeys preserves the complete 11-member identity set diagnostically without making the basket scoreable.",
    ],
  }),
  "ousd-origin-protocol": defineStablecoinRedeemConfig({
    ...reviewedDirectRedemptionSupplyFull,
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(25, "Origin docs list a 0.25% exit fee on OUSD redemptions"),
    docs: [
      sourceRef("Origin Dollar (OUSD)", "https://docs.originprotocol.com/yield-bearing-tokens/origin-dollar-ousd", [
        "route",
        "capacity",
      ]),
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
    notes: [
      "Origin docs still describe pro-rata basket redemption semantics; current OUSD collateral is USDC only",
      "Fresh Origin vault telemetry reads the vault's idle stablecoin balances as current direct redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "ousg-ondo-finance": defineStablecoinRedeemConfig({
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
    outputAssets: ["usdc-circle"],
    accessModel: "whitelisted-onchain",
    executionModel: "rules-based-nav",
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackUsd: 50_000_000,
      confidence: "documented-bound",
      basis: "live-direct-telemetry",
    },
    costModel: {
      ...documentedVariableFee("$5K, Instant Redemption, 0% Fee"),
      feeBpsMax: 0,
    },
    docs: [
      sourceRef("Ondo OUSG", "https://ondo.finance/ousg", ["route", "capacity", "fees", "access"]),
      sourceRef("Ondo OUSG redeeming", "https://docs.ondo.finance/qualified-access-products/ousg/redeeming", [
        "route",
        "settlement",
      ]),
      sourceRef("Ondo OUSG instant limits", "https://docs.ondo.finance/qualified-access-products/ousg/instant-limits", [
        "capacity",
      ]),
    ],
    notes: [
      "Token transfers restricted to KYC-verified whitelisted addresses on-chain",
      "Fresh live telemetry reads the OUSG InstantManager router's current default-route USDC capacity as the immediate redeemable bound, replacing the prior full-supply model.",
      "The $50M fallback applies only when that live router read is unavailable: Ondo publishes a $50M global instant-redemption limit across all investors within a rolling 24-hour window, which bounds the route well below OUSG's outstanding NAV.",
    ],
  }),
  "ustb-superstate": defineStablecoinRedeemConfig({
    accessModel: "whitelisted-onchain",
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      0,
      "Superstate's smart-contract docs state that for the USTB RedemptionIdle contract fees are set to 0 and only USDC is supported",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE_AT,
    docs: [
      sourceRef("Superstate USTB", "https://superstate.com/assets/ustb", ["route", "capacity"]),
      sourceRef("Superstate liquidity API", "https://api.superstate.com/v1/funds/liquidity", ["capacity"]),
      sourceRef("Superstate smart contracts", "https://docs.superstate.com/investors/smart-contracts", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Invesco USTB fund page",
        "https://docs.superstate.com/investors/tokenized-funds/available-funds/invesco-ustb",
        ["route", "settlement"],
      ),
      sourceRef("Superstate redemptions", "https://docs.superstate.com/investors/tokenized-funds/redeem", [
        "route",
        "settlement",
      ]),
    ],
    notes: [
      "Route remodeled 2026-08-12 from the same-day fiat issuer rail to the on-chain rail the live adapter already measures: Superstate's smart-contract docs describe the USTB RedemptionIdle `redeem` function burning USTB and returning USDC in one transaction, and the fund page states USDC proceeds are delivered immediately including on non-business days, subject to available liquidity.",
      "Access stays whitelisted rather than permissionless because every holder must sit on Superstate's AllowlistV3 contract, which only admits addresses that cleared KYC and the investment agreement.",
      "Fresh live reserve telemetry uses the on-chain USDC balance of Superstate's RedemptionIdle contract as the bounded current direct capacity, with the liquidity API's Circle USD availability kept as context",
      "NAV/AUM remains reserve evidence only and is not used as immediate redemption capacity",
    ],
  }),
  "usde-ethena": defineStablecoinRedeemConfig({
    outputAssetType: "stable-basket",
    outputAssets: ["usdt-tether", "usdc-circle"],
    accessModel: "whitelisted-onchain",
    settlementModel: "immediate",
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.005,
      basis: "hot-buffer",
    },
    costModel: fixedFee(
      10,
      "Ethena's public fees API reports mint_fee_bps/redeem_fee_bps = 10 for USDT/USDC benefactors, and the USDe terms and conditions cite a reimbursement charge of 10 basis points",
    ),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef("Ethena peg arbitrage mechanism", "https://docs.ethena.fi/solution-overview/peg-arbitrage-mechanism", [
        "route",
        "capacity",
        "access",
      ]),
      sourceRef("USDe terms and conditions", "https://docs.ethena.fi/resources/usde-terms-and-conditions", [
        "route",
        "fees",
        "access",
      ]),
      sourceRef("Ethena API documentation overview", "https://docs.ethena.fi/api-documentation/overview", ["fees"]),
    ],
    notes: [
      "Ethena's collateral API does not isolate immediately liquid assets within Liquid Cash, so live reserve metadata does not override the reviewed 0.5% hot-buffer fallback",
    ],
  }),
  "zchf-frankencoin": defineStablecoinRedeemConfig({
    outputAssets: ["chfau-allunity"],
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.0085 },
    costModel: fixedFee(
      0,
      "Reviewed StablecoinBridge source burns ZCHF and transfers the equivalent CHFAU amount with no fee logic",
    ),
    reviewedAt: REVIEWED_ZCHF_BRIDGE_AT,
    docs: [
      sourceRef(
        "Frankencoin StablecoinBridge (CHFAU)",
        "https://etherscan.io/address/0x3e445ff4dddf0ff8ae7458c9746ed80bd664f6c1",
        ["route", "capacity", "fees"],
      ),
      sourceRef("Frankencoin overview", "https://docs.frankencoin.com/", ["route"]),
      sourceRef("AllUnity CHFAU", "https://allunity.com/chfau/", ["capacity"]),
    ],
    notes: [
      "Fresh live reserve metadata uses the bridge's current CHFAU balance as the immediate redeemable lower bound for permissionless ZCHF -> CHFAU exits",
      "Frankencoin's price API does not yet publish CHFAU, so reserve telemetry values CHFAU at the existing VCHF CHF-price proxy",
      "Fallback retains a conservative 0.85% bridge-buffer ratio derived from the reviewed CHFAU bridge inventory relative to ZCHF supply on May 25, 2026",
    ],
  }),
  "yousd-yield-optimizer": defineStablecoinRedeemConfig({
    outputAssets: ["usdc-circle"],
    settlementModel: "immediate",
    executionModel: "rules-based-nav",
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.2, basis: "strategy-buffer" },
    costModel: fixedFee(
      0,
      "YO docs state protocol deposit and withdrawal fees are currently set to 0; instant redemptions depend on the available liquidity buffer.",
    ),
    reviewedAt: "2026-04-16",
    notes: [
      "The 20% ratio is a reviewed heuristic reflecting ERC-4626 vault liquidity-buffer behavior rather than a published instant-liquidity floor",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle underlying balance as current direct redemption capacity; the prior reviewed 20% heuristic is retained only as fallback when live metadata is unavailable.",
    ],
  }),
  "wsrusd-reservoir": defineStablecoinRedeemConfig({
    outputAssets: ["usdc-circle"],
    executionModel: "rules-based-nav",
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.0025,
      confidence: "documented-bound",
      basis: "hot-buffer",
    },
    costModel: documentedVariableFee(
      "The wsrUSD ERC-4626 unwrap and the rUSD-to-USDC PSM redeem are both free, but the srUSD leg between them burns through SavingModule.redeem at `previewRedeem(amount) * (1e6 + redeemFee) / 1e6`; redeemFee is a live on-chain parameter read each run (1.34 bps on 2026-08-12), governance-settable below 100%",
      "formula",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE_AT,
    docs: [
      sourceRef("Reservoir Savings (srUSD & wsrUSD)", "https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd", [
        "route",
        "capacity",
        "fees",
      ]),
      sourceRef(
        "Reservoir Peg Stability Module",
        "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module",
        ["route", "capacity"],
      ),
      sourceRef("Reservoir Proof of Reserves", "https://docs.reservoir.xyz/products/proof-of-reserves", ["capacity"]),
    ],
    notes: [
      "The modeled route composes the ERC-4626 unwrap into rUSD with the downstream Reservoir PSM exit, so its final output is USDC",
      "Fresh live reserve telemetry uses the USDC balance of Reservoir's USDC PSM (0x4809010926aec940b550D34a46A52739f996D75D) as the immediate redeemable lower bound; the balance-sheet USDC bucket is parked in lending vaults and stays diagnostic-only",
      "When the PSM read is unavailable the adapter withholds telemetry entirely, and the route falls back to the reviewed 25 bps minimum USDC PSM balance documented by Reservoir",
      "No static fee bound declared 2026-08-12 despite the doc line \"wsrUSD carries no fees\": verified Etherscan-published source shows the wrapper (Savingcoin, ERC-4626 pure conversion) and the PSM (`_redeem` burns rUSD 1:1 and transfers USDC) are both free, but the srUSD leg in between burns `previewRedeem(amount) * (1e6 + redeemFee) / 1e6` in SavingModule.redeem. That `redeemFee` is charged on exit, read 134/1e6 = 1.34 bps at block 25735375, and the MANAGER role may set it anywhere below 100%, so no reviewed ceiling is defensible. The fee model is therefore formula-confidence and scores against the adapter's per-run `redeemFee()` read instead of a static number.",
    ],
  }),
  "susds-sky": defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(0, "Sky docs describe sUSDS vault deposits and withdrawals with no fee"),
    reviewedAt: "2026-05-17",
    docs: [
      sourceRef("Sky sUSDS docs", "https://developers.sky.money/core-protocol/susds/", ["route", "capacity", "fees"]),
      sourceRef("Sky protocol token routes", "https://developers.sky.money/quick-start/protocol-token-routes/", [
        "route",
        "capacity",
      ]),
    ],
    notes: [
      "sUSDS is an ERC-4626 savings wrapper over USDS: holders can deposit USDS to mint sUSDS and redeem back into USDS at the live vault exchange rate",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDS balance as current direct wrapper capacity; final par-exit quality still depends on USDS's own PSM-backed exit surface.",
    ],
  }),
  "sdai-sky": defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(0, "Spark documents withdrawals from savings vaults without slippage or platform fees"),
    reviewedAt: "2026-05-17",
    docs: [
      sourceRef("Spark website", "https://spark.fi/", ["route", "fees"]),
      sourceRef("Spark docs portal", "https://docs.spark.fi/", ["route", "capacity"]),
    ],
    notes: [
      "sDAI is the Dai Savings Rate wrapper: holders exit at the live ERC-4626 exchange rate into DAI rather than through a queued or discretionary process",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle DAI balance as current direct wrapper capacity; downstream par-exit quality is inherited from DAI's own PSM-backed redemption surface.",
    ],
  }),
  "sdola-inverse-finance": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull("2026-05-24"),
    capacityModel: { kind: "reserve-sync-metadata" },
    totalScoreCap: 70,
    costModel: fixedFee(
      0,
      "sDOLA docs describe permissionless instant unwrapping back to DOLA with no lock-up period or early-withdrawal penalty.",
    ),
    docs: [
      sourceRef(
        "sDOLA docs",
        "https://docs.inverse.finance/inverse-finance/inverse-finance/products/tokens/dola/sdola",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Inverse Peg Stability Module",
        "https://docs.inverse.finance/inverse-finance/inverse-finance/products/peg-stability-module",
        ["route", "capacity", "fees"],
      ),
    ],
    notes: [
      "Modeled route is the permissionless sDOLA wrapper exit into DOLA, not the downstream DOLA-to-USDS PSM path.",
      "Config-level cap reflects that unwrapping to DOLA does not by itself guarantee a full stablecoin exit; DOLA's own PSM capacity remains separately bounded.",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle DOLA balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "sdusd-dtrinity": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull("2026-06-10"),
    outputAssets: ["dusd-dtrinity"],
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    totalScoreCap: 70,
    costModel: documentedVariableFee(
      "dTRINITY docs state dSTAKE has no staking fee and unstaking incurs up to 10 bps retained by the vault for remaining sdUSD holders.",
      "formula",
    ),
    docs: [
      sourceRef("dTRINITY sdUSD docs", "https://docs.dtrinity.org/protocol-components/sdusd", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled route is the permissionless atomic sdUSD wrapper exit into dUSD; the output is pinned explicitly to the tracked dUSD asset.",
      "Config-level cap reflects that unwrapping to dUSD does not by itself guarantee a full stablecoin exit; dUSD's own redemption capacity remains separately bounded.",
      "Fresh ERC-4626 reserve telemetry pins the Ethereum token/router/strategy identities, reads the exact active withdrawal set, and bounds direct capacity by dLEND maxWithdraw plus dUSD available liquidity. It fails closed instead of treating the token's idle dUSD balance or full supply as executable.",
    ],
  }),
  "sfrxusd-frax": defineStablecoinRedeemConfig({
    outputAssets: ["frxusd-frax"],
    capacityModel: { kind: "reserve-sync-metadata", basis: "live-direct-telemetry" },
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    costModel: undisclosedReviewedFee(
      "The observer captures the MintRedeemer fee and both LayerZero message quotes, but an all-in holder cost remains unknown until Ethereum transaction gas is measured.",
    ),
    reviewedAt: "2026-07-24",
    docs: [
      sourceRef(
        "Frax sfrxUSD stake and unstake guide",
        "https://docs.frax.com/frxusd/stake-and-unstake-quickstart-ethereum",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Frax Ethereum RemoteHop",
        "https://www.codeslaw.app/contracts/ethereum/0x99b5587ab54a49e3f827d10175caf69c0187bfa8",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Frax Fraxtal Hop",
        "https://www.codeslaw.app/contracts/fraxtal/0x3e6a2cbafd864e09e6dab9cf035a0abea32bc0bc",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Frax Fraxtal MintRedeemer implementation",
        "https://www.codeslaw.app/contracts/fraxtal/0xc13d8e8668f5b54d492f5c3e37cf772206f7d0a6",
        ["capacity", "fees"],
      ),
    ],
    notes: [
      "Ethereum sfrxUSD has local ERC-4626 withdrawals disabled. The modeled holder route sends sfrxUSD through Frax's permissionless Ethereum RemoteHop, redeems it against the Fraxtal MintRedeemer, and returns frxUSD to Ethereum.",
      "Fresh reserve telemetry fails closed unless finalized state on both chains matches every pinned proxy implementation, runtime bytecode, LayerZero peer, OFT and lockbox identity, token decimal, oracle bound, return-message funding check, fee bound, and Fraxtal frxUSD inventory view.",
      "Capacity is the current frxUSD inventory that the Fraxtal MintRedeemer reports as withdrawable, capped by the Ethereum sfrxUSD supply. The route remains non-scoreable because no primary-source or measured completion-time upper bound and no all-in transaction-gas cost are available; the conservative queued legacy label is not a settlement SLA.",
    ],
  }),
  "scrvusd-curve": defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Curve docs describe scrvUSD as a Yearn V3 vault with idle crvUSD always available for redemption; yield accrues through share price rather than a separate exit fee.",
    ),
    reviewedAt: "2026-05-17",
    docs: [
      sourceRef("Curve scrvUSD month-in-review", "https://news.curve.finance/savings-crvusd-a-month-in-review/", [
        "route",
        "capacity",
      ]),
      sourceRef("Curve resources", "https://resources.curve.finance/", ["route"]),
    ],
    notes: [
      "scrvUSD is Curve's savings wrapper over crvUSD and exits into the underlying at the live vault exchange rate",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle crvUSD balance as current direct wrapper capacity; actual par-exit quality then depends on the underlying crvUSD redemption and peg-defense surface.",
    ],
  }),
  "cusdo-openeden": defineStablecoinRedeemConfig({
    reviewedAt: REVIEWED_WRAPPER_REDEMPTION_AT,
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "OpenEden integration docs route cUSDO redeem through the wrapper into USDO at convertToAssets; the separate USDO primary redemption fee is downstream of this wrapper leg.",
    ),
    docs: [
      sourceRef("OpenEden cUSDO token docs", "https://docs.openeden.com/usdo/cusdo-token", ["route", "capacity"]),
      sourceRef("OpenEden integration guide", "https://docs.openeden.com/usdo/developers/integration-guide", ["route"]),
    ],
    notes: [
      "cUSDO is the non-rebasing wrapper over USDO and can be wrapped or unwrapped on demand at the current conversion rate",
      "The wrapper leg is immediate; downstream primary-market USDO redemption remains governed by OpenEden's own issuer flow",
      "Fresh ERC-4626 reserve telemetry reads the wrapper's idle USDO balance as current direct unwrap capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "usdf-astherus": defineStablecoinRedeemConfig({
    outputAssets: ["usdt-tether"],
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "documented-bound" },
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      10,
      "Aster FAQ states Aster USDF redemption charges 0.1%; PancakeSwap swap fees apply separately",
    ),
    reviewedAt: "2026-05-14",
    docs: [
      sourceRef("Aster USDF FAQ", "https://docs.asterdex.com/usdf-stablecoin/overview/faqs", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Aster USDF page", "https://www.asterdex.com/en/usdf", ["route"]),
    ],
    notes: [
      "Tracked metadata describes 1:1 USDT mint and redeem semantics for USDF",
      "The reviewed 50% bound matches the tracked USDT custody share rather than assuming the strategy-deployed delta-neutral book is instantly withdrawable",
    ],
  }),
  "usr-resolv": defineStablecoinRedeemConfig({
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
    costModel: undisclosedReviewedFee(),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef("Resolv docs", "https://docs.resolv.xyz/", ["route", "capacity"]),
      sourceRef("Resolv Apostro reserves", "https://info.apostro.xyz/resolv-reserves", ["capacity"]),
    ],
    notes: [
      "Resolv docs describe USR as mintable and redeemable 1:1 by users against collateral",
      "The reviewed 10% bound matches the tracked USD stablecoin buffer rather than assuming the full delta-neutral reserve stack is immediately withdrawable",
    ],
  }),
  "yusd-aegis": defineStablecoinRedeemConfig({
    outputAssetType: "stable-basket",
    outputAssets: ["usdt-tether", "usdc-circle", "dai-makerdao"],
    accessModel: "whitelisted-onchain",
    capacityModel: { kind: "supply-ratio", ratio: 0.15, confidence: "heuristic" },
    costModel: undisclosedReviewedFee(
      "Aegis documents 1:1 minting and redemption for approved users, but does not publish a fixed redemption fee",
    ),
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
  }),
  "usn-noon": defineStablecoinRedeemConfig({
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    accessModel: "whitelisted-onchain",
    capacityModel: { kind: "supply-ratio", ratio: 0.15, confidence: "heuristic" },
    costModel: undisclosedReviewedFee(
      "Noon documents 1:1 minting and redemption for approved users, but does not publish a fixed redemption fee",
    ),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef(
        "Noon USN documentation",
        "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn/return-generation",
        ["route", "capacity"],
      ),
      sourceRef("Noon smart contract audits", "https://docs.noon.capital/built-for-safety/smart-contract-audits", [
        "route",
        "access",
      ]),
      sourceRef("Noon Accountable dashboard", "https://noon.accountable.capital/", ["capacity"]),
    ],
    notes: [
      "Direct mint and redemption are reserved for approved primary-market users; current model does not treat Noon strategy collateral as a separately measured instant stablecoin buffer",
      "Because USN relies on delta-neutral exchange strategies rather than a pure cash-equivalent reserve bucket, the reviewed route keeps a conservative 15% immediate-capacity bound instead of scoring against full supply",
    ],
  }),
  "aid-gaib": defineStablecoinRedeemConfig({
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      10,
      "GAIB docs currently show a 10 bps sell fee in the dApp — confirmed by the deployed redeemer's redemptionFeeBps() reading 10 on-chain — while direct AID minting and redemption are reserved for whitelisted users and partners",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE3_AT,
    docs: [
      sourceRef(
        "GAIB AID acquisition and redemption guide",
        "https://docs.gaib.ai/products/gaib-products/how-to-get-aid-said",
        ["route", "capacity", "access", "fees"],
      ),
      sourceRef("GAIB economy", "https://docs.gaib.ai/gaib-overview/gaib-economy", ["route", "capacity"]),
    ],
    notes: [
      "Regular users typically exit AID through the GAIB app or DEX liquidity, while the modeled primary redemption rail is the whitelisted direct burn-and-withdraw contract path",
      "Fresh reserve telemetry reads the redeemer's USDC payout float capped by the remaining daily redemption allowance (identity-gated on stablecoin()/aid() and the pinned beacon implementation) as the live executable bound; when the read is unavailable the route is left unrated instead of assuming full-supply immediacy",
    ],
  }),
  "u-united-stables": defineStablecoinRedeemConfig({
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
    accessModel: "whitelisted-onchain",
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether", "usd1-world-liberty-financial"],
    costModel: documentedVariableFee(
      "Smart contract mint/burn 1:1 against whitelisted stablecoins (USDC, USDT, USD1); on-chain oracles enforce collateral backing",
    ),
    docs: [
      sourceRef("United Stables", "https://www.u.tech/", ["capacity"]),
      sourceRef("United Stables terms", "https://www.u.tech/terms/", ["route", "fees", "access"]),
    ],
    notes: [
      "Output declared 2026-07-19: United Stables documents 1:1 smart-contract mint/burn against the whitelisted stablecoins USDC, USDT, and USD1, all of which are tracked and priced; the terms reserve the issuer's right to satisfy redemptions with any eligible reserve asset including cash, so the declared basket is the documented onchain stablecoin set rather than a guaranteed payout composition.",
    ],
  }),
  "usx-solstice": defineStablecoinRedeemConfig({
    ...reviewedDirectRedemptionSupplyFull,
    outputAssets: ["usdg-paxos"],
    accessModel: "whitelisted-onchain",
    costModel: undisclosedReviewedFee(
      "Direct minting and redemption of USX is reserved for KYC'd institutional investors depositing or withdrawing USDC and USDT through the Solstice protocol; public fee schedule not disclosed",
    ),
    docs: [sourceRef("Solstice USX", "https://solstice.finance/usx", ["route", "capacity", "access"])],
    notes: [
      "Retail users access USX primarily through DEX liquidity or the Solstice platform, while the primary mint/redeem rail is institution-only",
    ],
  }),
  "usda-avalon": defineStablecoinRedeemConfig({
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
    notes: [
      "The modeled redemption rail is the documented USDa-to-USDT conversion vault on Ethereum mainnet rather than offchain BTC collateral withdrawals",
    ],
  }),
  "usd0-usual": defineStablecoinRedeemConfig({
    ...reviewedDirectRedemptionSupplyFull,
    outputAssets: ["asset:usyc", "asset:m", "asset:ustbl"],
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Redeemable 1:1 for underlying RWA assets via DaoCollateral contract; minting accepts USYC or USDC via gateway",
    ),
    docs: [
      sourceRef(
        "Usual USD0 mint and redeem",
        "https://docs.usual.money/usual-products/usd0-stablecoin/usd0/flow-and-architecture",
        ["route", "capacity", "access", "settlement"],
      ),
      sourceRef(
        "Usual USD0 DaoCollateral",
        "https://tech.usual.money/smart-contracts/protocol-contracts/usd0/usd0-daocollateral",
        ["route", "fees"],
      ),
    ],
  }),
  "usdai-usd-ai": defineStablecoinRedeemConfig({
    ...reviewedDirectRedemptionSupplyFull,
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE3_AT,
    outputAssets: ["pyusd-paypal"],
    accessModel: "whitelisted-onchain",
    costModel: fixedFee(
      10,
      "USD.AI's mint/redeem upgrade notice states that direct mint and redeem are routed through market makers with a 10 bps fee applied to redemptions",
    ),
    docs: [
      sourceRef("USD.AI buy / stake", "https://docs.usd.ai/app-guide/buy-stake", ["route", "capacity"]),
      sourceRef("USD.AI app buy flow", "https://app.usd.ai/buy", ["route"]),
      sourceRef("USD.AI mint and redeem upgrade", "https://usd.ai/insights/usdai-mint-redeem-upgrade", [
        "route",
        "fees",
        "access",
      ]),
    ],
    notes: [
      "Current route models the base USDai burn-and-withdraw path into PYUSD; the asynchronous queue applies to sUSDai unstaking, not direct USDai redemption",
      "Output declared 2026-07-19 from the existing reviewed note above: the modeled direct redemption pays PYUSD (tracked pyusd-paypal).",
      "Fee bounded and access corrected 2026-08-12 from the same verified issuer notice: it applies a 10 bps redemption fee and restricts direct contract-level mint and redemption to a KYC'd set of whitelisted market makers and approved institutional depositors, so the route is whitelisted rather than permissionless and ordinary holders exit through secondary markets.",
      "Fresh reserve telemetry reads the live PYUSD float held by the USDai contract as the executable bound, gated on baseToken() still resolving to that same PYUSD deployment. The prior full-supply model is dropped with no fallback: for a KYC-gated burn-and-withdraw route the float is the only honest bound, and supply-full would overstate the route precisely when the read is unavailable.",
      "Verified 2026-08-12 on Arbitrum: baseToken() resolved to PYUSD 0x46850aD61C2B7d64d08c9C754F45254596696984, the contract's paused() read false, and its PYUSD balance was 174,318,300.42 against a USDai supply near 172.6M — the float currently exceeds supply, so the ratio is not a fixed fraction that a static model could stand in for.",
    ],
  }),
  "frxusd-frax": defineStablecoinRedeemConfig({
    ...reviewedDirectRedemptionSupplyFull,
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: undisclosedReviewedFee(
      "Direct Ethereum mint and redeem contracts support 1:1 conversion between frxUSD and USDC; public docs do not publish a fixed redemption fee",
    ),
    docs: [
      sourceRef("frxUSD mint and redeem overview", "https://docs.frax.com/frxusd/mint-and-redeem-overview", [
        "route",
        "capacity",
      ]),
      sourceRef("frxUSD USDC quickstart", "https://docs.frax.com/frxusd/mint-and-redeem-quickstarts/usdc", ["route"]),
      sourceRef("FraxNetDeposit contract", "https://docs.frax.com/fraxnet/contracts/fraxnetDeposit", [
        "route",
        "capacity",
      ]),
    ],
    notes: [
      "Cross-chain and fiat off-ramp flows exist too, but the modeled backstop focuses on the direct onchain USDC redemption rail",
      "If the Frax balance-sheet snapshot is unavailable or stale, the route is intentionally left unrated rather than falling back to a static heuristic buffer",
    ],
  }),
  "jupusd-jupiter": defineStablecoinRedeemConfig({
    accessModel: "whitelisted-onchain",
    outputAssets: ["usdc-circle"],
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.1,
      confidence: "documented-bound",
      basis: "hot-buffer",
    },
    costModel: fixedFee(
      4,
      "Jupiter's JupUSD fee FAQ states the JupUSD program applies a 0.04% fee to mint and redeem transactions.",
    ),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef("JupUSD homepage", "https://jupusd.money/", ["route", "capacity"]),
      sourceRef("Offside Labs JupUSD audit", "https://jupusd.money/homepage/audits/offsidelabs.pdf", [
        "route",
        "capacity",
        "access",
        "fees",
      ]),
      sourceRef(
        "JupUSD fees FAQ",
        "https://jupiverse.zendesk.com/hc/en-us/articles/24441752163740-What-fees-apply-to-JupUSD",
        ["fees"],
      ),
    ],
    notes: [
      "Current model keeps the reviewed 10% USDC liquidity buffer disclosed in public materials as the immediate bound rather than assuming the full reserve stack is always user-accessible through the primary mint/redeem rail",
    ],
  }),
  "msusd-main-street": defineStablecoinRedeemConfig({
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    capacityModel: { kind: "supply-ratio", ratio: 0.2, confidence: "documented-bound", basis: "strategy-buffer" },
    costModel: undisclosedReviewedFee(),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRef(
        "Main Street minting pathway",
        "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/minting-pathway",
        ["route", "access"],
      ),
      sourceRef(
        "Main Street redemption process",
        "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/redemption-process",
        ["route", "capacity", "settlement"],
      ),
      sourceRef("Main Street website", "https://mainstreet.finance/", ["route"]),
    ],
    notes: [
      "Main Street documents 1:1 USDC redemption for verified users, but also documents dynamic capacity, a cooldown, asset conversion, and strategy unwinds before settlement.",
      "The reviewed 20% bound follows the documented concurrent-redemption capacity limit instead of assuming the full supply is immediately backed by segregated USDC.",
    ],
  }),
  "bbqusdc-steakhouse": defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.05, basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Smokehouse USDC uses a MetaMorpho vault; withdrawals redeem to USDC when vault liquidity is available and Morpho vault fees accrue from generated yield rather than a separate withdrawal fee.",
    ),
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    docs: [
      sourceRef(
        "Smokehouse USDC vault",
        "https://app.morpho.org/ethereum/vault/0xbeefff209270748ddd194831b3fa287a5386f5bc/smokehouse-usdc",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Smokehouse launch forum",
        "https://forum.morpho.org/t/introducing-the-smokehouse-product-line-bbqusdc-and-bbqdai/1182",
        ["route", "capacity", "access"],
      ),
      sourceRef(
        "Morpho vault integration",
        "https://legacy.docs.morpho.org/morpho-vaults/tutorials/integrate-vaults/",
        ["route"],
      ),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as current direct redemption capacity; the prior reviewed 5% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
    ],
  }),
  "wm-m0": defineStablecoinRedeemConfig({
    outputAssets: ["m-m0"],
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: "2026-04-16",
    totalScoreCap: 70,
    costModel: fixedFee(
      0,
      "wM docs describe wrap and unwrap as fee-free permissionless calls against the underlying M token",
    ),
    docs: [
      sourceRef("M0 wM token", "https://www.m0.org/faq", ["route", "capacity", "fees"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "Permissionless ERC-20 wrapper: wrap() deposits M and mints wM; unwrap() redeems 1:1 back to M with no fee or queue",
      "Fresh live reserve metadata reads the current M token balance held by the wM contract as the directly unwrapable capacity bound.",
      "Config-level cap reflects that the wM->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail (institution-only M0 mint/burn) still gates actual par exit",
    ],
  }),
  "ftusd-flying-tulip": defineStablecoinRedeemConfig({
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: undisclosedReviewedFee(
      "Flying Tulip shows the sell quote at the prevailing rate and any exit or cooldown parameters in-app; public docs do not publish one fixed redemption fee",
    ),
    reviewedAt: "2026-08-09",
    docs: [
      sourceRef("Flying Tulip ftUSD", "https://docs.flyingtulip.com/product-suite/ft-usd/", [
        "route",
        "capacity",
        "fees",
        "settlement",
      ]),
    ],
    notes: [
      "Flying Tulip's current buy flow names USDC and USDT inputs, and the sell flow returns ftUSD to the selected input asset; the small Sonic USSD reserve position is not documented as a direct holder redemption output.",
      "The 10% ratio is a reviewed heuristic reflecting typical delta-neutral protocol on-hand stable buffers rather than a published instant-liquidity floor for this specific protocol.",
    ],
  }),
  "usdz-anzen": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull("2026-04-16"),
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE3_AT,
    outputAssets: ["usdc-circle"],
    costModel: undisclosedReviewedFee(
      "Qualified Market Makers mint and redeem 1:1 USDz/USDC against SPCT collateral; public docs reviewed do not publish a fixed retail redemption fee",
    ),
    docs: [
      sourceRef("Anzen Finance", "https://www.anzen.finance/", ["route"]),
      sourceRef("Anzen documentation", "https://docs.anzen.finance/", ["route", "capacity"]),
      sourceRef("Anzen USDz overview", "https://docs.anzen.finance/usdz-101/overview", ["route", "fees"]),
      sourceRef(
        "USDz verified deployed source (Ethereum 0xa469b7ee...10067)",
        "https://etherscan.io/address/0xa469b7ee9ee773642b3e93e842e5d9b5baa10067#code",
        ["route", "access", "capacity", "fees"],
      ),
    ],
    notes: [
      "Access corrected 2026-08-12 from the deployed source rather than the docs: `redeem(uint256)` gates only on `whenNotPaused`, a collateral-rate modifier, sufficient SPCT reserve, and `require(!_blacklist[msg.sender])`. There is no holder whitelist, so the route is permissionless-onchain with a caller blacklist. The SPCT whitelist sits one level down and covers the USDz contract itself, which calls `spct.redeem()` — confirmed on-chain, where SPCT `isWhitelist()` reads true for the USDz contract and false for an ordinary address. Anzen's Qualified-Market-Maker framing describes the primary mint rail, not a restriction on who may call redeem.",
      "Fresh reserve telemetry bounds the route at the USDC the payout path actually holds — `redeem()` pays USDC out of the USDz contract after pulling it from the SPCT pool, so the pool's own USDC is the depth — and withholds the whole surface when USDz's pinned `usdc()`, `spct()`, or `oracle()` identities stop resolving or `paused()` reads true. The documented-bound full-supply model is dropped with no fallback.",
      "The redemption fee is read live rather than bounded statically: `redeem()` charges USDz's `redeemFeeRate()` first and SPCT's rate on the remainder, so the adapter composes the two against each contract's own coefficient and reports no fee at all when either rate is unreadable or out of range.",
      "The first live read is an honest negative: at Ethereum mainnet on 2026-08-12 the SPCT pool held 6,695 raw USDC units — 0.006695 USDC, under a cent — against a USDz supply of 806,422.80. The source makes the ceiling exact rather than approximate, because `redeem()` requires `spct.reserveUSD() * 1e12 >= _amount`, capping any single redemption at 0.006695 USDz. The permissionless route is open and unpaused but is drained to a rounding error, so live-only capacity with no fallback is what keeps the route from being credited against a reserve it cannot pay.",
    ],
  }),
  "usdsc-startale": defineStablecoinRedeemConfig({
    outputAssets: ["m-m0"],
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: "2026-04-16",
    accessModel: "whitelisted-onchain",
    holderEligibility: "whitelisted-primary",
    totalScoreCap: 70,
    costModel: fixedFee(0, "Startale docs describe USDSC as a fee-free 1:1 wrapper around M0's M token on Soneium"),
    docs: [
      sourceRef("Startale USDSC", "https://startale.com/usdsc", ["route", "capacity", "fees"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "1:1 wrapper around M: mint by wrapping, redeem through Startale's M0 SwapFacility extension; underlying M is backed by T-bill collateral attested by M0 Validators",
      "Fresh live reserve metadata reads the current M balance held by the USDSC extension and verifies the configured SwapFacility path is enabled for the approved swapper.",
      "Config-level cap reflects that the USDSC->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail still gates actual par exit",
    ],
  }),
  "apxusd-apyx": defineStablecoinRedeemConfig({
    ...reviewedDirectRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Apyx docs describe mint and redeem against approved assets for whitelisted participants, with offchain execution spreads and expenses reflected in the price rather than a fixed protocol fee",
    ),
    docs: [
      sourceRef("How to Buy apxUSD", "https://docs.apyx.fi/app-guide/how-to-buy-apxusd", ["route", "access"]),
      sourceRef("How Apyx Works", "https://docs.apyx.fi/apyx-overview/how-apyx-works", ["route", "capacity", "fees"]),
      sourceRef("Peg Stability Model", "https://docs.apyx.fi/solution-overview/peg-stability-model", [
        "route",
        "capacity",
      ]),
    ],
    notes: [
      "Retail users primarily access apxUSD via the Curve pool, while direct minting and redemption are reserved for whitelisted participants who rebalance the market",
    ],
  }),
  "pusd-polymarket": defineStablecoinRedeemConfig({
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: "2026-07-09",
    outputAssetType: "stable-basket",
    costModel: fixedFee(0, "1:1 wrap/unwrap via CollateralOnramp/Offramp; Polymarket documents no unwrap fee"),
    docs: [
      sourceRef("Polymarket pUSD docs", "https://docs.polymarket.com/concepts/pusd", ["route", "capacity", "fees"]),
      sourceRef("Polymarket withdrawal help", "https://help.polymarket.com/en/articles/13369898-how-to-withdraw", [
        "route",
        "settlement",
      ]),
    ],
    notes: [
      "wrap()/unwrap() burn and mint pUSD 1:1 against a dedicated Polygon vault holding native USDC and bridged USDC.e; fresh reserve telemetry reads that vault's live USDC balance as current direct redemption capacity",
      "The backing vault is a smart account (arbitrary execution) owned by a 12h-timelock-gated 3/6 Safe, and the pUSD token itself is UUPS-upgradeable behind the same timelock, so admin/upgrade risk is not captured by the live vault-balance ratio alone",
    ],
  }),
  "susd-solayer": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
    outputAssets: ["usdc-circle"],
    executionModel: "rules-based-nav",
    costModel: undisclosedReviewedFee(
      "Solayer docs describe sUSD mint and redemption through protocol rails; public docs reviewed do not publish a fixed redemption fee",
    ),
    docs: [
      sourceRef("Solayer sUSD RFQ process", "https://docs.solayer.org/susd/decentralized-rfq-protocol/process", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef("Solayer sUSD eligibility", "https://docs.solayer.org/susd/protocol-info/eligibility%26risks", [
        "access",
      ]),
    ],
  }),
  "usx-dforce": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
    outputAssetType: "stable-basket",
    costModel: undisclosedReviewedFee(
      "dForce docs describe USX mint and redemption through supported collateral/stablecoin routes; public docs reviewed do not publish a single fixed redemption fee",
    ),
    docs: [
      sourceRef("dForce USX stablecoin", "https://docs.dforce.network/ecosystem/usx-stablecoin", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef("dForce USX LSR", "https://docs.usx.finance/minting-and-redeeming/lsr", ["route", "capacity", "fees"]),
    ],
  }),
  "xdai-gnosis": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
    outputAssetType: "stable-basket",
    outputAssets: ["dai-makerdao", "usds-sky"],
    costModel: undisclosedReviewedFee(
      "Gnosis bridge docs describe xDAI/DAI bridge exits; public docs reviewed do not publish a separate fixed xDAI redemption fee",
    ),
    docs: [
      sourceRef("Gnosis xDAI bridge", "https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge", [
        "route",
        "capacity",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as a bridge-backed stablecoin redemption route into DAI rather than an independent fiat issuer rail",
    ],
  }),
  "susdd-tron-dao-reserve": defineStablecoinRedeemConfig({
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(0, "USDD docs describe sUSDD withdrawals to USDD with no lock-up or protocol fee"),
    docs: [
      sourceRef("USDD sUSDD mechanism", "https://docs.usdd.io/susdd-mechanism", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("USDD savings guide", "https://docs.usdd.io/user-guide/usdd-savings", ["route"]),
    ],
    notes: [
      "sUSDD exits to USDD at the savings-vault exchange rate; downstream USDD par exit remains governed by the parent USDD route",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDD balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "rusd-reservoir": defineStablecoinRedeemConfig({
    outputAssets: ["usdc-circle"],
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.0025,
      confidence: "documented-bound",
      basis: "hot-buffer",
    },
    costModel: fixedFee(
      0,
      "The rUSD-to-USDC Peg Stability Module redeem burns rUSD 1:1 and transfers USDC; the verified PSM source contains no fee logic",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE_AT,
    docs: [
      sourceRef(
        "Reservoir Peg Stability Module",
        "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Reservoir smart-contract addresses",
        "https://docs.reservoir.xyz/security-and-compliance/smart-contract-addresses",
        ["route"],
      ),
      sourceRef("Reservoir Proof of Reserves", "https://docs.reservoir.xyz/products/proof-of-reserves", ["capacity"]),
    ],
    notes: [
      "Added 2026-08-12: base rUSD redeems directly through Reservoir's USDC PSM (0x4809010926aec940b550D34a46A52739f996D75D). Its redeem(uint256) and redeem(address,uint256) are `external whenNotPaused` with no role gate in the verified source, so the route is permissionless while the PSM is unpaused.",
      "Fresh reserve telemetry reads the USDC balance of Reservoir's USDC PSM on-chain; when that read is unavailable the adapter withholds telemetry and the route falls back to Reservoir's documented 25 bps minimum USDC PSM balance",
    ],
  }),
  "srusd-reservoir": defineStablecoinRedeemConfig({
    outputAssets: ["usdc-circle"],
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.0025,
      confidence: "documented-bound",
      basis: "hot-buffer",
    },
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(
      "srUSD exits to rUSD through SavingModule.redeem at `previewRedeem(amount) * (1e6 + redeemFee) / 1e6`; redeemFee is a live on-chain parameter read each run (1.34 bps on 2026-08-12), governance-settable below 100%, and the downstream rUSD-to-USDC PSM redeem is 1:1 with no fee",
      "formula",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE_AT,
    docs: [
      sourceRef("Reservoir Savings (srUSD)", "https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Reservoir Peg Stability Module",
        "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module",
        ["route", "capacity"],
      ),
      sourceRef("Reservoir Proof of Reserves", "https://docs.reservoir.xyz/products/proof-of-reserves", ["capacity"]),
    ],
    notes: [
      "The modeled route composes the srUSD exit into rUSD with the downstream Reservoir PSM exit, so its final output is USDC",
      "Fresh reserve telemetry reads the USDC balance of Reservoir's USDC PSM (0x4809010926aec940b550D34a46A52739f996D75D) on-chain; when that read is unavailable the adapter withholds telemetry and the route falls back to Reservoir's documented 25 bps minimum USDC PSM balance",
      "No static fee bound declared 2026-08-12: verified Etherscan-published source shows SavingModule.redeem burns `previewRedeem(amount) * (1e6 + redeemFee) / 1e6`, so the docs' \"micro burn fee ... one day's worth of interest\" is charged on exit rather than entry. It read 134/1e6 = 1.34 bps at block 25735375, but the MANAGER role may set it anywhere below 100%, so no reviewed ceiling is defensible. The fee model is therefore formula-confidence and scores against the adapter's per-run `redeemFee()` read instead of a static number.",
    ],
  }),
  "steakusdc-steakhouse": steakhousePrimeInstantConfig("USDC"),
  "steakusdt-steakhouse": steakhousePrimeInstantConfig("USDT"),
  "syzusd-yuzu": defineStablecoinRedeemConfig({
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    totalScoreCap: 65,
    costModel: fixedFee(
      0,
      "Yuzu syzUSD ERC-4626 unwrap charges no exit fee: on-chain previewRedeem == convertToAssets (Plasma 0xc8a8df9b210243c55d31c73090f06787ad0a1bf6), no fee selectors; downstream yzUSD primary redemption stays KYC-gated",
    ),
    docs: [
      sourceRef("Yuzu syzUSD docs", "https://yuzu-money.gitbook.io/yuzu-money/defi-suite/staked-yzusd-syzusd", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Yuzu yzUSD docs", "https://yuzu-money.gitbook.io/yuzu-money/defi-suite/yuzu-stablecoin-yzusd", [
        "route",
        "access",
      ]),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the wrapper's idle yzUSD balance as current direct unwrap capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "fxsave-f-x-protocol": defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: documentedVariableFee(
      "f(x) fxSP instantRedeem fee = on-chain instantRedeemFeeRatio, currently 1%, governance cap 5%",
      "formula",
    ),
    reviewedAt: REVIEWED_FXSAVE_LIVE_REDEMPTION_AT,
    docs: [
      sourceRef("f(x) Stability Pool", "https://fxprotocol.gitbook.io/fx-docs/f-x-protocol-mechanisms/stability-pool", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Integrating fxSAVE", "https://fxprotocol.gitbook.io/fx-docs/developers/integrating-fxsave", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the fxSAVE vault's idle fxSP balance as current direct redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of falling back to the prior heuristic strategy-buffer estimate.",
    ],
  }),
  "susn-noon": defineStablecoinRedeemConfig({
    reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
    capacityModel: { kind: "reserve-sync-metadata" },
    accessModel: "whitelisted-onchain",
    executionModel: "rules-based-nav",
    totalScoreCap: 65,
    costModel: fixedFee(
      0,
      "Noon docs state Noon does not charge fees or other dApp charges; sUSN unstaking exits to USN subject to cooldown and gas.",
    ),
    docs: [
      sourceRef("Noon USN and sUSN", "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Noon minting and redemption",
        "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn/minting-and-redemption",
        ["route", "access"],
      ),
      sourceRef(
        "Noon fees and other charges",
        "https://docs.noon.capital/built-for-high-yields/fees-and-other-charges",
        ["fees"],
      ),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USN balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "usdcx-movement": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    outputAssets: ["usdc-circle"],
    executionModel: "deterministic-onchain",
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
    costModel: undisclosedReviewedFee(
      "Circle xReserve docs describe 1:1 USDCx burn/release against USDC; public materials reviewed do not publish a separate fixed redemption fee",
    ),
    docs: [
      sourceRef("Circle xReserve", "https://www.circle.com/xreserve", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Movement USDCx announcement",
        "https://www.movementnetwork.xyz/article/introducing-usdcx-movements-native-usdc-backed-stablecoin",
        ["route", "capacity", "access"],
      ),
    ],
    notes: [
      "USDCx exits into tracked Circle USDC through the xReserve contract; final fiat redemption remains Circle's issuer route.",
      "Fresh reserve telemetry reads xReserve's balanceOfNativeCollateral(USDC, Movement domain 10005) on Ethereum as the live escrowed-USDC exit bound; when that read is unavailable the route is left unrated instead of assuming the full supply is releasable.",
    ],
  }),
  "susdt-spark": defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Spark docs describe Savings vault tokens as fee-free ERC-4626 products; spUSDT withdrawals redeem for USDT at the live vault exchange rate.",
    ),
    reviewedAt: "2026-05-17",
    docs: [
      sourceRef("Spark docs", "https://docs.spark.fi/", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Spark app", "https://spark.fi/", ["route"]),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDT balance as current direct redemption capacity; if the live snapshot is unavailable, the wrapper route is left unrated instead of assuming full-supply immediacy.",
    ],
  }),
  "susdc-spark": defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Spark docs describe Savings vault tokens as fee-free ERC-4626 products; spUSDC withdrawals redeem for USDC at the live vault exchange rate.",
    ),
    reviewedAt: "2026-05-17",
    docs: [
      sourceRef("Spark docs", "https://docs.spark.fi/", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Spark app", "https://spark.fi/", ["route"]),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as current direct redemption capacity; if the live snapshot is unavailable, the wrapper route is left unrated instead of assuming full-supply immediacy.",
    ],
  }),
  "gtusdc-gauntlet": gauntletMorphoConfig(
    "Gauntlet USDC Core vault",
    "https://app.morpho.org/ethereum/vault/0xdd0f28e19c1780eb6396170735d45153d261490d/gauntlet-usdc-core",
  ),
  "gtusdcp-gauntlet": gauntletMorphoConfig(
    "Gauntlet USDC Prime vault",
    "https://app.morpho.org/ethereum/vault/0x8c106eedad96553e64287a5a6839c3cc78afa3d0/gauntlet-usdc-prime",
  ),
  "yvusdc-yearn": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Yearn v3 vault withdrawals redeem yvUSDC-1 to USDC at the live vault exchange rate; Yearn reports performance fees on yield, not a separate withdrawal fee.",
    ),
    docs: [
      sourceRef("Yearn v3 USDC vault", "https://yearn.fi/v3/1/0xbe53a109b494e5c9f97b9cd39fe969be68bf6204", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Yearn docs", "https://docs.yearn.fi/", ["route", "capacity", "fees", "access", "settlement"]),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry measures Yearn V3 default-queue withdrawable capacity from total idle USDC plus each funded strategy's maxRedeem(vault) value; if the live snapshot is unavailable, the route is left unrated instead of falling back to full NAV.",
    ],
  }),
  "sgho-aave": defineStablecoinRedeemConfig({
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Aave sGHO previewRedeem returns the GHO amount received for redeeming sGHO shares; no separate sGHO redemption fee is documented.",
    ),
    docs: [
      sourceRef("Aave sGHO guide", "https://aave.com/docs/aave-v3/guides/sgho", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Aave sGHO governance configuration",
        "https://governance.aave.com/t/arfc-sgho-launch-configuration/24346",
        ["route", "capacity", "access"],
      ),
    ],
    notes: [
      "This route models the current legacy sGHO/stkGHO-compatible contract's previewRedeem exit into GHO, not the separate Aave Umbrella stkGHO safety-module cooldown route.",
      "Fresh sGHO telemetry scores the contract's live previewRedeem(totalSupply) output as current direct redemption capacity into GHO; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "stusds-sky": defineStablecoinRedeemConfig({
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Sky stUSDS implements ERC-4626 withdraw/redeem to USDS at the chi exchange rate; the published implementation does not apply a separate exit fee.",
    ),
    docs: [
      sourceRef("Sky stUSDS docs", "https://developers.skyeco.com/protocol/tokens/stusds/", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Sky protocol token routes", "https://developers.sky.money/quick-start/protocol-token-routes/", [
        "route",
        "capacity",
      ]),
    ],
    notes: [
      "stUSDS is an ERC-4626 risk-capital wrapper over USDS: holders can deposit USDS to receive stUSDS or withdraw USDS with their stUSDS balance.",
      "The wrapper leg exits into USDS; downstream USDS par-exit quality remains governed by Sky's PSM route, while stUSDS holder value can reflect module liquidity and slashing risk.",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDS balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "stcusd-cap": defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "stcUSD unstakes to cUSD fee-free at the live vault exchange rate (only accrued-yield/lockedProfit NAV growth, no separate stcUSD wrapper fee); the 0.25% (0% whitelisted) fee is the downstream cUSD mint/burn/redeem leg, not the stcUSD step",
    ),
    reviewedAt: "2026-05-17",
    docs: [
      sourceRef("Cap stcUSD mechanics", "https://docs.cap.app/protocol-overview/stcusd-mechanics", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Cap cUSD mechanics", "https://docs.cap.app/protocol-overview/cusd-mechanics", ["route", "capacity"]),
      sourceRef("Cap vault", "https://docs.cap.app/concepts/vault", ["route", "capacity", "fees"]),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the vault's idle cUSD balance as current direct wrapper capacity; final cUSD par exit inherits Cap's proportional reserve-basket redemption route.",
    ],
  }),
  "sbold-k3-capital": defineStablecoinRedeemConfig({
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE3_AT,
    // The static documented-bound downgrade is retired: the adapter now reads
    // K3's collateral-health gate (maxCollInBold) each run and self-downgrades
    // to documented-bound whenever the gate is restricted or unreadable, so an
    // observed-open run may resolve live-direct.
    capacityModel: {
      kind: "reserve-sync-metadata",
      basis: "strategy-buffer",
    },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "K3 docs describe sBOLD entry fees only on deposit and mint; withdraw/redeem burns shares and returns BOLD at the vault exchange rate.",
    ),
    docs: [
      sourceRef("K3 sBOLD introduction", "https://k3-capital.gitbook.io/sbold/introducing-sbold", [
        "route",
        "capacity",
      ]),
      sourceRef("K3 sBOLD technical details", "https://k3-capital.gitbook.io/sbold/technical-details", [
        "route",
        "capacity",
        "fees",
      ]),
      sourceRef("K3 sBOLD interactions", "https://k3-capital.gitbook.io/sbold/technical-details/interactions", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "sBOLD exits into BOLD through ERC-4626 withdrawal/redeem mechanics; downstream BOLD par exit remains Liquity's collateral-redemption route.",
      "K3 docs note deposit and withdrawal operations can be temporarily restricted when accumulated collateral exposure exceeds configured operational limits.",
      "Fresh ERC-4626 reserve telemetry measures same-run Stability-Pool-withdrawable BOLD from the vault's own calcFragments() liquid-BOLD word (compounded SP deposits) rather than the idle BOLD balance, which sits at ~1 BOLD because sBOLD deploys its BOLD into Liquity V2 Stability Pools; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model. Verified on Ethereum at block 25585860 (2026-07-23): calcFragments() returned boldAmount == totalAssets == 0x06615c0dee43f9767b13a5 (~77M BOLD) with collInBold 0, while the asset balanceOf(vault) was ~1 BOLD (the dead share); the liquid-BOLD word is the exact value sBOLD._maxWithdraw caps redemptions at.",
      "Live SP-withdrawable capacity is scored at documented-bound confidence (modelConfidence medium), not the adapter's live-direct default: the measured liquid-BOLD excludes not-yet-swapped collateral gains and K3 can temporarily restrict withdrawals on collateral-exposure thresholds, so the read is a bounded proxy for instantaneous redeemability rather than an unconditional direct quote.",
    ],
  }),
  "ybold-yearn": defineStablecoinRedeemConfig({
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Yearn yBOLD docs state yBOLD is always redeemable for underlying BOLD without withdrawal fees or a waiting period.",
    ),
    docs: [
      sourceRef("Yearn yBOLD vault", "https://yearn.fi/v3/1/0x9f4330700a36b29952869fac9b33f45eedd8a3d8", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Yearn yBOLD docs", "https://docs.yearn.fi/getting-started/products/yvaults/yBold", [
        "route",
        "capacity",
        "fees",
      ]),
      sourceRef("Yearn yBOLD API", "https://ydaemon.yearn.fi/1/vaults/0x9f4330700a36b29952869fac9b33f45eedd8a3d8", [
        "route",
        "capacity",
        "fees",
      ]),
    ],
    notes: [
      "yBOLD exits into BOLD through ERC-4626 withdrawal/redeem mechanics; downstream BOLD par exit remains Liquity's collateral-redemption route.",
      "The Yearn API currently identifies yBOLD as a tokenized BOLD Stability Pool product and reports zero management and performance fees.",
      "Fresh ERC-4626 reserve telemetry measures Yearn V3 default-queue withdrawable capacity from total idle BOLD plus each funded strategy's maxRedeem(vault) value; if the live snapshot is unavailable, the route is left unrated instead of falling back to full NAV.",
    ],
  }),
  "yusd-yieldfi": defineStablecoinRedeemConfig({
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.1,
      confidence: "documented-bound",
      basis: "strategy-buffer",
    },
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "YieldFi yUSD token terms list no redemption fee other than network gas; requests still settle after the documented cooldown/keeper process.",
    ),
    docs: [
      sourceRef("YieldFi yUSD token terms", "https://docs.yield.fi/legal-documents/token-terms/yusd", [
        "route",
        "capacity",
        "fees",
      ]),
      sourceRef(
        "YieldFi smart contract interaction",
        "https://docs.yield.fi/technical-docs/smart-contract-interaction",
        ["route", "capacity", "access", "settlement"],
      ),
      sourceRef("YieldFi fees", "https://docs.yield.fi/fees", ["fees"]),
    ],
    notes: [
      "yUSD is an ERC-4626 vault over USDC; redemption burns shares immediately but underlying USDC is delivered through a queued request after the cooldown period.",
      "Because yUSD allocates into delta-neutral and private-credit strategy positions, the reviewed route uses the documented queued route with a conservative 10% strategy-buffer capacity instead of scoring against full supply.",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as the current redeemable bound while the queued request flow still governs settlement; the reviewed 10% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
    ],
  }),
  "said-gaib": defineStablecoinRedeemConfig({
    outputAssets: ["aid-gaib"],
    reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
    capacityModel: { kind: "reserve-sync-metadata" },
    settlementModel: "queued",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    costModel: fixedFee(
      0,
      "sAID exits to AID through a monthly FIFO withdrawal cycle at unstaking NAV; verified source exposes no separate unstaking-fee deduction",
    ),
    docs: [
      sourceRef("GAIB sAID docs", "https://docs.gaib.ai/products/gaib-products/staked-ai-dollar-said", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("GAIB AID docs", "https://docs.gaib.ai/products/gaib-products/ai-dollar-aid", ["route", "access"]),
    ],
    notes: [
      "sAID is not a $1-pegged wrapper; this route models the holder-exercisable withdrawal into AID at unstaking NAV, including possible unrealized-loss haircuts.",
      "Final AID redemption into supported stablecoins remains whitelisted for primary-market users, while regular users generally exit AID through app or DEX liquidity.",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle AID balance as the current redeemable bound while the monthly FIFO cycle still governs settlement; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
      "Output type corrected 2026-07-19: the withdrawal pays AID (tracked aid-gaib, a $1-target stablecoin) — the previously declared output asset — so the nav placeholder type was replaced with stable-single; the unstaking-NAV conversion-rate and haircut caveats above are unchanged and remain captured by the queued rules-based-nav execution model.",
    ],
  }),
  "zys-zephyr-protocol": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    outputAssets: ["zsd-zephyr-protocol"],
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
    costModel: fixedFee(
      10,
      "Zephyr's consensus RingCT verification deducts a fixed 0.1% conversion fee from the yield price on every REDEEM_YIELD conversion",
    ),
    docs: [
      sourceRef("Zephyr integration documentation", "https://zephyrprotocol.com/documentation", [
        "route",
        "capacity",
        "access",
      ]),
      sourceRef(
        "Zephyr RingCT conversion-fee source (pinned)",
        "https://github.com/ZephyrProtocol/zephyr/blob/67c5f53b878fef41fb5e74c4382d5b7a2f37fd8a/src/ringct/rctSigs.cpp",
        ["fees"],
      ),
      sourceRef("Zephyr conversions dashboard", "https://zephyrprotocol.com/network/conversions", [
        "route",
        "fees",
        "settlement",
      ]),
      sourceRef("Zephyr emission and yield reserve", "https://zephyrprotocol.com/network/emission", ["capacity"]),
    ],
    notes: [
      "ZYS is a Zephyr yield-share asset rather than a flat $1 token; its protocol conversion pays ZSD at the current ZYS/ZSD share value, so the exact tracked output is zsd-zephyr-protocol.",
      "Final dollar exit inherits the underlying ZSD protocol collateral redemption route.",
      "2026-07-27 primary-source confirmation (Kimi data review): REDEEM_YIELD burns ZYS and pays ZSD at the consensus share price with a 0.1% conversion fee enforced in RingCT verification (pinned v2.3.0 source). Output valuation stays blocked downstream until the zsd-zephyr-protocol peg producer emits peg data.",
      "Fee bound declared 2026-08-12: the pinned source above computes `conversion_fee = yield_coin_price / 1000` in the REDEEM_YIELD branch, a fixed 10 bps deduction enforced by consensus rather than a governance-settable parameter, so the prior undisclosed-fee marker is replaced by a fixed bound.",
    ],
  }),
  "aa-falconx-mev-capital": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    outputAssets: ["usdc-circle"],
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    costModel: undisclosedReviewedFee(
      "Idle Perpetual Yield Tranches expose CDO tranche redemption mechanics; public materials reviewed do not publish one fixed senior-tranche redemption fee",
    ),
    docs: [
      sourceRef("Idle Yield Tranches methods", "https://docs.idle.finance/developers/yield-tranches/methods", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Pareto credit vault addresses",
        "https://docs.pareto.credit/developers/addresses/product/credit-vaults",
        ["route", "capacity", "access"],
      ),
    ],
    notes: [
      "Modeled as a NAV tranche exit to underlying USDC exposure, with whitelist and CDO-liquidity constraints rather than an issuer fiat redemption route.",
    ],
  }),
  "usdb-blast": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull(REVIEWED_FOLLOWUP_REMEDIATION_AT),
    outputAssets: ["dai-makerdao"],
    settlementModel: "days",
    outputAssetType: "stable-single",
    costModel: undisclosedReviewedFee(
      "Blast docs describe USDB redemption for DAI when bridging back to Ethereum; bridge gas and withdrawal costs are variable and no separate fixed redemption fee was identified",
    ),
    routeExitCorrelation: "wrapper-to-parent-dependency",
    docs: [
      sourceRef("Blast developer docs", "https://docs.blast.io/", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Models the canonical Blast bridge exit from USDB to Ethereum DAI, not secondary-market USDB liquidity on Blast.",
      "Existing live reserve telemetry tracks the Blast USDB yield manager, but this static route only claims documented eventual bridge redeemability.",
    ],
  }),
  "usdv-solomon": defineStablecoinRedeemConfig({
    accessModel: "whitelisted-onchain",
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "supply-ratio", ratio: 0.005, confidence: "documented-bound", basis: "hot-buffer" },
    costModel: documentedVariableFee(
      "Solomon docs disclose a 0.2% mint fee; redemption fee is not separately published, and access is limited to approved or whitelisted participants",
    ),
    reviewedAt: REVIEWED_FOLLOWUP_REMEDIATION_AT,
    docs: [
      sourceRef("Solomon minting USDv", "https://docs.solomonlabs.org/usdv/usdv-and-susdv/minting-usdv", [
        "route",
        "access",
        "fees",
      ]),
      sourceRef("Solomon peg arbitrage", "https://docs.solomonlabs.org/usdv/usdv-and-susdv/peg-arbitrage-mechanism", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as the whitelisted USDv to USDC redemption path via Solomon protocol reserves, not as full strategy-collateral redeemability.",
      "The documented 0.5% reserve buffer is the immediate capacity bound; strategy assets and derivatives backing remain outside immediate redemption capacity.",
    ],
  }),
  "weusd-picwe": defineStablecoinRedeemConfig({
    ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
    outputAssets: ["usdc-circle"],
    costModel: fixedFee(100, "PicWe docs describe a 1% WEUSD redemption fee"),
    docs: [
      sourceRef("PicWe WEUSD", "https://docs.picwe.org/what-is-weusd", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("PicWe mint and redeem", "https://docs.picwe.org/mint-and-redeem", ["route", "fees"]),
    ],
  }),
  "autousd-auto-finance": defineStablecoinRedeemConfig({
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.05, basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(
      0,
      "Auto Finance autopool redeem/withdraw burns autoUSD shares for USDC without a separate exit-fee deduction; streaming and periodic fees are NAV/accounting fees",
    ),
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    docs: [
      sourceRef("Auto Finance autopools overview", "https://docs.auto.finance/auto-pools-protocol/autopools-tl-dr.md", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Auto Finance protocol mechanics",
        "https://docs.auto.finance/auto-pools-protocol/protocol-mechanics.md",
        ["route", "capacity", "access", "settlement"],
      ),
      sourceRef(
        "Auto Finance contract addresses",
        "https://docs.auto.finance/developer-docs/contracts-overview/contract-addresses",
        ["route", "capacity", "access"],
      ),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the autopool's idle USDC balance as current direct redemption capacity; the reviewed 5% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
    ],
  }),
  "eearn-ember": defineStablecoinRedeemConfig({
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata", basis: "live-direct-telemetry" },
    executionModel: "rules-based-nav",
    v9RouteReviewTerms: { settlementModel: "queued" },
    costModel: fixedFee(
      0,
      "On-chain ERC-4626 check on the eEARN contract (Ethereum 0x9be9...cafa2) shows previewRedeem equals convertToAssets, so no exit/withdrawal fee is currently skimmed; the fee is admin-configurable and presently zero",
    ),
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    docs: [
      sourceRef("Ember Earn", "https://trade.bluefin.io/ember/eEARN", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Ethereum eEARN contract",
        "https://etherscan.io/address/0x9be9294722f8aad37b11a9792be2c782182cafa2#readContract",
        ["route", "capacity", "access"],
      ),
      sourceRef("Royco Dawn eEARN market", "https://dawn.royco.org/", ["route", "capacity"]),
    ],
    notes: [
      "The holder path submits a request to an operator-processed queue. The V9 route overlay therefore uses queued settlement; no positive capacity is eligible for the shared 300-second horizon without a bounded completion path.",
      "Fresh specialized telemetry pins the vault, validator, protocol-config proxies and implementations, reads pause/queue state and the current admin-configurable fee, and keeps idle USDC diagnostic-only. Identity or state-read drift fails closed with no static capacity fallback.",
    ],
  }),
};

applyTrackedReviewedDocs(RAW_STABLECOIN_REDEEM_BACKSTOP_CONFIGS, [
  "ousg-ondo-finance",
  "u-united-stables",
  "usd0-usual",
]);
applyTrackedReviewedDocs(
  RAW_STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
  ["dusd-dtrinity", "yousd-yield-optimizer"],
  REVIEWED_REMEDIATION_AT,
);
applyTrackedReviewedDocs(
  RAW_STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
  ["pusd-polymarket", "susd-solayer", "usx-dforce", "xdai-gnosis"],
  REVIEWED_STABLECOIN_BATCH_AT,
);

export const STABLECOIN_REDEEM_BACKSTOP_ENTRIES = defineRecordEntries(RAW_STABLECOIN_REDEEM_BACKSTOP_CONFIGS, {
  sourceFilePath: SOURCE_FILE_PATH,
});

export const STABLECOIN_REDEEM_BACKSTOP_CONFIGS = defineBackstopRegistry(STABLECOIN_REDEEM_BACKSTOP_ENTRIES);
