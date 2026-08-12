import type { RedemptionBackstopConfig } from "./shared";
import { defineRecordEntries } from "./factory";
import {
  applyTrackedReviewedDocs,
  basketRedeemBase,
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  fixedFee,
  psmSwapBase,
  sourceRef,
} from "./shared";
import {
  REVIEWED_EXIT_CREDIT_WAVE_AT,
  REVIEWED_EXIT_CREDIT_WAVE2_AT,
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

export const PSM_AND_BASKET_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
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
      sourceRef("Cap introduction", "https://docs.cap.app/", ["route", "capacity"]),
      sourceRef("Cap cUSD mechanics", "https://docs.cap.app/protocol-overview/cusd-mechanics", ["route", "capacity"]),
      sourceRef("Cap vault", "https://docs.cap.app/concepts/vault", ["route", "capacity", "fees"]),
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
    outputAssets: ["usdc-circle", "usdt-tether", "pyusd-paypal", "usde-ethena"],
    costModel: documentedVariableFee(
      "Normal redemptions are asset-specific: 0 bps for USDT/byUSD and 5 bps for USDC/USDe; stress Basket Mode returns a proportional collateral basket instead",
    ),
    docs: [
      sourceRef("Berachain Honey docs", "https://docs.berachain.com/general/tokens/honey", [
        "route",
        "capacity",
        "fees",
      ]),
    ],
    notes: [
      "Modeled against Basket Mode because the stress-state redemption path turns exits into proportional basket withdrawals when collateral becomes unstable",
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
      sourceRef(
        "Mento BiPoolManager contract (pinned)",
        "https://github.com/mento-protocol/mento-core/blob/07ecf3df5650a33ea6957f1ad2966e02c5082253/contracts/swap/BiPoolManager.sol",
        ["route", "capacity", "fees"],
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
    ...documentedBoundSupplyFull(REVIEWED_YIELD_COVERAGE_WAVE_AT),
    unresolvedOutputAssetKeys: ["asset:zusd", "doc-money-on-chain"],
    unresolvedOutputDisposition: "reviewed-external",
    costModel: fixedFee(0, "Mynt materials state redemption fees are currently disabled"),
    reviewedAt: "2026-07-27",
    docs: [
      sourceRef("Sovryn Dollar", "https://sovryn.com/sovryn-dollar", ["route", "capacity", "access"]),
      sourceRef("Launching the Sovryn Dollar", "https://sovryn.com/all-things-sovryn/launching-the-sovryn-dollar", [
        "route",
        "settlement",
      ]),
      sourceRef("Mynt app", "https://app.mynt.xyz/", ["route", "capacity", "fees", "settlement"]),
    ],
    notes: [
      "Fresh reserve sync reads the Mynt holder's ZUSD and DOC balances on Rootstock, but redemption capacity remains documented-bound because the adapter does not emit a dedicated route-capacity field",
      "2026-07-27 recheck (Kimi data review): Mynt redeems DLLR 1:1 into a user-selected bAsset, currently DOC or ZUSD. ZUSD has no tracked Pharos stablecoin id, so the complete pair is preserved as unresolved diagnostic identities rather than publishing DOC alone.",
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
    reviewedAt: REVIEWED_YIELD_COVERAGE_WAVE_AT,
    docs: [sourceRef("BabelFish", "https://babelfish.money/", ["route", "capacity", "fees", "access", "settlement"])],
    notes: [
      "Fresh reserve sync reads the BabelFish holder's accepted bAsset balances on Rootstock, but redemption capacity remains documented-bound because the adapter does not emit a dedicated route-capacity field",
    ],
  },
  "eur0-usual": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT),
    outputAssetType: "mixed-collateral",
    outputAssets: ["asset:eutbl"],
    costModel: undisclosedReviewedFee(
      "Usual docs describe EUR0 redemption into eligible euro RWA collateral through the dApp; public materials reviewed do not publish one fixed EUR0 redemption fee",
    ),
    docs: [
      sourceRef("Usual EUR0 docs", "https://tech.usual.money/overview/features/eur0", ["route", "capacity", "access"]),
      sourceRef("Usual EUR0 contract docs", "https://tech.usual.money/smart-contracts/token-contracts/eur0", [
        "route",
        "access",
      ]),
      sourceRef("Usual EUR0 product docs", "https://docs.usual.money/usual-products/usd0-stablecoin/eur0-stablecoin", [
        "route",
      ]),
    ],
    notes: [
      "Modeled as the Usual dApp basket redemption route into eligible euro-denominated RWA collateral, primarily Spiko EUTBL, rather than a direct fiat EUR issuer rail.",
      "Output declared 2026-07-19: the Usual EUR0 product docs state redemption burns EUR0 to receive euTBL (Spiko EU T-Bills MMF) at par on the permissioned route, and the tech docs list EUTBL by Spiko as the sole EUR0 collateral entry; the permissionless Swapper Engine leg settles in EURC subject to liquidity and is not the modeled route.",
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
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
    docs: [
      sourceRef("USDD documentation", "https://docs.usdd.io", ["route", "capacity", "fees"]),
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
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE_AT,
    docs: [
      sourceRef(
        "Inter Protocol Parity Stability Module",
        "https://docs.inter.trade/inter-protocol-system-documentation/parity-stability-module",
        ["route", "capacity", "fees", "access", "settlement"],
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
    unresolvedOutputAssetKeys: ["asset:xusdt"],
    unresolvedOutputDisposition: "reviewed-external",
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "psm-balance-share" },
    costModel: fixedFee(
      25,
      "The Fathom whitepaper states a fee of 0.25% is charged for each trade in the Stable Swap module",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
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
    ],
    notes: [
      "Configured 2026-08-12 as the StableSwap Module rail, not CDP repayment: the whitepaper describes trading FXD at a fixed 1 FXD = 1 counter-stablecoin rate inside a pool, which is a holder-exercisable swap rather than the position-specific debt repayment that previously kept this coin unconfigured.",
      "Access is whitelisted because the same whitepaper states Stable Swap keeps a private list of possible participants to protect the pegging mechanism, and that the FXD Stable Swap arbitrager group is private and not publicly open.",
      "Output is the deployed counter-stablecoin: the whitepaper names abUSDs and the smart-contract architecture page names the deployed pair FXD<->xUSDT. xUSDT has no tracked Pharos stablecoin id, so the reviewed identity is preserved as an unresolved external output rather than published as a scoreable asset.",
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
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
    docs: [
      sourceRef("Hydration HOLLAR", "https://docs.hydration.net/products/hollar/", ["route", "capacity", "access"]),
      sourceRef("Hydration HOLLAR quick start", "https://docs.hydration.net/quick_start/hollar/", [
        "route",
        "capacity",
      ]),
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
      sourceRef(
        "Hydration referendum 367: consolidate HSM collateral",
        "https://hydration.subsquare.io/referenda/367",
        ["route", "capacity"],
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
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
    docs: [
      sourceRef(
        "Hubble Peg Stability Module",
        "https://docs.hubbleprotocol.io/faq/usdh-peg-stability/peg-stability-module",
        ["route", "fees", "settlement"],
      ),
      sourceRef("Why use Hubble", "https://docs.hubbleprotocol.io/why-use-hubble", ["route", "capacity"]),
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
      sourceRef("RAAC PSM parameters", "https://docs.raac.io/parameters-psm/", ["route", "capacity", "fees"]),
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
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
    docs: [
      sourceRef(
        "Inverse Peg Stability Module",
        "https://docs.inverse.finance/inverse-finance/inverse-finance/products/peg-stability-module",
        ["route", "capacity", "fees"],
      ),
      sourceRef("Inverse Finance transparency", "https://www.inverse.finance/transparency", ["capacity"]),
    ],
    notes: [
      "Modeled against the USDS PSM rail rather than full-system FiRM debt unwinds; the route never claimed that full DOLA supply is instantly redeemable",
      "Capacity correction 2026-08-12: the prior reviewed 8% PSM-share bound was stale and is removed. At Ethereum block 25736814 the deployed PSM reads `supply() = 0` and `getTotalReserves() = 0` with zero balances of both tokens, and `sell()` hard-reverts at any size — the contract was drained on 2025-12-10 and Inverse's Fed withdrew its 200k DOLA float on 2025-12-11, leaving six lifetime transactions.",
      "Capacity is therefore live-only. Fresh telemetry reads the PSM's current reserves as the direct redeemable bound, and when that read is unavailable the route is left unrated rather than falling back to the phantom static share the empty contract cannot honor.",
    ],
  },
  "buck-bucket-protocol": {
    ...psmSwapBase,
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    capacityModel: { kind: "supply-ratio", ratio: 0.25, confidence: "documented-bound" },
    costModel: fixedFee(30, "Modeled route uses PSM OUT at 30 bps; collateral redemptions use a separate dynamic fee"),
    reviewedAt: "2026-07-14",
    docs: [
      sourceRef("Bucket Protocol PSM", "https://docs.bucketprotocol.io/mechanisms/peg-stability-module", [
        "route",
        "capacity",
        "fees",
      ]),
    ],
    notes: [
      "The reviewed 25% bound matches the tracked USDC/USDT PSM reserve share rather than assuming the full BUCK supply is instantly redeemable through the stablecoin module",
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
      sourceRef("Lista docs", "https://docs.bsc.lista.org", ["route", "capacity", "fees"]),
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
      sourceRef("Alto DUSD Peg Stability Module", "https://docs.alto.money/alto-protocol/psm", [
        "route",
        "capacity",
        "fees",
      ]),
    ],
  },
  "silk-shade-protocol": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT),
    outputAssetType: "mixed-collateral",
    outputAssets: ["asset:sscrt", "asset:wbtc", "asset:usdc"],
    costModel: undisclosedReviewedFee(
      "Shade Protocol documents Silk redemption pools plus ShadeDAO bond-assisted arbitrage; public docs reviewed do not publish a single fixed bps redemption fee",
    ),
    docs: [
      sourceRef("Shade Protocol Silk docs", "https://docs.shadeprotocol.io/silk", ["route", "capacity"]),
      sourceRef(
        "Shade Lend stability mechanisms",
        "https://docs.shadeprotocol.io/shade-protocol/advanced-topics-apps/lend/stability-mechanisms",
        ["route", "fees"],
      ),
    ],
    notes: [
      "Silk tracks a basket of GDP-weighted currencies; redemption pools combined with ShadeLend overcollateralization provide a reviewed basket-exit rail rather than a single-stable PSM",
      "Output asset type is mixed-collateral because the redeemed basket is not guaranteed to be all-stablecoin; it can include native Shade collateral assets",
      "Output declared 2026-07-19: Shade Lend docs state a holder may redeem SILK for the collateral of their chosen vault, repaying a pro-rata share of the vault's debt; the declared assets are the vault collateral documented in official sources (sSCRT in the Lend docs, USDC.axl and wBTC vaults in Shade DAO forum redemption reports). The vault whitelist is governance-mutable and no canonical current list is published.",
    ],
  },
  "eusd-electronic-usd": {
    ...basketRedeemBase,
    ...reviewedBasketRedemptionSupplyFull,
    outputAssets: ["usdc-circle", "usdt-tether"],
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE_AT,
    costModel: {
      ...documentedVariableFee(
        "Reserve's documented DTF fee schedule has exactly two fees — a TVL fee and a mint fee charged whenever a user mints new DTF tokens — so redeeming the pro-rata basket is charged 0 bps",
      ),
      feeBpsMax: 0,
    },
    docs: [
      sourceRef(
        "Reserve DTF minting & redeeming",
        "https://docs.reserve.org/core-components/index-dtfs/minting-and-redeeming",
        ["route", "capacity", "access"],
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
    ],
  },
  "usd3-reserve-protocol": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_RESERVE_PROTOCOL_DTF_AT),
    outputAssets: ["susds-sky", "usdc-circle", "steakusdc-steakhouse"],
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_EXIT_CREDIT_WAVE2_AT,
    costModel: {
      ...documentedVariableFee(
        "Reserve Yield DTF revenue is documented as onchain collateral yield and issuer revenue shares rather than a user-charged redemption fee, and redemption returns the entire backing basket, so the reviewed ceiling is 0 bps",
      ),
      feeBpsMax: 0,
    },
    notes: [
      "Capacity became live-only 2026-08-12: the adapter now reads the RToken's own `redemptionAvailable()` throttle each run as the direct redeemable bound, so the prior documented-bound full-supply model is removed. The throttle refills over time and shrinks as it is drawn down, so a static supply figure would consistently overstate what a holder can exit right now.",
      "The read also degrades on basket state: when the collateral basket is not SOUND the measured capacity is withheld rather than published, and if the throttle cannot be read at all the route is left unrated instead of falling back to a static bound",
      "Fee bound declared 2026-08-12: the Yield DTF overview states holders can mint by depositing the complete collateral basket and that a DTF is \"redeemed for the entire basket as well\", with protocol revenue coming from \"yield from lending collateral tokens onchain, revenue shares with collateral token issuers, or any other source of onchain yield\" — no redemption charge. Throttles still bound redemption size, which the documented-bound capacity model already carries, not its cost.",
    ],
    docs: [
      sourceRef("Reserve Yield DTF overview", "https://docs.reserve.org/core-components/yield-dtfs/overview", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Reserve DTF API", "https://api.reserve.org/discover/dtfs", ["capacity"]),
      sourceRef(
        "Reserve USD3 app",
        "https://app.reserve.org/ethereum/token/0x0d86883faf4ffd7aeb116390af37746f45b6f378/overview",
        ["capacity"],
      ),
    ],
  },
  "xmd-metal-dollar": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull(REVIEWED_FOLLOWUP_REMEDIATION_AT),
    outputAssets: ["usdc-circle", "pyusd-paypal", "usdp-paxos"],
    accessModel: "whitelisted-onchain",
    outputAssetType: "stable-basket",
    costModel: fixedFee(
      0,
      "Metal Dollar materials describe 1:1 redemption into supported basket stablecoins with no slippage, AMM dependency, or trading spread; no separate protocol redemption fee was identified",
    ),
    holderEligibility: "whitelisted-primary",
    routeExitCorrelation: "same-stablecoin-pool-backing",
    docs: [
      sourceRef("Metal Dollar product page", "https://www.metallicus.com/metal-dollar", [
        "route",
        "capacity",
        "access",
      ]),
      sourceRef(
        "XPR Network XMD redeem guide",
        "https://help.xprnetwork.org/hc/en-us/articles/11560190160151-How-do-I-redeem-Metal-Dollar-XMD",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef("Metal Dollar site", "https://metaldollar.com/", ["route", "capacity"]),
    ],
    notes: [
      "Holder must complete the XPR/Metal account-verification path and use WebAuth Wallet, so access is modeled as whitelisted onchain rather than permissionless.",
      "Pharos does not currently model XPR Network contracts, so this remains a static documented-bound route unless a supported-chain capacity adapter is added later.",
    ],
  },
};

applyTrackedReviewedDocs(
  PSM_AND_BASKET_BACKSTOP_CONFIGS,
  ["dai-makerdao", "usds-sky", "dusd-alto"],
  REVIEWED_REMEDIATION_AT,
);

applyTrackedReviewedDocs(PSM_AND_BASKET_BACKSTOP_CONFIGS, ["usd3-reserve-protocol"], REVIEWED_RESERVE_PROTOCOL_DTF_AT);

/** Declared after the doc backfills above so the entries carry the finished configs. */
export const PSM_AND_BASKET_BACKSTOP_ENTRIES = defineRecordEntries(PSM_AND_BASKET_BACKSTOP_CONFIGS);
