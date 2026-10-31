import type { RedemptionBackstopConfig } from "./shared";
import { defineRecordEntries, finalizeBackstopRegistry } from "./factory";
import {
  basketRedeemBase,
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  fixedFee,
  psmSwapBase,
  sourceRef,
  sourceRefFull,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
  sourceRefRouteCapacityFees,
} from "./shared";
import {
  REVIEWED_EXIT_CREDIT_AT,
  REVIEWED_FIRST_WAVE_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
  REVIEWED_MAY_BATCH_AT,
  REVIEWED_REMEDIATION_AT,
  REVIEWED_YIELD_COVERAGE_WAVE_AT,
} from "./review-dates";

const REVIEWED_BASKET_REDEMPTION_AT = REVIEWED_FIRST_WAVE_AT;
const REVIEWED_ROUTE_TUNING_AT = "2026-04-04";
const REVIEWED_RESERVE_PROTOCOL_DTF_AT = REVIEWED_MAY_BATCH_AT;
const REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT = "2026-07-19";
const REVIEWED_MENTO_XOFM_PSM_AT = "2026-07-27";
const reviewedBasketRedemptionSupplyFull = documentedBoundSupplyFull(REVIEWED_BASKET_REDEMPTION_AT);

const RAW_PSM_AND_BASKET_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "usdon-ondo": {
    ...psmSwapBase,
    executionModel: "rules-based-nav",
    capacityModel: { kind: "unquantified" },
    reviewedAt: "2026-10-20",
    accessModel: "whitelisted-onchain",
    holderEligibility: "whitelisted-primary",
    settlementModel: "atomic",
    outputAssets: ["usdc-circle"],
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Ondo documents gross 1:1 USDon/USDC swaps for separately whitelisted callers, subject to opposite-token inventory. The verified USDonManager delegates redemption to BaseRWAManager, including the configured redemption-fee module and user-specific registry/router checks. Public gross-parity wording does not establish a complete current request-specific fee, gas or net-output bound.",
    ),
    docs: [
      sourceRef("Ondo available assets", "https://docs.ondo.finance/ondo-stocks/available-assets.md", ["route"]),
      sourceRef(
        "Ondo investing and redeeming",
        "https://docs.ondo.finance/ondo-global-markets/investing-and-redeeming",
        ["route", "access", "settlement"],
      ),
      sourceRef("Ondo Stocks fee and gas disclosure", "https://docs.ondo.finance/ondo-stocks/fees-and-taxes.md", ["fees"]),
      sourceRef("USDonManager verified redemption source", "https://eth.blockscout.com/api/v2/smart-contracts/0x05CCbB4b74854f8A067b83475E8c34f5a413D7e1", ["route", "access", "fees", "settlement"]),
    ],
    notes: [
      "Corrected 2026-10-20: the configured channel is an inventory-dependent, separately whitelisted on-chain USDon-to-USDC swap, not fiat USD redemption. The earlier full-supply documented-bound model was unsupported by the cited platform backing and stock-redemption disclosures and is withdrawn; neither full-supply eventual capacity nor a replenishment completion guarantee is inferred.",
    ],
  },
  "usdxl-last": {
    ...psmSwapBase,
    reviewedAt: "2026-10-11",
    capacityModel: { kind: "unquantified" },
    holderEligibility: "any-holder",
    outputAssets: ["usdt-tether"],
    costModel: documentedVariableFee(
      "GSM buyAsset charges getBuyFee through the mutable fee strategy; no binding all-in numeric maximum is established. Gas is separate.",
      "formula",
    ),
    docs: [
      sourceRef("HypurrFi USDXL live Burn interface", "https://app.hypurrfi.com/usdxl", ["route"]),
      sourceRef("Exact HyperEVM USDXL GSM proxy", "https://hyperevmscan.io/address/0xcb17105f6a7a75d1f1c91317a4621d9aaafe96fd#code", ["route"]),
      sourceRef("Exact verified GsmWithHyFiPool implementation and inherited Gsm", "https://sourcify.dev/server/v2/contract/999/0xdc6ed7834f8693fc2691e1b70ea0ccec557c8f26?fields=sources,abi,compilation", ["route", "access", "capacity", "settlement", "fees"]),
      sourceRef("Pinned HyperEVM identity observation at block 48242188", "https://rpc.hyperliquid.xyz/evm", ["route"]),
      sourceRef("HypurrFi agent reference retains contradictory not-enabled text", "https://docs.hypurrfi.com/agents/usdxl", ["route"]),
    ],
    notes: [
      "Sol curation campaign 2026-10-11 (G58EUROT), reviewed 2026-10-11T08:41:59Z. HyperEVM USDXL 0xca79db4b49f608ef54a5cb813fbed3a6387bc645 is redeemed through GSM proxy 0xcb17105f6a7a75d1f1c91317a4621d9aaafe96fd into USDt0 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb (tracked as usdt-tether). No HyperCore-to-HyperEVM conversion or whole-deployment availability is certified.",
      "Exact implementation 0xdc6ed7834f8693fc2691e1b70ea0ccec557c8f26 exposes inherited permissionless buyAsset(minAmount, receiver): approve USDXL, transferFrom the holder, burn gross USDXL and transfer underlying in the same transaction. notFrozen/notSeized and available liquidity/current exposure constrain execution; a revert is not evidence of whole-asset exhaustion. The separate buyHyAsset output is a lending receipt and is not included in this route.",
      "Observed 2026-10-11T08:41:02.546Z at block 48242188, hash 0xc62a075168a1e32283bf5179255452cc1d2936d058c3f6cb896859e00c77c96f, timestamp 2026-10-11T08:40:05Z: EIP-1967 implementation, USDXL_TOKEN and UNDERLYING_ASSET match the exact identities; getIsFrozen and getIsSeized return false. These snapshots are not a permanent open-state guarantee or exact-request execution certificate.",
      "The live app advertises Burn USDXL to redeem USDT0, subject to available liquidity. The agent-reference bundle still says direct redemptions are not currently enabled; verified exact implementation, pinned identities and displayed Buy Asset transactions corroborate the current route without inventing its launch date. No supply-full bound, static sampled capacity, zero fee, fee maximum or end-to-end cross-chain settlement bound is authored.",
    ],
  },
  "cusd-cap": {
    ...basketRedeemBase,
    ...reviewedBasketRedemptionSupplyFull,
    outputAssets: ["usdc-circle", "wtgxx-wisdomtree"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: documentedVariableFee(
      "The cUSD vault's inherited Minter sets a flat on-chain redeem fee, queryable via getRedeemFee() (currently 0 ray / 0 bps; whitelisted users pay 0%); dynamic mint/burn fees do not apply to proportional redemption beyond this flat fee",
      "formula",
    ),
    docs: [
      sourceRefRouteCapacity("Cap introduction", "https://docs.cap.app/"),
      sourceRefRouteCapacity("Cap cUSD mechanics", "https://docs.cap.app/protocol-overview/cusd-mechanics"),
      sourceRefRouteCapacityFees("Cap vault", "https://docs.cap.app/concepts/vault"),
      sourceRef("Cap risks", "https://docs.cap.app/risks", ["capacity", "settlement"]),
      sourceRef("Cap vault Minter", "https://docs.cap.app/concepts/vault/minter", ["fees"]),
      sourceRef("Cap Minter contract reference", "https://docs.cap.app/developers/contracts/minter.md", ["fees"]),
    ],
    notes: [
      "Cap docs describe cUSD as always redeemable against the underlying reserve basket, with dynamic interest rates preventing full utilization so withdrawals remain atomic",
      "At Ethereum block 25530449, the cUSD vault assets() list contained only USDC and wWTGXX; the live reserve config maps those contracts to usdc-circle and wtgxx-wisdomtree",
    ],
  },
  "honey-berachain": {
    ...basketRedeemBase,
    ...reviewedBasketRedemptionSupplyFull,
    capacityModel: { kind: "reserve-sync-metadata", basis: "live-direct-telemetry" },
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    outputAssets: ["usdc-circle", "usdt-tether", "pyusd-paypal", "usde-ethena"],
    costModel: {
      ...documentedVariableFee(
        "Normal redemptions are asset-specific: 0 bps for USDT/byUSD and 5 bps for USDC/USDe; stress Basket Mode returns a proportional collateral basket instead. The current collateral-specific fee table (reviewed 2026-10-03) caps the redemption fee at 5 bps; gas and live redeem-rate constraints remain",
      ),
      feeBpsMin: 0,
      feeBpsMax: 5,
    },
    docs: [
      sourceRefRouteCapacityFees("Berachain Honey docs", "https://docs.berachain.com/general/tokens/honey"),
      sourceRefRouteCapacityFees(
        "Berachain HoneyFactory source",
        "https://github.com/berachain/contracts/blob/main/src/honey/HoneyFactory.sol",
      ),
      sourceRef("Berachain BUSD collateral fee table (reviewed 2026-10-03)", "https://docs.berachain.com/general/tokens/busd", ["fees"]),
    ],
    notes: [
      "Modeled against Basket Mode because the stress-state redemption path turns exits into proportional basket withdrawals when collateral becomes unstable",
      "Capacity became live-direct 2026-08-12: the gated probe enumerates the HoneyFactory's registered assets and their collateral vaults, verifying the factory's own `honey()` resolves to the tracked token before reading vault holdings, so the documented full-supply model is replaced by what the vaults actually hold.",
      "The documented asset-specific fee schedule above is now bounded by live telemetry as well: the probe reads each asset's `redeemRates()` and takes the least favourable as the route's max fee.",
      "Verified at Berachain block 24750999: `honey()` resolved to the tracked token, `isBasketModeEnabled()` was false for both mint and redeem, all four registered assets read `isPegged()` true, and the vaults held 7,831,557.70 against a HONEY supply of 7,831,365.98. Live `redeemRates()` were 0 bps on three assets and exactly 5 bps on the fourth, matching the documented schedule.",
    ],
  },
  "dai-makerdao": {
    ...psmSwapBase,
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.33, basis: "psm-balance-share" },
    costModel: fixedFee(0, "LitePSM docs show fees are not activated for DAI <-> USDC"),
    notes: [
      "Fresh Sky reserve telemetry uses current PSM USDC balance as immediate capacity; fallback retains the reviewed 33% heuristic when live metadata is unavailable",
    ],
  },
  "usds-sky": {
    ...psmSwapBase,
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.33, basis: "psm-balance-share" },
    costModel: fixedFee(
      0,
      "USDS uses the LitePSMWrapper-USDS-USDC route, and Sky docs show LitePSM fees are not activated for the underlying DAI <-> USDC leg",
    ),
    notes: [
      "Fresh Sky reserve telemetry uses current PSM USDC balance as immediate capacity; fallback retains the reviewed 33% heuristic when live metadata is unavailable",
      "USDS <-> USDC routes through LitePSMWrapper-USDS-USDC and the fee-free DAI <-> USDS converter, so it shares the same LitePSM liquidity path as DAI",
    ],
  },
  "xofm-mento": {
    ...psmSwapBase,
    outputAssets: ["cusd-celo"],
    capacityModel: { kind: "reserve-sync-metadata", basis: "live-direct-telemetry" },
    costModel: documentedVariableFee(
      "The Mento Broker/BiPoolManager records the XOFm/USDm pool spread on-chain; live telemetry supplies the current per-pool spread.",
      "formula",
    ),
    reviewedAt: REVIEWED_MENTO_XOFM_PSM_AT,
    docs: [
      sourceRef(
        "Mento Broker contract (pinned)",
        "https://github.com/mento-protocol/mento-core/blob/07ecf3df5650a33ea6957f1ad2966e02c5082253/contracts/swap/Broker.sol",
        ["route", "access", "settlement"],
      ),
      sourceRefRouteCapacityFees(
        "Mento BiPoolManager contract (pinned)",
        "https://github.com/mento-protocol/mento-core/blob/07ecf3df5650a33ea6957f1ad2966e02c5082253/contracts/swap/BiPoolManager.sol",
      ),
      sourceRef("Mento stable assets on Celo", "https://docs.mento.org/mento-v3/other/getting-mento-stables/on-celo", [
        "route",
        "access",
      ]),
    ],
    notes: [
      "XOFm's legacy Mento Broker route is a permissionless atomic XOFm -> USDm swap, rather than the CDP collateral-redemption route used by Mento's CDP-backed FX assets.",
      "Fresh Mento telemetry enumerates the XOFm/USDm BiPoolManager exchange on Celo each run and uses its USDm counter bucket as the live direct capacity bound; the adapter fails closed if the exchange identity, counter bucket, or spread cannot be read.",
      "USDm is tracked as cusd-celo, so the direct Broker output is a scoreable stablecoin output without asserting a fiat or reserve-basket redemption.",
    ],
  },
  "dllr-sovryn": {
    ...basketRedeemBase,
    reviewedAt: "2026-10-05",
    outputAssetType: "stable-single",
    capacityModel: { kind: "reserve-sync-metadata" },
    unresolvedOutputAssetKeys: ["asset:zusd", "doc-money-on-chain"],
    unresolvedOutputDisposition: "reviewed-external",
    costModel: documentedVariableFee("Mynt fees are currently disabled but can be enabled; evaluate the selected bAsset redemption fee and gas at the actual notional", "formula"),
    docs: [
      sourceRef("Mynt selected bAsset redemption", "https://build.sovryn.com/builder-portal/smart-contracts/mynt", ["route", "fees", "settlement"]),
      sourceRefRouteCapacityAccess("Sovryn Dollar", "https://sovryn.com/sovryn-dollar"),
      sourceRef("Launching the Sovryn Dollar", "https://sovryn.com/all-things-sovryn/launching-the-sovryn-dollar", [
        "route",
        "settlement",
      ]),
      sourceRef("Mynt app", "https://app.mynt.xyz/", ["route", "capacity", "fees", "settlement"]),
    ],
    notes: [
      "Mynt redeems DLLR 1:1 into holder-selected DOC or ZUSD, not a proportional reserve basket. Both diagnostic identities remain visible; no weights or DOC-only output are inferred.",
      "Separate exact DOC/ZUSD request observations and fresh USD output valuation are required before attributing executable branch capacity. Raw Mynt backing balances do not prove holder-selected same-notional capacity; ZUSD remains externally unpriced.",
    ],
  },
  "xusd-babelfish": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_YIELD_COVERAGE_WAVE_AT),
    outputAssetType: "stable-basket",
    outputAssets: ["dllr-sovryn", "doc-money-on-chain", "usdt-tether", "usdc-circle", "dai-makerdao", "usdrif-rif"],
    costModel: documentedVariableFee(
      "BabelFish uses basket-balancing withdrawal fees rather than one fixed public redemption fee",
    ),
    v9RouteCostTerms: {
      feeBpsMax: 1_000,
      publishedFeeSchedule: {
        reviewedAt: "2026-10-10",
        reviewer: "Sol curation campaign 2026-10-11 (K4ExitTermsModel)",
        docs: [sourceRefFull("BabelFish published balancing-curve maximum penalty", "https://babelfish.gitbook.io/the-babelfish-gitbook/getting-started/balancing-curves.md")],
        rationale: "Published Balancing Curves Parameters cap the withdrawal penalty at 10%. Use the maximum, not a sampled basket imbalance or a zero-reward branch. This is a conservative protocol deduction bound above the 200-bps request budget, not an exact execution quote or a gas-cost guarantee.",
      },
    },
    reviewedAt: REVIEWED_YIELD_COVERAGE_WAVE_AT,
    docs: [sourceRefFull("BabelFish", "https://babelfish.money/")],
    notes: [
      "Fresh reserve sync reads the BabelFish holder's accepted bAsset balances on Rootstock, but redemption capacity remains documented-bound because the adapter does not emit a dedicated route-capacity field",
    ],
  },
  "eur0-usual": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT),
    accessModel: "whitelisted-onchain",
    holderEligibility: "whitelisted-primary",
    outputAssetType: "mixed-collateral",
    outputAssets: ["asset:eutbl"],
    costModel: fixedFee(
      3,
      "Usual documents a 3 bps fee for the permissioned direct EUR0 redemption into euTBL",
    ),
    docs: [
      sourceRefRouteCapacityAccess("Usual EUR0 docs", "https://tech.usual.money/overview/features/eur0"),
      sourceRef("Usual EUR0 contract docs", "https://tech.usual.money/smart-contracts/token-contracts/eur0", [
        "route",
        "access",
      ]),
      sourceRef("Usual EUR0 product docs", "https://docs.usual.money/usual-products/usd0-stablecoin/eur0-stablecoin", [
        "route",
        "access",
        "fees",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as the Usual dApp basket redemption route into eligible euro-denominated RWA collateral, primarily Spiko EUTBL, rather than a direct fiat EUR issuer rail.",
      "Output declared 2026-07-19: the Usual EUR0 product docs state redemption burns EUR0 to receive euTBL (Spiko EU T-Bills MMF) at par on the permissioned route, and the tech docs list EUTBL by Spiko as the sole EUR0 collateral entry; the permissionless Swapper Engine leg settles in EURC subject to liquidity and is not the modeled route.",
      "Fee bound declared 2026-08-24 from the Usual EUR0 page updated 2026-02-16: the modeled permissioned direct route burns EUR0 for euTBL at par minus 3 bps. The separate permissionless EURC route can queue for T+1 to T+5 when buffers are empty and is not used for this cost bound.",
      "Source-scoped correction, verified 2026-10-20: the modeled direct euTBL path is restricted to Spiko Permission Manager allowlisted addresses and requires KYC/KYB. It must not inherit permissionless basket access from the separate EURC Swapper Engine path. Original output, fee and capacity review starts remain unchanged; no new capacity or settlement bound is asserted.",
    ],
  },
  "gho-aave": {
    ...psmSwapBase,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      10,
      "Fresh live mainnet GSM telemetry uses the current worst tracked buy fee; the reviewed fallback bound is 10 bps when telemetry is unavailable",
    ),
    reviewedAt: REVIEWED_ROUTE_TUNING_AT,
    docs: [
      sourceRef("Aave Stability Module", "https://aave.com/help/gho-stablecoin/stability-module", ["route", "fees"]),
    ],
    notes: [
      "Immediate capacity is sourced from live tracked mainnet GSM backing and excludes frozen or seized modules at runtime",
      "When reserve sync is degraded only because residual GHO issuance remains outside configured GSM modules, redemption still uses the tracked swappable GSM backing as a conservative live lower bound instead of dropping the route entirely",
    ],
  },
  "usdd-tron-dao-reserve": {
    ...psmSwapBase,
    outputAssets: ["usdt-tether"],
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.16, confidence: "documented-bound" },
    costModel: fixedFee(
      0,
      "USDD docs describe 1:1 PSM conversions between USDD and USDT/USDC/TUSD, and the deployed Tron PSM's `tout()` reads 0 bps on-chain",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    docs: [
      sourceRefRouteCapacityFees("USDD documentation", "https://docs.usdd.io"),
      sourceRef("USDD website", "https://usdd.io/", ["capacity"]),
    ],
    notes: [
      "Fresh live telemetry reads the Tron PSM GemJoin's current USDT balance as the direct redeemable bound, after confirming the module's identity wiring and that buying is enabled",
      "The reviewed 16% bound is retained only as the fallback when that live read is unavailable; it matches the tracked USDT PSM reserve share and does not claim the full collateralized USDD system is instantly redeemable through the PSM",
    ],
  },
  "ist-agoric": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.6, confidence: "documented-bound", basis: "psm-balance-share" },
    costModel: undisclosedReviewedFee(
      "Inter Protocol docs describe 1:1 PSM trades between IST and approved external stable tokens, but public docs reviewed do not publish a numeric redemption fee",
    ),
    routeStatus: "unknown",
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    docs: [
      sourceRefFull(
        "Inter Protocol Parity Stability Module",
        "https://docs.inter.trade/inter-protocol-system-documentation/parity-stability-module",
      ),
      sourceRef(
        "Sunset Inter Protocol and Begin Wind-Down Process",
        "https://community.agoric.com/t/sunset-inter-protocol-and-begin-wind-down-process/787",
        ["route", "capacity", "settlement"],
      ),
    ],
    notes: [
      "Route status set to unknown 2026-08-12: the DCF signaling proposal to sunset Inter Protocol (posted 2025-04-16, voting 2025-04-26 to 2025-04-29) disables new IST vault minting, escalates vault liquidation ratios weekly through 2025-06-26, and targets full shutdown by 2025-06-30, so the reviewed PSM terms below can no longer be assumed open.",
      "The reviewed 60% bound matches tracked metadata's PSM stablecoin-reserve share and does not claim the overcollateralized vault portion is instantly redeemable through the PSM",
      "PSM output is an approved external stable token selected by governance; IBC transfer and venue-specific wrapper risk are outside this route score",
    ],
  },
  "fxd-fathom": {
    ...psmSwapBase,
    accessModel: "whitelisted-onchain",
    outputAssets: ["usdt-tether"],
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "psm-balance-share" },
    costModel: fixedFee(
      25,
      "The Fathom whitepaper states a fee of 0.25% is charged for each trade in the Stable Swap module",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    docs: [
      sourceRef("Fathom whitepaper v1.0", "https://docs.fathom.fi/whitepaper/version-1.0", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "FXD smart-contract architecture",
        "https://docs.fathom.fi/fxd-stablecoin/fxd-smart-contract-architecture",
        ["route", "settlement"],
      ),
      sourceRef("FXD XDC deployments", "https://docs.fathom.fi/fxd-stablecoin/deployments/xdc-network", ["route"]),
      sourceRef("Fathom StableSwapModule on XDC", "https://xdcscan.io/address/0x42c06188B8C03769A1F73B3f31b259271ee3B981", [
        "route",
      ]),
    ],
    notes: [
      "Configured 2026-08-12 as the StableSwap Module rail, not CDP repayment: the whitepaper describes trading FXD at a fixed 1 FXD = 1 counter-stablecoin rate inside a pool, which is a holder-exercisable swap rather than the position-specific debt repayment that previously kept this coin unconfigured.",
      "Access is whitelisted because the same whitepaper states Stable Swap keeps a private list of possible participants to protect the pegging mechanism, and that the FXD Stable Swap arbitrager group is private and not publicly open.",
      "Output resolved 2026-09-01: the smart-contract architecture page names the deployed pair FXD<->xUSDT, and the documented XDC StableSwapModule 0x42c06188B8C03769A1F73B3f31b259271ee3B981 was read at XDC mainnet block 106731562 (chainId 50): stablecoin() = 0x49d3f7543335cf38fa10889ccff10207e22110b5 (the tracked FXD deployment) and token() = 0xd4b5f10d61916bd6e0860144a91ac658de8a1437, whose symbol() is xUSDT, name() is USDT@xinfin, and decimals() is 6. That is the exact XDC deployment Pharos already tracks under usdt-tether, so the counter-stablecoin is a tracked output rather than an untracked external identity.",
      "The 10% ratio is a reviewed heuristic for StableSwap pool depth, not a published Fathom figure: no current public source exposes the module's counter-asset balance, per-account limits, or pause state on XDC, and Pharos does not model XDC contracts.",
    ],
  },
  "hollar-hydrated": {
    ...psmSwapBase,
    unresolvedOutputAssetKeys: ["asset:ausdt", "asset:ausdc"],
    unresolvedOutputDisposition: "reviewed-external",
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "psm-balance-share" },
    costModel: documentedVariableFee(
      "Hydration's HSM charges a per-collateral `buy_back_fee` held on-chain as a Permill in the pallet's Collaterals storage; the published HOLLAR documentation does not publish that fee as a number",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    docs: [
      sourceRefRouteCapacityAccess("Hydration HOLLAR", "https://docs.hydration.net/products/hollar/"),
      sourceRefRouteCapacity("Hydration HOLLAR quick start", "https://docs.hydration.net/quick_start/hollar/"),
      sourceRef(
        "Hydration HSM pallet types",
        "https://raw.githubusercontent.com/galacticcouncil/hydration-node/master/pallets/hsm/src/types.rs",
        ["fees", "capacity"],
      ),
      sourceRef(
        "Hydration HSM pallet",
        "https://raw.githubusercontent.com/galacticcouncil/hydration-node/master/pallets/hsm/src/lib.rs",
        ["route", "access", "fees", "settlement"],
      ),
      sourceRefRouteCapacity(
        "Hydration referendum 367: consolidate HSM collateral",
        "https://hydration.subsquare.io/referenda/367",
      ),
    ],
    notes: [
      "The modeled route is the Hollar Stability Mechanism's `sell` extrinsic, which is a holder-facing PSM swap rather than CDP repayment: the pallet takes any signed origin, burns the received HOLLAR, and pays the seller the configured collateral asset atomically.",
      "Capacity is conditional by design. Hydration's own documentation states the HSM does not blindly buy any amount of HOLLAR at any time and instead decides when and how much to buy from stableswap-pool conditions; the pallet enforces that through a per-block buyback limit, a maximum buy price coefficient, and the HSM's collateral balance. The 10% ratio is a reviewed heuristic standing in for those unpublished limits, not a Hydration figure.",
      "Output is one configured collateral asset per sale, not a basket: governance referendum 367 consolidates HSM collateral to aUSDT and aUSDC only. Neither has a tracked Pharos stablecoin id, so both reviewed identities are preserved as unresolved external outputs.",
      "No fee bound is declared because `buy_back_fee` is a per-collateral on-chain Permill set by governance with no documented ceiling, and Pharos has no Hydration adapter to read its current value each run.",
    ],
  },
  "usdh-hubble": {
    ...psmSwapBase,
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "psm-balance-share" },
    costModel: fixedFee(
      50,
      "Hubble's Peg Stability Module documentation lists 50 bps (0.5%) for depositing USDH to redeem another stablecoin, against 0 bps to mint",
    ),
    routeStatus: "unknown",
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    docs: [
      sourceRef(
        "Hubble Peg Stability Module",
        "https://docs.hubbleprotocol.io/faq/usdh-peg-stability/peg-stability-module",
        ["route", "fees", "settlement"],
      ),
      sourceRefRouteCapacity("Why use Hubble", "https://docs.hubbleprotocol.io/why-use-hubble"),
      sourceRef("Hubble technical resources", "https://docs.hubbleprotocol.io/resources/technical-resources", [
        "route",
      ]),
    ],
    notes: [
      "Configured 2026-08-12 as the documented PSM rail rather than CDP repayment: Hubble states USDH now maintains its peg primarily via the Peg Stability Module, which allows zero-slippage swaps between USDH and USDC, so the exit is available to holders who never opened a vault.",
      "Route status is unknown, not open. Hubble publishes no PSM reserve-account mapping, capacity source, or pause flag, so nothing current proves the swap still executes. The USDH mint remains live on Solana — supply read 1,130,512.428495 at slot 438751843 on 2026-08-12 — which is why the route is modeled at all rather than rejected.",
      "The 10% ratio is a reviewed heuristic for PSM USDC inventory and is not a published Hubble figure; it deliberately does not claim the overcollateralized vault system is instantly redeemable through the module.",
    ],
  },
  "pmusd-precious-metals": {
    ...psmSwapBase,
    outputAssets: ["susds-sky"],
    capacityModel: { kind: "supply-ratio", ratio: 0.001, confidence: "heuristic", basis: "psm-balance-share" },
    costModel: fixedFee(25, "RAAC PSM docs specify a 25 bps swap fee for pmUSD → sUSDS exits"),
    reviewedAt: "2026-05-02",
    docs: [
      sourceRef("RAAC PSM overview", "https://docs.raac.io/psm-vault/", ["route", "fees"]),
      sourceRefRouteCapacityFees("RAAC PSM parameters", "https://docs.raac.io/parameters-psm/"),
    ],
    notes: [
      "PSM is one-directional: pmUSD → sUSDS swaps only; swaps pause automatically when sUSDS reserves fall below 20% of total PSM assets",
      "PSM was recently deployed; on-chain sUSDS balance at review (~$47K) is a small fraction of total supply — 0.1% ratio is a heuristic that will understate capacity as TVL grows",
      "Output is sUSDS (Sky savings wrapper), instantly redeemable 1:1 to USDS at no fee, adding one unwrap step before reaching a stable base asset",
    ],
  },
  "dola-inverse-finance": {
    ...psmSwapBase,
    outputAssets: ["usds-sky"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      20,
      "Inverse FiRM docs list a 20 bps DOLA -> USDS exit fee, and the deployed PSM's `sellFeeBps()` reads 20 on-chain",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    docs: [
      sourceRefRouteCapacityFees(
        "Inverse Peg Stability Module",
        "https://docs.inverse.finance/inverse-finance/inverse-finance/products/peg-stability-module",
      ),
      sourceRef("Inverse Finance transparency", "https://www.inverse.finance/transparency", ["capacity"]),
    ],
    notes: [
      "Modeled against the USDS PSM rail rather than full-system FiRM debt unwinds; the route never claimed that full DOLA supply is instantly redeemable",
      "Capacity correction 2026-08-12, re-pinned 2026-10-29: the prior reviewed 8% PSM-share bound was stale and is removed. Two deployments exist. The original PSM 0x4dfd662622d766304cb539e66f893c4defa19398 (deployed 2025-08-10) was drained on 2025-12-10 — at block 25736814 it read `supply() = 0` and `getTotalReserves() = 0` with zero balances of both tokens — and is historical. The canonical PSM 0x1d02f2841afa3cc20435a8c804c24deac5f30dfa has been live since proposal 343 executed 2025-12-20 (block 24051640; the PSM Fed 0x67fc21332d24fc5250a3b7fc988191ad7f38f9cc `psm()` points to it); at Ethereum block 26296822 it read `supply() = 0`, `getTotalReserves() = 0` and `sellFeeBps() = 20` while holding 200,000 DOLA of buy inventory. `sell()` reverts at any size while `supply() = 0`, so sell capacity arises only from prior USDS -> DOLA buys.",
      "Capacity is therefore live-only. Fresh telemetry reads the PSM's current reserves as the direct redeemable bound, and when that read is unavailable the route is left unrated rather than falling back to the phantom static share the empty contract cannot honor.",
    ],
  },
  "buck-bucket-protocol": {
    ...psmSwapBase,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    capacityModel: { kind: "unquantified" },
    costModel: undisclosedReviewedFee(
      "No current exact-BUCK PSM fee schedule was established. The published 30 bps PSM OUT tariff is for USDB, not legacy BUCK; fee-free BUCK-to-USDB migration does not bound the complete stablecoin exit.",
    ),
    reviewedAt: "2026-10-20",
    docs: [
      sourceRef("Bucket legacy BUCK migration and fee-free 1:1 USDB conversion", "https://docs.bucketprotocol.io/user-guides/bucket-upgrade-and-migration.md", ["route", "fees"]),
      sourceRef("Bucket USDB PSM tariff and output scope", "https://docs.bucketprotocol.io/mechanism/usdb-peg.md", ["route", "fees"]),
    ],
    notes: [
      "Reviewed 2026-10-20: removed the unsupported 25% BUCK PSM capacity assumption and the USDB-scoped 30 bps tariff. Historical V1 reserve inventory and current V2 USDB collateral are not executable legacy BUCK payout capacity. This is a researched terms gap, not evidence of zero liquidity or a suspended channel.",
    ],
  },
  "lisusd-lista": {
    ...psmSwapBase,
    outputAssetType: "stable-basket",
    outputAssets: ["usdt-tether", "usdc-circle"],
    capacityModel: { kind: "supply-ratio", ratio: 0.15, dailyLimitUsd: 500_000, confidence: "documented-bound" },
    costModel: fixedFee(
      200,
      "Lista docs list a 2% fee on lisUSD -> centralized stablecoin conversions and a 500,000 lisUSD daily redemption limit",
    ),
    reviewedAt: REVIEWED_BASKET_REDEMPTION_AT,
    docs: [
      sourceRefRouteCapacityFees("Lista docs", "https://docs.bsc.lista.org"),
      sourceRef("Lista website", "https://lista.org/", ["route"]),
    ],
    notes: [
      "Docs also publish a 500,000 lisUSD daily redemption limit for PSM exits",
      "The reviewed 15% bound matches the tracked centralized-stablecoin PSM share rather than assuming the CDP-backed portion is instantly redeemable through the PSM",
    ],
  },
  "dusd-alto": {
    ...psmSwapBase,
    outputAssets: ["usdc-circle"],
    ...documentedBoundSupplyFull(REVIEWED_REMEDIATION_AT),
    costModel: fixedFee(
      20,
      "Alto docs describe a 0.20% (20 bps) fee on both PSM swap directions; PSM capacity is capped at 5M USDC which currently exceeds total DUSD supply",
    ),
    docs: [
      sourceRefRouteCapacityFees("Alto DUSD Peg Stability Module", "https://docs.alto.money/alto-protocol/psm"),
    ],
  },
  "silk-shade-protocol": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT),
    outputAssetType: "mixed-collateral",
    unresolvedOutputDisposition: "issuer-undisclosed",
    reviewedAt: "2026-08-27",
    costModel: undisclosedReviewedFee(
      "Shade Protocol documents Silk redemption pools plus ShadeDAO bond-assisted arbitrage; public docs reviewed do not publish a single fixed bps redemption fee",
    ),
    docs: [
      sourceRefRouteCapacity("Shade Protocol Silk docs", "https://docs.shadeprotocol.io/silk"),
      sourceRef(
        "Shade Lend stability mechanisms",
        "https://docs.shadeprotocol.io/shade-protocol/advanced-topics-apps/lend/stability-mechanisms",
        ["route", "fees"],
      ),
    ],
    notes: [
      "Silk tracks a basket of GDP-weighted currencies; redemption pools combined with ShadeLend overcollateralization provide a reviewed basket-exit rail rather than a single-stable PSM",
      "Output asset type is mixed-collateral because the redeemed basket is not guaranteed to be all-stablecoin; it can include native Shade collateral assets",
      "Output re-reviewed 2026-08-27: Shade Lend docs state a holder may redeem SILK for collateral from a chosen vault, repaying and receiving pro-rata shares of that vault. The public documentation does not publish a canonical current vault whitelist; its membership is governance-mutable, and the earlier wBTC/USDC evidence was not current issuer-primary documentation. outputAssets is intentionally unset rather than publishing a partial payout composition.",
    ],
  },
  "eusd-electronic-usd": {
    ...basketRedeemBase,
    ...reviewedBasketRedemptionSupplyFull,
    capacityModel: { kind: "reserve-sync-metadata" },
    outputAssets: ["usdc-circle", "usdt-tether"],
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    costModel: fixedFee(
      0,
      "Reserve's documented DTF fee schedule has exactly two fees — a TVL fee and a mint fee charged whenever a user mints new DTF tokens — so redeeming the pro-rata basket is charged 0 bps",
    ),
    docs: [
      sourceRefRouteCapacityAccess(
        "Reserve DTF minting & redeeming",
        "https://docs.reserve.org/core-components/index-dtfs/minting-and-redeeming",
      ),
      sourceRef("Reserve DTF fees", "https://docs.reserve.org/core-components/index-dtfs/fees", ["fees"]),
      sourceRef("Reserve DTF mint fee", "https://docs.reserve.org/core-components/index-dtfs/fees/mint-fee", ["fees"]),
      sourceRef(
        "Reserve Electronic USD overview",
        "https://app.reserve.org/ethereum/token/0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f/overview",
        ["capacity"],
      ),
    ],
    notes: [
      "Redemption requires receiving the underlying basket composition rather than selecting a single stablecoin output",
      "Fee bound declared 2026-08-12: the Reserve fee documentation enumerates a closed schedule of a TVL fee and a mint fee applied \"whenever a user mints new DTF tokens\", and the minting-and-redeeming page describes redemption as a permissionless direct conversion back into the underlying tokens with no charge, so the reviewed ceiling is 0 bps. The previously cited reserve-index doc URLs now 404 and were repointed to their core-components successors.",
      "Capacity became live-only 2026-08-12, matching the USD3 treatment: the route migrated to the Reserve DTF adapter, which reads the RToken's own `redemptionAvailable()` throttle each run as the direct redeemable bound, so the prior documented-bound full-supply model is removed with no fallback. The throttle refills over time and shrinks as it is drawn down, so no static supply figure represents it and an unavailable read leaves the route unrated rather than restoring full supply.",
      "Verified at Ethereum block 25737172: `redemptionAvailable()` returned exactly 5,000,000.00 against a supply of 22,834,920.56, and the basket handler reached through the RToken's own `main()` reported status SOUND (0). The throttle is therefore binding at roughly 22% of supply, which is what the full-supply model had been overstating.",
    ],
  },
  "usd3-reserve-protocol": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_RESERVE_PROTOCOL_DTF_AT),
    unresolvedOutputAssetKeys: [
      "susds-sky",
      "asset:ethereum:0x0adc69041a2b086f8772acce2a754f410f211bed",
      "asset:ethereum:0x27f2f159fe990ba83d57f39fd69661764bebf37a",
      "asset:ethereum:0xbeef01735c132ada46aa9aa4c54623caa92a64cb",
    ],
    unresolvedOutputDisposition: "reviewed-external",
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    // The RToken's `redemptionAvailable()` throttle is a USD capacity bound over
    // RToken units; it does not observe which receipt tokens the basket pays out,
    // so requiring the unresolved receipt identities would discard every read.
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    costModel: fixedFee(
      0,
      "Reserve Yield DTF revenue is documented as onchain collateral yield and issuer revenue shares rather than a user-charged redemption fee, and redemption returns the entire backing basket, so the reviewed ceiling is 0 bps",
    ),
    notes: [
      "Capacity became live-only 2026-08-12: the adapter now reads the RToken's own `redemptionAvailable()` throttle each run as the direct redeemable bound, so the prior documented-bound full-supply model is removed. The throttle refills over time and shrinks as it is drawn down, so a static supply figure would consistently overstate what a holder can exit right now.",
      "The read also degrades on basket state: when the collateral basket is not SOUND the measured capacity is withheld rather than published, and if the throttle cannot be read at all the route is left unrated instead of falling back to a static bound",
      "Fee bound declared 2026-08-12: the Yield DTF overview states holders can mint by depositing the complete collateral basket and that a DTF is \"redeemed for the entire basket as well\", with protocol revenue coming from \"yield from lending collateral tokens onchain, revenue shares with collateral token issuers, or any other source of onchain yield\" — no redemption charge. Throttles still bound redemption size, which the documented-bound capacity model already carries, not its cost.",
      "Source-scoped correction. Source-scoped output correction researched 2026-10-20; the original August 12 route review and historical capacity/fee pins remain unchanged. Reserve's current exact USD3 basket and verified RTokenP1 redeemTo transfer sUSDS, Static Aave Ethereum USDC receipts, wrapped Compound USDCv3 receipts and legacy Steakhouse USDC V1 shares directly to the holder. These are not a payout of native USDC or the separately tracked Steakhouse V2 shares. The full four-member output identity set is retained as unresolved until exact receipt valuation or a measured composed unwrap route is admitted; underlying NAV conversion arithmetic is not executed holder unwind capacity.",
    ],
    docs: [
      sourceRefFull("Reserve Yield DTF overview", "https://docs.reserve.org/core-components/yield-dtfs/overview"),
      sourceRef("Reserve DTF API", "https://api.reserve.org/discover/dtfs", ["capacity"]),
      sourceRef(
        "Reserve USD3 app",
        "https://app.reserve.org/ethereum/token/0x0d86883faf4ffd7aeb116390af37746f45b6f378/overview",
        ["capacity"],
      ),
      sourceRef(
        "Verified exact USD3 RTokenP1 redeemTo collateral-transfer semantics (retrieved 2026-10-20)",
        "https://eth.blockscout.com/api/v2/smart-contracts/0x258ce833cf9ad19208372763a00aa1565dd40b3c",
        ["route"],
      ),
      sourceRef(
        "Exact legacy Steakhouse USDC V1 receipt identity (retrieved 2026-10-20)",
        "https://eth.blockscout.com/api/v2/tokens/0xbeef01735c132ada46aa9aa4c54623caa92a64cb",
        ["route"],
      ),
    ],
  },
  "xmd-metal-dollar": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_FOLLOWUP_REMEDIATION_AT),
    unresolvedOutputAssetKeys: [
      "asset:xpr-network:xtokens:XUSDC",
      "asset:xpr-network:xtokens:XPYUSD",
      "asset:xpr-network:xtokens:XPAX",
    ],
    unresolvedOutputDisposition: "reviewed-external",
    reviewedAt: "2026-10-20",
    accessModel: "whitelisted-onchain",
    outputAssetType: "stable-basket",
    costModel: fixedFee(
      0,
      "Metal Dollar materials describe 1:1 redemption into supported basket stablecoins with no slippage, AMM dependency, or trading spread; no separate protocol redemption fee was identified",
    ),
    holderEligibility: "whitelisted-primary",
    routeExitCorrelation: "same-stablecoin-pool-backing",
    docs: [
      sourceRefRouteCapacityAccess("Metal Dollar product page", "https://www.metallicus.com/metal-dollar"),
      sourceRef(
        "XPR Network XMD redeem guide",
        "https://help.xprnetwork.org/hc/en-us/articles/11560190160151-How-do-I-redeem-Metal-Dollar-XMD",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRefRouteCapacity("Metal Dollar site", "https://metaldollar.com/"),
    ],
    notes: [
      "Holder must complete the XPR/Metal account-verification path and use WebAuth Wallet, so access is modeled as whitelisted onchain rather than permissionless.",
      "Pharos does not currently model XPR Network contracts, so this remains a static documented-bound route unless a supported-chain capacity adapter is added later.",
      "Source-scoped correction. The direct XMD redemption is an XPR Network treasury exchange into one selected basket token, including local xtokens XUSDC, XPYUSD or XPAX representations. These are not canonical Circle USDC, Paxos PYUSD or USDP. The reviewed guide does not establish a composed bridge withdrawal into those canonical assets, and current reserve research does not verify the wrapper escrow. Preserve the original documented route provenance and holder-verification requirement; keep the complete selected-output candidate set diagnostic without basket weights, combined capacity or canonical-parent valuation.",
    ],
  },
  "iusd-indigo-protocol": {
    ...psmSwapBase,
    outputAssetType: "stable-basket",
    unresolvedOutputAssetKeys: [
      "usdm-moneta",
      "usdc-circle",
      "asset:cardano:7d9e4a0ee1a3f5d5ff8159ea91a83310cf2795ee7a87170c7aea05ae.55534472",
    ],
    unresolvedOutputDisposition: "reviewed-external",
    capacityModel: { kind: "supply-ratio", ratio: 0.15577082, confidence: "heuristic", basis: "psm-balance-share" },
    costModel: fixedFee(100, "Indigo's current iUSD PSM data and app quote show a 1% redemption fee"),
    routeExitCorrelation: "same-protocol-liquidity",
    reviewedAt: "2026-10-20",
    docs: [
      sourceRef("Indigo redemptions", "https://docs.indigoprotocol.io/readme/redemptions", [
        "route",
        "access",
        "settlement",
        "fees",
      ]),
      sourceRef("Indigo v3 overview", "https://docs.indigoprotocol.io/readme/indigo-protocol-v3.md", ["route", "access"]),
      sourceRef(
        "Indigo governance proposal on RMR/redemption",
        "https://forum.indigoprotocol.io/t/proposal-for-adjusting-rmr-and-enable-redemption-for-iusd/13967",
        ["route", "fees"],
      ),
      sourceRef("Current Indigo protocol parameters API", "https://analytics.indigoprotocol.io/api/v3/protocol-params", ["access"]),
      sourceRefRouteCapacityFees("Current Indigo assets API", "https://analytics.indigoprotocol.io/api/v3/assets"),
      sourceRef("Koios exact iUSD PSM parameter output 4a595ebe037b6d1f4d2949edb9c775a748b5cfa9ac37cddf1fe6a9a66491b11d#0", "https://api.koios.rest/api/v1/utxo_info", ["route", "fees"]),
      sourceRef("Current Indigo asset analytics API", "https://analytics.indigoprotocol.io/api/v3/analytics/assets", ["capacity"]),
      sourceRef("Current Indigo swap application", "https://app.indigoprotocol.io/", ["route", "access", "fees"]),
      sourceRef(
        "Circle xReserve supported chains",
        "https://developers.circle.com/xreserve/references/supported-blockchains-and-domains",
        ["route", "settlement"],
      ),
    ],
    notes: [
      "Output re-reviewed 2026-10-20 from the official assets API: iUSD's stablePools array now contains three redemption-enabled pools, USDM, USDCx, and the additional exact Cardano asset 7d9e4a0ee1a3f5d5ff8159ea91a83310cf2795ee7a87170c7aea05ae.55534472 (USDr). Each reports a 1% redemption fee. The earlier two-pool census is not current.",
      "USDM is c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d and USDCx is 1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34.5553444378, the tracked Cardano deployments. The third output has no tracked Pharos identity or admitted USD valuation. Koios independently returned its exact unspent PSM parameter output 4a595ebe037b6d1f4d2949edb9c775a748b5cfa9ac37cddf1fe6a9a66491b11d#0, created at block 14093680, Unix time 1792513985, with matching asset bytes, 1:1 ratio, and 1/100 redemption fee. Keep the complete output-choice census diagnostic until a producer binds the selected pool and its output valuation; no equal weights, pro-rata payout, or partial-basket value is inferred.",
      "The 0.15577082 capacity ratio remains an explicitly historical heuristic, not a current inventory observation or lower bound. The 2026-10-01 analytics API reports psmSupply 80,450.178256 and totalSupply 1,409,341.531656; neither liability share nor a one-off availableLiquidity read is a durable executable-capacity floor. A reusable same-run pool observer is required before capacity-confidence promotion.",
      "All three observed pools report minRedemptionOrderAmount 10000 in raw API units. This is not evidence of a 10,000-token minimum. The docs describe direction-specific DAO enablement and optional fee management; observed enabled flags and balances are not permanent availability or a canonical-request receipt. Wallet connection remains ordinary onchain access rather than an allowlist.",
    ],
  },
  "swanusd-swan": {
    ...psmSwapBase,
    outputAssets: ["usds-sky"],
    // Capacity comes from the same-run monolith-lender reserve read, not from
    // supply: the PSM sell is paid out of the Lender's freePsmAssets accounting.
    capacityModel: {
      kind: "reserve-sync-metadata",
      basis: "live-direct-telemetry",
      requiredOutputAssetKeys: ["usds-sky"],
    },
    costModel: fixedFee(
      0,
      "Monolith charges no PSM sell fee: getSellAmountOut() only converts decimals, the PSM page states the sell fee is none, and the Lender exposes no sell-side fee setter. Network gas and ERC-4626 share rounding in the sUSDS withdrawal are separate from that bps schedule.",
    ),
    reviewedAt: "2026-10-29",
    docs: [
      sourceRefFull("Monolith Peg Stability Module", "https://docs.monolith.market/protocol/peg-stability-module"),
      sourceRefFull(
        "Verified Monolith Lender sell() source (Sourcify exact match)",
        "https://sourcify.dev/server/v2/contract/1/0x4ed5c72816abc1b67ac31ddabe31cff4a8c56a15?fields=sources",
      ),
      sourceRef("Monolith redemptions (second holder rail)", "https://docs.monolith.market/protocol/redemptions", [
        "route",
        "access",
        "fees",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled 2026-10-29 as the Monolith PSM sell rail (Lender.sell) because it is the larger and par-paying of swanUSD's two holder exits: it burns swanUSD and pays the reference asset 1:1, permissionlessly, in one transaction, and it keeps working after the immutability deadline (2030-10-21T15:59:35Z) although the buy path is disabled then. sell() carries no pause, allowlist or sell-fee branch, and the Lender exposes no global pause, so the rail has no configurable off switch. Verified at Ethereum block 26299913 (0x511909c46dc120a98158ce2e4448efcc536f871038d22645ba2ee24e16d0eb13, 2026-10-29T17:31:59Z): psmAsset() is USDS 0xdc035d45d973e3ec169d2276ddab16f1e407384f, tracked as usds-sky, and psmVault() is sUSDS 0xa3931d71877c0e7a3148cb7eb4463524fec27fbd.",
      "Capacity is measured, not pinned or derived from supply. The exact bound is freePsmAssets(), which read 64,205.193253000784236399 USDS at that block (15.28% of the 420,092.200246430984088367 supply), and the monolith-lender reserve adapter now re-reads it with the Lender's debt and supply every run at one pinned block, cross-bounded by the sUSDS maxWithdraw() payout ceiling that sell() actually redeems. The value falls by the requested amount on every sell and refills only through PSM buys, which stop at the deadline, or sUSDS profit recognition, so a pinned snapshot or a supply share would misstate current exit capacity; the live read is the only honest source. A zero read is published as measured zero with a degraded route status instead of an unavailable capacity.",
      "The payout runs through the Lender's sUSDS holding: sell() converts the USDS amount into sUSDS shares and redeems them from the vault, so this exit depends on sUSDS paying USDS in the same transaction and ERC-4626 share rounding can land the received USDS below the nominal 1:1 amount.",
      "The second holder rail is collateral redemption, described here because only one route config per id is allowed. redeem(borrower, amountIn, minAmountOut) burns swanUSD and transfers wstETH at the oracle price minus redeemFeeBps, which read 175 bps at the same block and can be set up to 500 bps before the deadline, against isRedeemable borrowers only. That rail held 4,561.00 swanUSD of free debt across 4 borrowers (1.09% of supply). It reverts when the composite wstETH feed reverts or returns a non-positive price; a feed older than the 30-hour stalenessThreshold does not pause it, it unwinds the price linearly toward zero over the following 24 hours. It is not modeled because it pays volatile collateral and is capped by borrowers' opt-in free debt.",
    ],
  },
};

const FINALIZED_PSM_AND_BASKET_BACKSTOP_REGISTRY = finalizeBackstopRegistry(
  defineRecordEntries(RAW_PSM_AND_BASKET_BACKSTOP_CONFIGS),
  [
    { stablecoinIds: ["dai-makerdao", "usds-sky", "dusd-alto"], reviewedAt: REVIEWED_REMEDIATION_AT },
    { stablecoinIds: ["usd3-reserve-protocol"], reviewedAt: REVIEWED_RESERVE_PROTOCOL_DTF_AT },
  ],
);

export const PSM_AND_BASKET_BACKSTOP_ENTRIES = FINALIZED_PSM_AND_BASKET_BACKSTOP_REGISTRY.entries;
