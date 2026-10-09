import { defineConfigFamily, defineRecordEntries, finalizeBackstopRegistry } from "../factory";
import {
  documentedVariableFee,
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  sourceRefFull,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
  sourceRefRouteCapacityFees,
  undisclosedReviewedFee,
} from "../shared";
import {
  REVIEWED_DIRECT_REDEMPTION_AT,
  REVIEWED_EXIT_CREDIT_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
  REVIEWED_MAY_BATCH_AT,
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
  REVIEWED_WRAPPER_WAVE_AT,
  REVIEWED_SUSN_WITHDRAWAL_RAIL_AT,
  REVIEWED_YIELD_COVERAGE_WAVE_AT,
} from "../review-dates";
import {
  defineStablecoinRedeemConfig,
  defineReviewedStablecoinRedeemConfig,
  erc4626InstantConfig,
  gauntletMorphoConfig,
  steakhousePrimeInstantConfig,
} from "./shared";
import { DISCOVERY_STABLECOIN_REDEEM_CONFIGS } from "./discovery-wave";

const SOURCE_FILE_PATH = "shared/lib/redemption-backstop-configs/stablecoin-redeem/configs.ts";
const REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT = "2026-07-19";
const REVIEWED_ZCHF_BRIDGE_AT = "2026-05-25";
const REVIEWED_FXSAVE_LIVE_REDEMPTION_AT = "2026-05-27";
const REVIEWED_NOON_USN_TERMS_AT = "2026-09-22";

const RESERVOIR_REDEEM_CONFIGS = defineConfigFamily(
  [
    {
      id: "wsrusd-reservoir",
      reviewedAt: "2026-10-09",
      holderEligibility: "any-holder" as const,
      executionModel: "rules-based-nav" as const,
      costModel: documentedVariableFee(
        "The deployed Savingcoin wsrUSD wrapper redeems directly into its immutable rUSD asset, then the PSM burns rUSD for USDC. Fresh identity and rounded-conversion reads quantify this branch; no static fee fallback is declared and the separate srUSD SavingModule fee is not charged on this route",
        "formula",
      ),
      docs: [
        sourceRefRouteCapacityFees("Reservoir Savings (srUSD & wsrUSD)", "https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd"),
        sourceRefRouteCapacity(
          "Reservoir Peg Stability Module",
          "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module",
        ),
        sourceRef("Reservoir verified PSM implementation (reviewed 2026-10-07)", "https://eth.blockscout.com/api/v2/smart-contracts/0x4809010926aec940b550d34a46a52739f996d75d", ["route", "access", "capacity", "fees", "settlement"]),
        sourceRef("Reservoir deployed Savingcoin wrapper (reviewed 2026-10-07)", "https://eth.blockscout.com/api/v2/smart-contracts/0xd3fd63209fa2d55b07a0f6db36c2f43900be3094", ["route", "access", "fees", "settlement"]),
      ],
      notes: [
        "The modeled route composes the ERC-4626 unwrap into rUSD with the downstream Reservoir PSM exit, so its final output is USDC",
        "Fresh capacity telemetry must bind canonical USDC, Ethereum block/header clock, PSM identity and the Savingcoin rUSD asset and rounded conversion. The balance-sheet API remains unverified composition evidence, not executable cash.",
        "rUSD, srUSD and wsrUSD all share PSM 0x4809010926aec940b550d34a46a52739f996d75d; the USDC inventory is one shared resource, never three additive buffers.",
        "When the PSM read is unavailable the adapter withholds telemetry entirely, and the route falls back to the reviewed 25 bps minimum USDC PSM balance documented by Reservoir",
        "Branch identity reviewed 2026-10-07: verified Savingcoin constructor and deployed code identify rUSD 0x09d4214c03d01f49544c0448dbe3a27f768f2b34 as the underlying; withdraw burns wsrUSD and mints rUSD. This is not an obligatory srUSD SavingModule redemption. Only fresh admitted branch reads may establish the current zero protocol fee; unavailable fee evidence remains unquantified.",
        "Holder eligibility reviewed 2026-10-09T10:31:38Z by Sol curation campaign 2026-10-09 (Lane02Reservoir): Savingcoin withdraw/redeem has no holder allowlist or administrative role gate; the immutable rUSD output then enters PSM redeem, which is external whenNotPaused with no holder role gate. Any holder can invoke the native on-chain route with the necessary balance/allowance, subject to the current PSM pause and available USDC. The issuer product's non-U.S./non-sanctioned user restriction is retained as interface/legal context, not invented on-chain whitelisting.",
        "Current savings documentation states wsrUSD carries no fees and has no lock-up; it conditions immediate redemptions on available PSM liquidity. Verified Savingcoin _withdraw burns shares and mints rUSD without the separate srUSD SavingModule fee. Preserve the existing formula/rounded-conversion fee model and current-state producer requirements: zero stated protocol fee is not zero rounding loss, gas, all-in same-notional cost, or an unconditional whole-position settlement guarantee.",
      ],
    },
    {
      id: "rusd-reservoir",
      costModel: fixedFee(
        0,
        "The rUSD-to-USDC Peg Stability Module redeem burns rUSD 1:1 and transfers USDC; the verified PSM source contains no fee logic",
      ),
      docs: [
        sourceRefFull(
          "Reservoir Peg Stability Module",
          "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module",
        ),
        sourceRef(
          "Reservoir smart-contract addresses",
          "https://docs.reservoir.xyz/security-and-compliance/smart-contract-addresses",
          ["route"],
        ),
        sourceRef("Reservoir verified PSM implementation (reviewed 2026-10-07)", "https://eth.blockscout.com/api/v2/smart-contracts/0x4809010926aec940b550d34a46a52739f996d75d", ["route", "access", "capacity", "fees", "settlement"]),
      ],
      notes: [
        "Added 2026-08-12: base rUSD redeems directly through Reservoir's USDC PSM (0x4809010926aec940b550D34a46A52739f996D75D). Its redeem(uint256) and redeem(address,uint256) are `external whenNotPaused` with no role gate in the verified source, so the route is permissionless while the PSM is unpaused.",
        "Fresh capacity telemetry must bind canonical USDC, the PSM identity and Ethereum block/header clock; failed reads withhold the amount, while a readable pause or empty pool is an adverse measured fact. The 0.0025 documented fallback remains separate from live evidence.",
        "rUSD, srUSD and wsrUSD all share PSM 0x4809010926aec940b550d34a46a52739f996d75d; the USDC inventory is one shared resource, never three additive buffers. Balance-sheet API assets do not establish PSM cash.",
      ],
    },
    {
      id: "srusd-reservoir",
      executionModel: "rules-based-nav" as const,
      costModel: documentedVariableFee(
        "srUSD exits to rUSD through SavingModule.redeem at `previewRedeem(amount) * (1e6 + redeemFee) / 1e6`; redeemFee is a live on-chain parameter read each run (1.34 bps on 2026-08-12), governance-settable below 100%, and the downstream rUSD-to-USDC PSM redeem is 1:1 with no fee",
        "formula",
      ),
      docs: [
        sourceRefFull("Reservoir Savings (srUSD)", "https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd"),
        sourceRefRouteCapacity(
          "Reservoir Peg Stability Module",
          "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module",
        ),
        sourceRef("Reservoir verified PSM implementation (reviewed 2026-10-07)", "https://eth.blockscout.com/api/v2/smart-contracts/0x4809010926aec940b550d34a46a52739f996d75d", ["route", "access", "capacity", "fees", "settlement"]),
        sourceRef("Reservoir verified SavingModule implementation (reviewed 2026-10-07)", "https://eth.blockscout.com/api/v2/smart-contracts/0x5475611dffb8ef4d697ae39df9395513b6e947d7", ["route", "fees", "settlement"]),
      ],
      notes: [
        "The modeled route composes the srUSD exit into rUSD with the downstream Reservoir PSM exit, so its final output is USDC",
        "Fresh capacity telemetry must bind canonical USDC, the Ethereum block/header clock and the SavingModule identity, rounded conversion and fee burden before using downstream PSM cash; failed savings-leg reads cannot inherit base-rUSD capacity.",
        "rUSD, srUSD and wsrUSD all share PSM 0x4809010926aec940b550d34a46a52739f996d75d; the USDC inventory is one shared resource, never three additive buffers. Unavailable live evidence retains the separate 0.0025 documented fallback, not a live-direct label.",
        "No static fee bound declared 2026-08-12: verified Etherscan-published source shows SavingModule.redeem burns `previewRedeem(amount) * (1e6 + redeemFee) / 1e6`, so the docs' \"micro burn fee ... one day's worth of interest\" is charged on exit rather than entry. It read 134/1e6 = 1.34 bps at block 25735375, but the MANAGER role may set it anywhere below 100%, so no reviewed ceiling is defensible. The fee model is therefore formula-confidence and scores against the adapter's per-run `redeemFee()` read instead of a static number.",
      ],
    },
  ],
  ({ id: _id, ...row }) =>
    defineStablecoinRedeemConfig({
      outputAssets: ["usdc-circle"],
      capacityModel: {
        kind: "reserve-sync-metadata",
        requiredOutputAssetKeys: ["usdc-circle"],
        fallbackRatio: 0.0025,
        confidence: "documented-bound",
        basis: "hot-buffer",
      },
      reviewedAt: "2026-10-07",
      ...row,
    }),
);

const RAW_STABLECOIN_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  ...DISCOVERY_STABLECOIN_REDEEM_CONFIGS,
  "usdfr-forest-road": defineStablecoinRedeemConfig({
    reviewedAt: "2026-10-07",
    accessModel: "whitelisted-onchain",
    holderEligibility: "whitelisted-primary",
    executionModel: "deterministic-onchain",
    settlementModel: "atomic",
    outputAssets: ["usdc-circle"],
    capacityModel: {
      kind: "executable-observer",
      observerId: "usdfr-par-controller",
      capacityUse: "measured",
      requiredOutputAssetKeys: ["usdc-circle"],
    },
    costModel: fixedFee(
      0,
      "The exact Forest Road par-controller redemption burns USDfr and releases USDC 1:1 without a deducted protocol fee; Ethereum gas and other all-in execution costs are not declared zero",
    ),
    v9RouteReviewTerms: {
      settlementModel: "atomic",
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost"],
      rationale: "The restricted par-state controller path settles atomically to canonical USDC without a protocol deduction, but a native cash bound is not an exact holder execution certificate and does not price Ethereum gas. Same-notional all-in cost remains unavailable until independently admitted.",
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef("Forest Road exact par-controller implementation (reviewed 2026-10-07)", "https://etherscan.io/address/0x101AdfC1a6fA8C5DFccd76DB9F67541CF3f92E4D#code", ["route", "fees", "settlement"]),
        sourceRef("Forest Road holder redemption and KYC terms", "https://forestroadvault.com/docs/how-to", ["route", "access", "settlement"]),
      ],
    },
    docs: [
      sourceRef("Forest Road holder redemption and KYC terms", "https://forestroadvault.com/docs/how-to", ["route", "access", "settlement"]),
      sourceRef("Forest Road deployed controller and reserve addresses", "https://forestroadvault.com/docs/addresses", ["route", "access"]),
      sourceRef("Forest Road compliance and governance gates", "https://forestroadvault.com/docs/roles-and-governance", ["route", "access"]),
      sourceRef("Forest Road exact par-controller implementation (reviewed 2026-10-07)", "https://etherscan.io/address/0x101AdfC1a6fA8C5DFccd76DB9F67541CF3f92E4D#code", ["route", "access", "capacity", "fees", "settlement"]),
      sourceRef("Forest Road exact USDC reserve implementation (reviewed 2026-10-07)", "https://etherscan.io/address/0x99B4DFa4e1344273d5335bD90de1dea3A02b9C3A#code", ["route", "capacity", "settlement"]),
    ],
    notes: [
      "Only KYC-verified, nonblocked Ethereum holders use controller 0x50ac018eb6400f247ffe0fa7f1d4e0e900cdb47c and reserve 0x8317736611b542ddb4a820fe344b621a904bdd48. This is not an any-holder route; sUSDfr's separate 21-day queue and minimum do not apply.",
      "The standalone observer binds controller/token/reserve/compliance identities, current guards, canonical USDC and same-notional par previews at one block. Recorded idle cash, physical USDC and effective supply jointly constrain the measured output; receivables and idle balance alone are not capacity.",
      "Identity/read failures, unsupported sub-par or junior-capital paths and missing fresh observer evidence remain unavailable without a static fallback. Readable pause/zero facts stay adverse observations, not missing-data substitutes.",
      "Pinned review at Ethereum block 26143056 (2026-10-07T20:59:35Z) supports this branch identity, not a permanent cash amount. Native measured capacity and zero protocol fee do not supply a complete gas-priced Safety execution certificate.",
    ],
  }),
  "usdr-rise": defineStablecoinRedeemConfig({
    reviewedAt: "2026-10-05",
    outputAssets: ["wm-m0"],
    capacityModel: { kind: "reserve-sync-metadata", requiredOutputAssetKeys: ["wm-m0"] },
    costModel: documentedVariableFee("SwapFacility extension-to-extension unwrap/wrap contains no additional protocol deduction; exact wM rounding and gas require same-notional observation", "formula"),
    v9RouteReviewTerms: {
      settlementModel: "atomic",
      settlementDelaySec: 0,
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "cost"],
      rationale:
        "The reviewed SwapFacility _swapExtensions branch transfers USDR, unwraps it to M and wraps the observed M balance difference into wM in one transaction, without a separate protocol-fee deduction. Extension approval, permissioning, pause and lock checks can prevent execution. No current executable wM capacity, rounding receipt or complete all-in cost is supplied by native-M reserve telemetry.",
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef("RISE SwapFacility implementation, _swap and _swapExtensions", "https://explorer.risechain.com/api/v2/smart-contracts/0xf7f9638cb444d65e5a40bf5ff98ebe4ff319f04e", ["route", "access", "fees", "settlement"]),
        sourceRef("M0 Swap Facility documented conditions", "https://docs.m0.org/build/accessing-liquidity", ["route", "access", "settlement"]),
      ],
    },
    docs: [
      sourceRef("RISE SwapFacility implementation", "https://explorer.risechain.com/api/v2/smart-contracts/0xf7f9638cb444d65e5a40bf5ff98ebe4ff319f04e", ["route", "access", "fees", "settlement"]),
      sourceRef("M0 liquidity routes", "https://docs.m0.org/build/accessing-liquidity", ["route", "access", "settlement"]),
    ],
    notes: ["The holder path swaps USDR to wM via RISE SwapFacility 0xb6807116b3b1b321a390594e31ecd6e0076f6278. Extension approval, pauses and permissioning apply. Native-M approved-swapper telemetry is not wM output capacity and must not be inherited. Downstream wM-to-USDC liquidity is separate."],
  }),
  ...defineConfigFamily(
    [
      {
        id: "steakusdg-steakhouse",
        outputAsset: "usdg-paxos",
        sourceUrl: "https://sourcify.dev/server/v2/contract/4663/0xbeeff033f34c046626b8d0a041844c5d1a5409dd?fields=all",
        note: "Robinhood VaultV2 redeem burns steakUSDG and synchronously pays USDG. Withdrawal gates and executable liquidity are checked by the block-bound execution observer.",
      },
      {
        id: "krusdc-keyrock",
        outputAsset: "usdc-circle",
        sourceUrl: "https://sourcify.dev/server/v2/contract/8453/0x91c056b6d4311a743614fbc03ac32d4e6a2d3a3c?fields=sources,compilation,runtimeBytecode",
        note: "The Arc Keyrock vault's functional runtime matches the verified VaultV2 reference outside compiler-declared immutable/CBOR regions; all immutable asset, decimals and virtual-share values were separately matched. Its sole registered underlying endpoint is USDC.",
      },
      {
        id: "steakeurcv-steakhouse",
        outputAsset: "eurcv-societe-generale-forge",
        sourceUrl: "https://eth.blockscout.com/api/v2/smart-contracts/0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f",
        note: "The reviewed Ethereum VaultV2 redeem path pays EURCV, not dollars. A fresh observed EURCV valuation reference is required; no USD parity or favorable capacity is inferred.",
      },
      {
        id: "susdc-spark-v1",
        outputAsset: "usdc-circle",
        sourceUrl: "https://eth.blockscout.com/api/v2/smart-contracts/0xf943Cb8D5f06f2bBF352878ebEF3Ec5C537A20bA",
        note: "This config covers only UsdcVault redeem into USDC through sUSDS redemption and the PSM. The alternate exit() payout in sUSDS is not registered or conflated with this endpoint; current PSM fees, enablement and USDC liquidity must be measured.",
      },
    ],
    ({ id: _id, outputAsset, sourceUrl, note }) => {
      const docs = [sourceRef("Reviewed synchronous underlying redemption implementation", sourceUrl, ["route", "access", "settlement", "fees", "capacity"])];
      return defineStablecoinRedeemConfig({
        capacityModel: { kind: "unquantified" },
        outputAssets: [outputAsset],
        executionModel: "rules-based-nav",
        routeExitCorrelation: "wrapper-to-parent-dependency",
        costModel: documentedVariableFee(
          "Pinned convertToAssets/previewRedeem and the actual synchronous underlying receipt quantify the withdrawal haircut; no static fee or cost ceiling is assumed. Network gas is excluded as for exact DEX routes.",
          "formula",
        ),
        reviewedAt: "2026-10-05",
        v9RouteReviewTerms: {
          settlementModel: "atomic",
          settlementDelaySec: 0,
          scoringDisposition: "bounded-terms-gap",
          missingScoringFields: ["capacity", "cost"],
          rationale: "Source-confirmed synchronous underlying redemption is a real route, but only a fresh admitted execution certificate quantifies same-notional capacity and cost.",
          reviewedAt: "2026-10-05",
          docs,
        },
        docs,
        notes: [note, "Without a certified execution observation, immediate, scoring and eventual capacity remain null; neither token supply, an idle balance nor an absent observation is substituted for full or zero capacity."],
      });
    },
  ),
  "onyc-onre": defineStablecoinRedeemConfig({
    outputAssets: ["usdg-paxos"],
    capacityModel: { kind: "unquantified" },
    accessModel: "whitelisted-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    costModel: {
      ...documentedVariableFee(
        "OnRe charges a 25 bps service fee plus a state-dependent convex liquidity haircut; quote_swap_sell gives the executable USDG output",
        "formula",
      ),
      feeBpsMin: 25,
    },
    v9RouteReviewTerms: {
      settlementModel: "atomic",
      settlementDelaySec: 0,
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "cost"],
      rationale: "The current primary channel settles atomically to USDG, but neither its available vault balance nor the same-notional liquidity haircut is measured by this reviewed documentation. The 15% management liquidity target is not executable capacity.",
      reviewedAt: "2026-10-02",
      docs: [
        sourceRef("OnRe current redemption and liquidity mechanics", "https://docs.onre.finance/technical-resources/redemptions-and-onchain-liquidity", ["route", "access", "settlement", "fees"]),
      ],
    },
    reviewedAt: "2026-10-02",
    docs: [
      sourceRef("OnRe current redemption and liquidity mechanics", "https://docs.onre.finance/technical-resources/redemptions-and-onchain-liquidity", ["route", "access", "settlement", "fees"]),
    ],
    notes: [
      "Observed 2026-10-02: OnRe states that the current deployment processes redemptions entirely onchain without a backend queue. Verified holders receive a USDG quote and a single atomic burn-and-payout transaction with a minimum-output constraint.",
      "The prior monthly 2.5%-of-NAV capacity and 30-day queue terms are not the current primary channel. The approximately 15% capital liquidity reserve is a changeable management target, not an executable capacity bound.",
      "Current quotes depend on vault balance, pressure-adjusted liquidity and demand. Global kill switch, offer/pair enablement and sufficient vault liquidity must be checked; no favorable capacity or all-in cost is inferred without that read.",
      "Executable USDG liquidity is unquantified, not an observed zero balance; the OnRe holdings adapter has no redeemable-capacity telemetry.",
    ],
  }),
  "usd3-3jane": erc4626InstantConfig({
    symbol: "USDC",
    fallback: { basis: "live-direct-telemetry" },
    feeDescription:
      "3Jane documents fee-free USD3 withdrawals; the vault implementation returns USDC at current NAV subject to available strategy liquidity.",
    routeExitCorrelation: "same-protocol-liquidity",
    reviewedAt: "2026-07-13",
    docs: [
      sourceRefFull("3Jane supplier withdrawals", "https://docs.3jane.xyz/architecture/core-money-market/suppliers"),
      sourceRefFull(
        "3Jane USD3 implementation",
        "https://github.com/3jane-protocol/moneymarket-contracts/blob/main/src/usd3/USD3.sol",
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
  "ousd-origin-protocol": defineReviewedStablecoinRedeemConfig(REVIEWED_DIRECT_REDEMPTION_AT, {
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(25, "Origin docs list a 0.25% exit fee on OUSD redemptions"),
    docs: [
      sourceRefRouteCapacity("Origin Dollar (OUSD)", "https://docs.originprotocol.com/yield-bearing-tokens/origin-dollar-ousd"),
      sourceRef(
        "Origin March 2023 token holder update",
        "https://www.originprotocol.com/blog/march-2023-token-holder-update?lang=en",
        ["route", "fees"],
      ),
      sourceRefRouteCapacity(
        "Origin pricing and peg management",
        "https://docs.originprotocol.com/security-and-risk/price-oracles",
      ),
    ],
    notes: [
      "Origin docs still describe pro-rata basket redemption semantics; current OUSD collateral is USDC only",
      "Fresh Origin vault telemetry reads the vault's idle stablecoin balances as current direct redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "ousg-ondo-finance": defineReviewedStablecoinRedeemConfig(REVIEWED_DIRECT_REDEMPTION_AT, {
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
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
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    docs: [
      sourceRefRouteCapacity("Superstate USTB", "https://superstate.com/assets/ustb"),
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
  "thusd-theo": defineStablecoinRedeemConfig({
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    accessModel: "whitelisted-onchain",
    holderEligibility: "whitelisted-primary",
    settlementModel: "immediate",
    executionModel: "deterministic-onchain",
    capacityModel: { kind: "reserve-sync-metadata", basis: "hot-buffer" },
    costModel: fixedFee(10, "Reviewed ThUSDMinter MAX_FEE_BPS ceiling; same-run redeemFeeBps supersedes it"),
    reviewedAt: "2026-09-30",
    v9RouteReviewTerms: { minRedeemUsd: 1 },
    docs: [
      sourceRef("Verified ThUSDMinter source and state (Ethereum block 26088429, reviewed 2026-09-30)", "https://eth.blockscout.com/api/v2/smart-contracts/0x2d99ac801dc0edadd53f5688fef2317932e8696e", ["route", "capacity", "settlement", "fees", "access"]),
      sourceRef("Theo mint/redeem contract reference (reviewed 2026-09-30)", "https://docs.theo.xyz/developers/contract-reference/mint-and-redeem.md", ["route", "settlement", "access"]),
      sourceRef("Theo terms (reviewed 2026-09-30)", "https://docs.theo.xyz/legal/terms.md", ["capacity", "settlement", "access"]),
      sourceRef("Theo depositor-signed mint/redeem orders (reviewed 2026-09-30)", "https://docs.theo.xyz/products/thusd/mint-and-redeem.md", ["route", "access"]),
    ],
    notes: [
      "Executed eligible-cohort on-chain rail, consistent with USDe: operator submission of depositor-signed orders is required; immediate settlement describes the executed transaction, not end-to-end API processing. No API SLA is published.",
      "Ethereum block 26088429 (2026-09-30): Cash Wallet 0xec417ccb6dd26868cca993a92f37217b1d4b3c2f held 360760.446791 USDC and 20000 USDT; allowances to ThUSDMinter were 200400 USDC and 400300 USDT. Summing each supported asset's min(balance, allowance) gives 220400 USD of spendable float, with no replenishment assumed and no fallback floor.",
      "The positive 200000-thUSD gross per-block redemption cap is a guard and throughput context, not a numerical cap on the multi-block float; current redeemFeeBps was 5 and MAX_FEE_BPS was 10 at that block.",
      "Recipients and signers must be whitelisted and not blacklisted. Theo quotes collateral amounts; the contract enforces an upper bound rather than an at-par quote guarantee. Platform terms permit account-specific limits and suspension.",
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
      sourceRefRouteCapacityAccess("Ethena peg arbitrage mechanism", "https://docs.ethena.fi/solution-overview/peg-arbitrage-mechanism"),
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
      sourceRefRouteCapacityFees(
        "Frankencoin StablecoinBridge (CHFAU)",
        "https://etherscan.io/address/0x3e445ff4dddf0ff8ae7458c9746ed80bd664f6c1",
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
  "wsrusd-reservoir": RESERVOIR_REDEEM_CONFIGS["wsrusd-reservoir"]!,
  "susds-sky": erc4626InstantConfig({
    symbol: "USDS",
    reviewedAt: "2026-05-17",
    feeDescription: "Sky docs describe sUSDS vault deposits and withdrawals with no fee",
    docs: [
      sourceRefRouteCapacityFees("Sky sUSDS docs", "https://developers.sky.money/core-protocol/susds/"),
      sourceRefRouteCapacity("Sky protocol token routes", "https://developers.sky.money/quick-start/protocol-token-routes/"),
    ],
    notes: [
      "sUSDS is an ERC-4626 savings wrapper over USDS: holders can deposit USDS to mint sUSDS and redeem back into USDS at the live vault exchange rate",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDS balance as current direct wrapper capacity; final par-exit quality still depends on USDS's own PSM-backed exit surface.",
    ],
  }),
  "sdai-sky": erc4626InstantConfig({
    symbol: "DAI",
    reviewedAt: "2026-05-17",
    feeDescription: "Spark documents withdrawals from savings vaults without slippage or platform fees",
    docs: [
      sourceRef("Spark website", "https://spark.fi/", ["route", "fees"]),
      sourceRefRouteCapacity("Spark docs portal", "https://docs.spark.fi/"),
    ],
    notes: [
      "sDAI is the Dai Savings Rate wrapper: holders exit at the live ERC-4626 exchange rate into DAI rather than through a queued or discretionary process",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle DAI balance as current direct wrapper capacity; downstream par-exit quality is inherited from DAI's own PSM-backed redemption surface.",
    ],
  }),
  "sdola-inverse-finance": erc4626InstantConfig({
    symbol: "DOLA",
    reviewedAt: "2026-05-24",
    executionModel: "deterministic-onchain",
    totalScoreCap: 70,
    feeDescription: "sDOLA docs describe permissionless instant unwrapping back to DOLA with no lock-up period or early-withdrawal penalty.",
    docs: [
      sourceRefFull(
        "sDOLA docs",
        "https://docs.inverse.finance/inverse-finance/inverse-finance/products/tokens/dola/sdola",
      ),
      sourceRefRouteCapacityFees(
        "Inverse Peg Stability Module",
        "https://docs.inverse.finance/inverse-finance/inverse-finance/products/peg-stability-module",
      ),
    ],
    notes: [
      "Modeled route is the permissionless sDOLA wrapper exit into DOLA, not the downstream DOLA-to-USDS PSM path.",
      "Config-level cap reflects that unwrapping to DOLA does not by itself guarantee a full stablecoin exit; DOLA's own PSM capacity remains separately bounded.",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle DOLA balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "sdusd-dtrinity": defineReviewedStablecoinRedeemConfig("2026-06-10", {
    outputAssets: ["dusd-dtrinity"],
    capacityModel: { kind: "reserve-sync-metadata" },
    executionModel: "rules-based-nav",
    totalScoreCap: 70,
    costModel: documentedVariableFee(
      "dTRINITY docs state dSTAKE has no staking fee and unstaking incurs up to 10 bps retained by the vault for remaining sdUSD holders.",
      "formula",
    ),
    docs: [
      sourceRefFull("dTRINITY sdUSD docs", "https://docs.dtrinity.org/protocol-components/sdusd"),
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
    costModel: documentedVariableFee(
      "Frax's Ethereum unstaking guide exposes RemoteHop.quote() nativeFee for the outbound and return LayerZero messages; the existing route also applies the Fraxtal MintRedeemer fee. These are public variable protocol/message fees, not an undisclosed issuer schedule. Exact-request quotes and Ethereum transaction gas must be measured at the producer's observation clock; all-in cost remains unbounded until then.",
      "formula",
    ),
    reviewedAt: "2026-07-24",
    docs: [
      sourceRefFull(
        "Frax sfrxUSD stake and unstake guide (fees reviewed 2026-10-05)",
        "https://docs.frax.com/frxusd/stake-and-unstake-quickstart-ethereum",
      ),
      sourceRef(
        "Frax Ethereum RemoteHop",
        "https://www.codeslaw.app/contracts/ethereum/0x99b5587ab54a49e3f827d10175caf69c0187bfa8",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRefFull(
        "Frax Fraxtal Hop",
        "https://www.codeslaw.app/contracts/fraxtal/0x3e6a2cbafd864e09e6dab9cf035a0abea32bc0bc",
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
  "scrvusd-curve": erc4626InstantConfig({
    symbol: "crvUSD",
    outputAssets: ["crvusd-curve"],
    reviewedAt: "2026-10-01",
    feeDescription:
      "Curve docs describe scrvUSD as a Yearn V3 vault with idle crvUSD always available for redemption; yield accrues through share price rather than a separate exit fee.",
    docs: [
      sourceRefRouteCapacity("Curve scrvUSD month-in-review", "https://news.curve.finance/savings-crvusd-a-month-in-review/"),
      sourceRefFull(
        "Curve direct scrvUSD withdrawal guide",
        "https://docs.curve.finance/docs/user/yield/guides/withdraw-scrvusd.md",
      ),
    ],
    notes: [
      "Output reviewed 2026-10-01: Curve's direct withdrawal guide states that the vault pays underlying crvUSD, with no delays or lock-ups on Ethereum. This is a single crvUSD output at the vault exchange rate, not fiat or a collateral basket; cross-chain market swaps are separate routes.",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle crvUSD balance as current direct wrapper capacity; actual par-exit quality then depends on the underlying crvUSD redemption and peg-defense surface.",
    ],
  }),
  "cusdo-openeden": erc4626InstantConfig({
    symbol: "USDO",
    reviewedAt: REVIEWED_WRAPPER_WAVE_AT,
    feeDescription:
      "OpenEden integration docs route cUSDO redeem through the wrapper into USDO at convertToAssets; the separate USDO primary redemption fee is downstream of this wrapper leg.",
    docs: [
      sourceRefRouteCapacity("OpenEden cUSDO token docs", "https://docs.openeden.com/usdo/cusdo-token"),
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
      sourceRefFull("Aster USDF FAQ", "https://docs.asterdex.com/usdf-stablecoin/overview/faqs"),
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
      sourceRefRouteCapacity("Resolv docs", "https://docs.resolv.xyz/"),
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
    settlementModel: "queued",
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["settlement"],
      rationale: "The native AegisMinting route records a pending redemption request, followed by a separate funds-manager approval and collateral payout. Atomic approval/payout does not establish a request-to-receipt settlement maximum.",
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef(
          "Ethereum AegisMinting verified source: requestRedeem and approveRedeemRequest",
          "https://sourcify.dev/server/v2/contract/1/0xc4df68e592245ca5202fe8b7c438d2b799820fc2?fields=sources",
          ["route", "settlement"],
        ),
      ],
    },
    capacityModel: { kind: "supply-ratio", ratio: 0.15, confidence: "heuristic" },
    costModel: undisclosedReviewedFee(
      "Aegis documents 1:1 minting and redemption for approved users, but does not publish a fixed redemption fee",
    ),
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    docs: [
      sourceRefRouteCapacityAccess("Aegis liquidity", "https://docs.aegis.im/overview/liquidity"),
      sourceRef("Aegis FAQ", "https://docs.aegis.im/aegis-faq/how-can-i-get-my-earned-yusd", ["route"]),
      sourceRef("Aegis Accountable dashboard", "https://aegis.accountable.capital/", ["capacity"]),
      sourceRef(
        "Ethereum AegisMinting verified source: pending request, funds-manager approval and configurable redemption fee",
        "https://sourcify.dev/server/v2/contract/1/0xc4df68e592245ca5202fe8b7c438d2b799820fc2?fields=sources",
        ["route", "access", "fees", "settlement"],
      ),
    ],
    notes: [
      "Direct mint and redemption are reserved for approved primary-market users, while most secondary users access YUSD via DEX liquidity or supported venues",
      "Because YUSD relies on a delta-neutral BTC hedge rather than a pure cash-equivalent reserve bucket, the reviewed route keeps a conservative 15% immediate-capacity bound instead of scoring against full supply",
      "Ethereum AegisMinting locks YUSD in a pending request before separate funds-manager approval transfers the supported collateral output. The approval transaction is atomic, but elapsed request-to-payout settlement is unbounded by the reviewed source; configurable redeemFeeBP is not a fresh same-notional all-in cost observation",
    ],
  }),
  "usn-noon": defineStablecoinRedeemConfig({
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    capacityModel: { kind: "supply-ratio", ratio: 0.15, confidence: "heuristic" },
    costModel: undisclosedReviewedFee(
      "Noon's current Mint & Redeem and Fees pages publish zero protocol fees, excluding gas. Binding USN Terms of Service Sections 2 and 6 still allow applicable swap fees, and Section 7 permits fee increases with fourteen days' publication notice; a complete all-in redemption cost ceiling is not established.",
    ),
    reviewedAt: REVIEWED_NOON_USN_TERMS_AT,
    v9RouteReviewTerms: {
      settlementModel: "days",
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["settlement"],
      rationale: "The five-business-day processing commitment is not a seven-calendar-day maximum to completed USN redemption payout; completion, exceptions and calendar remain unproven.",
      reviewedAt: REVIEWED_NOON_USN_TERMS_AT,
      docs: [
        sourceRef(
          "Noon USN Terms of Service",
          "https://docs.noon.capital/7.-terms-and-policies/asset-terms-usn-terms-of-service.md",
          ["route", "settlement"],
        ),
      ],
    },
    docs: [
      sourceRefRouteCapacity(
        "Noon USN documentation",
        "https://docs.noon.capital/3.-the-yield-engine/return-generation.md",
      ),
      sourceRef("Noon smart contract audits", "https://docs.noon.capital/5.-the-security-framework/smart-contract-security-and-audits.md", [
        "route",
        "access",
      ]),
      sourceRef("Noon Accountable dashboard", "https://noon.accountable.capital/", ["capacity"]),
      sourceRef(
        "Noon USN Terms of Service",
        "https://docs.noon.capital/7.-terms-and-policies/asset-terms-usn-terms-of-service.md",
        ["route", "access", "fees", "settlement"],
      ),
      sourceRef(
        "Noon fees and other charges",
        "https://docs.noon.capital/2.-usdusn-and-usdsusn/fees.md",
        ["fees"],
      ),
      sourceRef("Noon liquidity", "https://docs.noon.capital/2.-usdusn-and-usdsusn/liquidity.md", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef("Noon mint and redeem", "https://docs.noon.capital/2.-usdusn-and-usdsusn/mint-and-redeem.md", [
        "route",
        "access",
        "capacity",
        "fees",
        "settlement",
      ]),
    ],
    notes: [
      "Direct mint and redemption are issuer-processed off-chain through the Company's designated interface for KYC-verified users only: ToS Section 6 commits to 1:1 redemption less applicable fees within five Business Days while reserving the right to delay redemptions, Section 29 reserves absolute and unfettered discretion to gate redemptions, and a submitted redemption request is unsecured debt owed by the Company",
      "The reviewed reserve mix is majority Fasanara FTAC private credit with a three-month redemption window (61.9% of the 2026-09-22 Accountable attestation), with delta-neutral funding-rate arbitrage a listed ToS Section 5 reserve category but a 13.40% minority slice ($5.37M HYPE book). The 15% capacity ratio remains a historical heuristic estimate, not an observed immediate buffer or an issuer-guaranteed floor.",
      "Noon's published liquidity waterfall (20% of TVL same-day, 60% at T+3, 100% at T+5) is non-binding: it is stated in calendar days against the ToS Business-Day SLA and rests on an undisclosed multi-party PLMS facility, so it is not credited as settlement or capacity evidence",
      "The published collateral wallets are not read as live capacity: their balances are transient ($3.05M of USDC/USDT at the cited 2026-09-14 block fell to $0.57M by 2026-09-22), one listed wallet is a plain EOA ops account, and they do not reconcile with Accountable's Undeployed bucket",
      "The recovered operational mint/redeem documentation states a TVL-relative redemption quota, not a fixed USD amount. No same-run protocol TVL measurement or equivalence to circulating USN supply is established, so dailyLimitUsd remains unconfigured; the exact published percentage is recorded in the redemption-backstops documentation. Operational same-day settlement does not supersede the binding five-Business-Day terms and extraordinary gating.",
    ],
  }),
  "aid-gaib": defineReviewedStablecoinRedeemConfig(REVIEWED_DIRECT_REDEMPTION_AT, {
    accessModel: "whitelisted-onchain",
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "supply-full", confidence: "documented-bound", basis: "issuer-term-redemption" },
    costModel: fixedFee(
      10,
      "GAIB docs currently show a 10 bps sell fee in the dApp — confirmed by the deployed redeemer's redemptionFeeBps() reading 10 on-chain — while direct AID minting and redemption are reserved for whitelisted users and partners",
    ),
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    docs: [
      sourceRef(
        "GAIB AID acquisition and redemption guide",
        "https://docs.gaib.ai/products/gaib-products/how-to-get-aid-said",
        ["route", "capacity", "access", "fees"],
      ),
      sourceRefRouteCapacity("GAIB economy", "https://docs.gaib.ai/gaib-overview/gaib-economy"),
    ],
    notes: [
      "Regular users typically exit AID through the GAIB app or DEX liquidity, while the modeled primary redemption rail is the whitelisted direct burn-and-withdraw contract path",
      "GAIB documents 1:1 direct AID-to-USDC redemption for whitelisted users and partners; the removed live-reserve read represented only ERC-20 supply liveness as a fixed reserve slice, not the mixed Treasury/stablecoin reserve, and no live payout-float telemetry is available now, so this route models eventual supply redemption without an immediate payout-float claim",
    ],
  }),
  "u-united-stables": defineReviewedStablecoinRedeemConfig(REVIEWED_DIRECT_REDEMPTION_AT, {
    reviewedAt: "2026-08-27",
    accessModel: "whitelisted-onchain",
    outputAssetType: "stable-basket",
    unresolvedOutputDisposition: "issuer-undisclosed",
    costModel: documentedVariableFee(
      "United Stables terms state that redemption fees are disclosed before the transaction and may change; the terms publish no fixed fee schedule",
    ),
    docs: [
      sourceRef("United Stables", "https://www.u.tech/", ["capacity"]),
      sourceRef("United Stables terms", "https://www.u.tech/terms/", ["route", "fees", "access"]),
    ],
    notes: [
      "Output re-reviewed 2026-08-27: the terms define Eligible Assets as issuer-approved assets that may include USD, certain stablecoins, and other assets designated over time. They permit United Stables to satisfy a redemption with any eligible reserve asset, including cash, at its sole discretion. The terms do not name a complete guaranteed output set, so outputAssets is intentionally unset.",
    ],
  }),
  "usx-solstice": defineReviewedStablecoinRedeemConfig("2026-10-07", {
    outputAssets: ["usdg-paxos"],
    accessModel: "whitelisted-onchain",
    costModel: undisclosedReviewedFee(
      "KYC'd institutional partners mint USX with USDC, USDG or USDT and redeem for USDG as the primary output; the current no-spread statement does not disclose a numeric redemption fee schedule",
    ),
    docs: [
      sourceRef("Solstice current USX institutional redemption terms (reviewed 2026-10-07)", "https://docs.solstice.finance/solstice-for-users/usx", ["route", "access", "fees", "settlement"]),
    ],
    notes: [
      "Retail users access USX primarily through DEX liquidity or the Solstice platform, while the primary mint/redeem rail is institution-only",
      "Reviewed 2026-10-07: current Solstice docs identify USDG as the primary redemption asset. Deposited USDC/USDT and a no-spread statement do not establish alternative redemption outputs, a numeric fee ceiling or completed settlement time.",
    ],
  }),
  "usda-avalon": defineReviewedStablecoinRedeemConfig("2026-10-07", {
    outputAssets: ["usdt-tether"],
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: undisclosedReviewedFee(
      "1:1 USDa-to-USDT conversion documented; numeric conversion/redemption fee unpublished; bridge/network charges separate",
    ),
    v9RouteReviewTerms: {
      settlementModel: "days",
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["cost", "settlement"],
      rationale: "One-business-day claim availability after bridging to Ethereum and depositing in the conversion vault is not an initial-request-to-final-USDT-transfer maximum. A 1:1 conversion ratio does not disclose a numeric fee schedule or price bridge/network charges.",
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef("Avalon USDa conversion terms (reviewed 2026-10-07)", "https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda/how-to-use-usda", ["route", "fees", "settlement"]),
      ],
    },
    docs: [
      sourceRef(
        "How to Use USDa",
        "https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda/how-to-use-usda",
        ["route", "capacity", "fees", "settlement"],
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
  "usd0-usual": defineReviewedStablecoinRedeemConfig(REVIEWED_DIRECT_REDEMPTION_AT, {
    outputAssets: ["asset:usyc", "asset:m", "asset:ustbl"],
    outputAssetType: "mixed-collateral",
    costModel: fixedFee(
      5,
      "USD0's live DaoCollateral (0xde6e1F680C4816446C8D515989E2358636A38b04) returned redeemFee()=5 bps at Ethereum block 26114898 (2026-10-03), superseding the February factsheet zero and older 10 bps metadata; the fee is governance-mutable and network gas applies",
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
      sourceRef(
        "Usual contract deployments (reviewed 2026-10-03)",
        "https://tech.usual.money/smart-contracts/contract-deployments",
        ["route", "fees"],
      ),
      sourceRef(
        "USD0 DaoCollateral contract (reviewed 2026-10-03)",
        "https://eth.blockscout.com/address/0xde6e1F680C4816446C8D515989E2358636A38b04?tab=contract",
        ["fees"],
      ),
    ],
  }),
  "usdai-usd-ai": defineReviewedStablecoinRedeemConfig(REVIEWED_DIRECT_REDEMPTION_AT, {
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    outputAssets: ["pyusd-paypal"],
    accessModel: "whitelisted-onchain",
    costModel: fixedFee(
      10,
      "USD.AI's mint/redeem upgrade notice states that direct mint and redeem are routed through market makers with a 10 bps fee applied to redemptions",
    ),
    docs: [
      sourceRefRouteCapacity("USD.AI buy / stake", "https://docs.usd.ai/app-guide/buy-stake"),
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
  "frxusd-frax": defineReviewedStablecoinRedeemConfig(REVIEWED_DIRECT_REDEMPTION_AT, {
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: documentedVariableFee(
      "The verified Ethereum USDC custodian exposes redeemFee as an 18-decimal fraction. At block 26141525 (2026-10-07T15:52:35Z), wasInitialized is true and redeemFee is zero; subsequent setMintRedeemFee calls require redeemFee < 1e18, giving a conservative 100% issuer-fee ceiling, not a fixed/current fee. previewRedeem floors decimal conversion and the fee deduction; transaction gas is separate.",
      "formula",
    ),
    docs: [
      sourceRefRouteCapacity("frxUSD mint and redeem overview", "https://docs.frax.com/frxusd/mint-and-redeem-overview"),
      sourceRef("frxUSD USDC quickstart", "https://docs.frax.com/frxusd/mint-and-redeem-quickstarts/usdc", ["route"]),
      sourceRefRouteCapacity("FraxNetDeposit contract", "https://docs.frax.com/fraxnet/contracts/fraxnetDeposit"),
      sourceRef(
        "frxUSD USDC custodian fee bound (verified 2026-03-01; pinned review 2026-10-07)",
        "https://eth.blockscout.com/api/v2/smart-contracts/0x0a2d27a86a2ea07bcc34e457c65aeca7631c0f10",
        ["route", "fees"],
      ),
    ],
    notes: [
      "Cross-chain and fiat off-ramp flows exist too, but the modeled backstop focuses on the direct onchain USDC redemption rail",
      "If the Frax balance-sheet snapshot is unavailable or stale, the route is intentionally left unrated rather than falling back to a static heuristic buffer",
      "The initialized USDC custodian 0x0a2d27a86a2ea07bcc34e457c65aeca7631c0f10 and fee were pinned at Ethereum block 26141525 via https://api-ethereum-mainnet-erigon.n.dwellir.com; the 10,000 bps bound covers issuer fees only, not rounding, gas, or downstream USDC redemption.",
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
      sourceRefRouteCapacity("JupUSD homepage", "https://jupusd.money/"),
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
  "bbqusdc-steakhouse": erc4626InstantConfig({
    symbol: "USDC",
    fallback: { fallbackRatio: 0.05, basis: "strategy-buffer" },
    reviewedAt: REVIEWED_YIELD_COVERAGE_WAVE_AT,
    feeDescription:
      "Smokehouse USDC uses a MetaMorpho vault; withdrawals redeem to USDC when vault liquidity is available and Morpho vault fees accrue from generated yield rather than a separate withdrawal fee.",
    docs: [
      sourceRefFull(
        "Smokehouse USDC vault",
        "https://app.morpho.org/ethereum/vault/0xbeefff209270748ddd194831b3fa287a5386f5bc/smokehouse-usdc",
      ),
      sourceRefRouteCapacityAccess(
        "Smokehouse launch forum",
        "https://forum.morpho.org/t/introducing-the-smokehouse-product-line-bbqusdc-and-bbqdai/1182",
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
    capacityModel: {
      kind: "reserve-sync-metadata",
      requiredOutputAssetKeys: ["m-m0"],
    },
    reviewedAt: "2026-10-09",
    totalScoreCap: 70,
    costModel: fixedFee(
      0,
      "The reviewed Ethereum WrappedMToken unwrap transfers the nominal M principal to SwapFacility without a protocol deduction; SwapFacility conversions are documented without trading fees. Gas and earning-index rounding still need exact same-notional observation",
    ),
    docs: [
      sourceRef(
        "Ethereum WrappedMToken verified implementation: onlySwapFacility and _unwrap",
        "https://eth.blockscout.com/api/v2/smart-contracts/0x6d9db63afccf515f393d5e65be69d38bb3b29d13",
        ["route", "access", "fees", "settlement"],
      ),
      sourceRef(
        "M0 SwapFacility liquidity guide: conditional atomic conversions",
        "https://docs.m0.org/build/accessing-liquidity",
        ["route", "access", "fees", "settlement"],
      ),
      sourceRef("M0 deployment identities", "https://docs.m0.org/resources/addresses/m0-platform", ["route"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "Reviewed 2026-10-09 by Sol curation campaign 2026-10-09 (Lane03M0): Ethereum wM wrap/unwrap entrypoints are callable only by SwapFacility. Users convert through the facility; _unwrap checks pause and the original caller's freeze state, burns the facility's wM and sends nominal M to the facility.",
      "The reviewed implementation was previously identity-bound to Ethereum wM at block 26095800 in the October 1 risk review; this source review does not claim a fresh proxy/storage checkpoint or identical controls on every chain.",
      "M0 documents approved-extension conversions as atomic, permissionless for end users and without trading fees. The configuration is conditional on the exact facility and extension remaining enabled, the caller being unfrozen, and the wrapper being unpaused.",
      "Live M-balance metadata is a reserve-derived bound, not an exact holder execution certificate or same-notional unwind curve. It cannot prove current allowance, access, gas, rounding, settlement confidence or downstream USD realization.",
      "Unwrapping returns M, not USDC or fiat. Current M0 Orchestration coverage is per liquidity source and requires an authenticated supported-assets/quote read; generic 1:1 or any-size statements do not establish an executable current exit quote.",
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
  "usdz-anzen": defineReviewedStablecoinRedeemConfig("2026-04-16", {
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    outputAssets: ["usdc-circle"],
    costModel: documentedVariableFee(
      "The verified USDz redeem() path deducts floor(amount * USDz.redeemFeeRate() / 1e8), then floor(the remainder * SPCT.redeemFeeRate() / 1e8), and floors the final USDC output by 1e12. Both public rates are mutable and must be read at the producer's common block with the existing reserve, identity and availability gates. Gas and rounding remain separate; the formula does not guarantee a zero fee or funded capacity.",
      "formula",
    ),
    docs: [
      sourceRef("Anzen Finance", "https://www.anzen.finance/", ["route"]),
      sourceRefRouteCapacity("Anzen documentation", "https://docs.anzen.finance/"),
      sourceRef("Anzen USDz overview", "https://docs.anzen.finance/usdz-101/overview", ["route", "fees"]),
      sourceRef(
        "USDz verified deployed source (Ethereum 0xa469b7ee...10067)",
        "https://etherscan.io/address/0xa469b7ee9ee773642b3e93e842e5d9b5baa10067#code",
        ["route", "access", "capacity", "fees"],
      ),
      sourceRef(
        "USDz verified redemption fee composition (reviewed 2026-10-05)",
        "https://eth.blockscout.com/api/v2/smart-contracts/0xa469b7ee9ee773642b3e93e842e5d9b5baa10067",
        ["route", "fees"],
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
      sourceRefRouteCapacityFees("Startale USDSC", "https://startale.com/usdsc"),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "1:1 wrapper around M: mint by wrapping, redeem through Startale's M0 SwapFacility extension; underlying M is backed by T-bill collateral attested by M0 Validators",
      "Fresh live reserve metadata reads the current M balance held by the USDSC extension and verifies the configured SwapFacility path is enabled for the approved swapper.",
      "Config-level cap reflects that the USDSC->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail still gates actual par exit",
    ],
  }),
  "apxusd-apyx": defineReviewedStablecoinRedeemConfig(REVIEWED_DIRECT_REDEMPTION_AT, {
    accessModel: "whitelisted-onchain",
    outputAssetType: "stable-single",
    outputAssets: ["usdc-circle"],
    executionModel: "rules-based-nav",
    reviewedAt: "2026-10-07",
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["settlement", "cost"],
      rationale:
        "Preferred-share liquidation settles redemption obligations in USDC, but the docs publish no finite completion SLA or same-notional ceiling on price-reflected spreads and offchain execution expenses.",
      reviewedAt: "2026-10-07",
      docs: [
        sourceRef(
          "Apyx apxUSD redemption output",
          "https://docs.apyx.fi/product-overview/apxusd-overview",
          ["route", "settlement"],
        ),
        sourceRef("Apyx price-reflected redemption expenses (reviewed 2026-10-07)", "https://docs.apyx.fi/apyx-overview/how-apyx-works", ["route", "fees"]),
      ],
    },
    costModel: documentedVariableFee(
      "Apyx docs describe mint and redeem against approved assets for whitelisted participants, with offchain execution spreads and expenses reflected in the price rather than a fixed protocol fee",
    ),
    docs: [
      sourceRef(
        "Apyx apxUSD redemption output",
        "https://docs.apyx.fi/product-overview/apxusd-overview",
        ["route", "settlement"],
      ),
      sourceRef("How to Buy apxUSD", "https://docs.apyx.fi/app-guide/how-to-buy-apxusd", ["route", "access"]),
      sourceRefRouteCapacityFees("How Apyx Works", "https://docs.apyx.fi/apyx-overview/how-apyx-works"),
      sourceRefRouteCapacity("Peg Stability Model", "https://docs.apyx.fi/solution-overview/peg-stability-model"),
    ],
    notes: [
      "Retail users primarily access apxUSD via the Curve pool, while direct minting and redemption are reserved for whitelisted participants who rebalance the market",
      "Output reviewed 2026-10-01: the product docs state 'the protocol liquidates preferred shares to USDC to settle redemption obligations; holders do not receive preferred shares directly.' The direct payout is USDC, not the reserve share basket or an assumed USDC/USDT choice. No basket weights are required.",
      "Terms reviewed 2026-10-07: Redemption Value reflects preferred-share liquidation and may include spreads/offchain execution expenses without a public numeric maximum. Neither rapid processing nor the USDC output establishes a finite completion SLA or bounded cost.",
    ],
  }),
  "pusd-polymarket": defineStablecoinRedeemConfig({
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: "2026-07-09",
    v9RouteReviewTerms: {
      settlementModel: "atomic",
      settlementDelaySec: 0,
      reviewedAt: "2026-10-09",
      docs: [
        sourceRef("Polymarket pUSD holder unwrap requirements (reviewed 2026-10-09)", "https://docs.polymarket.com/concepts/pusd", ["route", "access", "settlement"]),
        sourceRef("Verified immutable CollateralOfframp.unwrap source (reviewed 2026-10-09)", "https://polygon.blockscout.com/api/v2/smart-contracts/0x2957922eb93258b93368531d39facca3b4dc5854", ["route", "access", "settlement"]),
      ],
    },
    outputAssetType: "stable-basket",
    costModel: fixedFee(0, "1:1 wrap/unwrap via CollateralOnramp/Offramp; Polymarket documents no unwrap fee"),
    docs: [
      sourceRefRouteCapacityFees("Polymarket pUSD docs", "https://docs.polymarket.com/concepts/pusd"),
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
  "susd-solayer": defineReviewedStablecoinRedeemConfig(REVIEWED_MAY_BATCH_AT, {
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
  "usx-dforce": defineReviewedStablecoinRedeemConfig(REVIEWED_MAY_BATCH_AT, {
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
      sourceRefRouteCapacityFees("dForce USX LSR", "https://docs.usx.finance/minting-and-redeeming/lsr"),
    ],
  }),
  "xdai-gnosis": defineReviewedStablecoinRedeemConfig(REVIEWED_MAY_BATCH_AT, {
    outputAssetType: "stable-basket",
    outputAssets: ["dai-makerdao", "usds-sky"],
    costModel: fixedFee(
      0,
      "The canonical xDAI native Home Bridge has feeManagerContract() at the zero address at Gnosis block 48574355 (2026-10-03), and the Foreign Bridge transfers the full signed amount in USDS or swaps to the same DAI amount; the general OmniBridge 0.1% fee does not apply to this rail, while network gas and validator delay remain",
    ),
    docs: [
      sourceRef("Gnosis xDAI bridge", "https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef(
        "xDAI Home Bridge implementation verified source (reviewed 2026-10-03)",
        "https://gnosis.blockscout.com/address/0xe6998b0c03d3cb9ee8c04f266e573c7fa8782846?tab=contract",
        ["fees"],
      ),
      sourceRef(
        "xDAI Foreign Bridge implementation verified source (reviewed 2026-10-03)",
        "https://eth.blockscout.com/address/0x257bdd093cab1bd39ebf837dcb60f33d031d7d49?tab=contract",
        ["fees"],
      ),
    ],
    notes: [
      "Modeled as a bridge-backed stablecoin redemption route into DAI rather than an independent fiat issuer rail",
    ],
  }),
  "susdd-tron-dao-reserve": erc4626InstantConfig({
    symbol: "USDD",
    reviewedAt: REVIEWED_YIELD_COVERAGE_WAVE_AT,
    feeDescription: "USDD docs describe sUSDD withdrawals to USDD with no lock-up or protocol fee",
    docs: [
      sourceRefFull("USDD sUSDD mechanism", "https://docs.usdd.io/susdd-mechanism"),
      sourceRef("USDD savings guide", "https://docs.usdd.io/user-guide/usdd-savings", ["route"]),
    ],
    notes: [
      "sUSDD exits to USDD at the savings-vault exchange rate; downstream USDD par exit remains governed by the parent USDD route",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDD balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "rusd-reservoir": RESERVOIR_REDEEM_CONFIGS["rusd-reservoir"]!,
  "srusd-reservoir": RESERVOIR_REDEEM_CONFIGS["srusd-reservoir"]!,
  "steakusdc-steakhouse": steakhousePrimeInstantConfig("USDC"),
  "steakusdt-steakhouse": steakhousePrimeInstantConfig("USDT"),
  "syzusd-yuzu": erc4626InstantConfig({
    symbol: "yzUSD",
    reviewedAt: REVIEWED_YIELD_COVERAGE_WAVE_AT,
    totalScoreCap: 65,
    feeDescription:
      "Yuzu syzUSD ERC-4626 unwrap charges no exit fee: on-chain previewRedeem == convertToAssets (Plasma 0xc8a8df9b210243c55d31c73090f06787ad0a1bf6), no fee selectors; downstream yzUSD primary redemption stays KYC-gated",
    docs: [
      sourceRefFull("Yuzu syzUSD docs", "https://yuzu-money.gitbook.io/yuzu-money/defi-suite/staked-yzusd-syzusd"),
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
      "fxSP instantRedeem charges instantRedeemFeeRatio on both fxUSD and USDC output legs. The implementation pinned at Ethereum block 26141525 (2026-10-07T15:52:35Z) enforces MAX_INSTANT_REDEEM_FEE = 5e16 (5%); this bounds the protocol fee, not gas or third-party USDC-to-fxUSD conversion fees and price impact.",
      "formula",
    ),
    v9RouteCostTerms: { feeBpsMax: 500 },
    reviewedAt: REVIEWED_FXSAVE_LIVE_REDEMPTION_AT,
    docs: [
      sourceRefFull("f(x) Stability Pool", "https://fxprotocol.gitbook.io/fx-docs/f-x-protocol-mechanisms/stability-pool"),
      sourceRef("Integrating fxSAVE", "https://fxprotocol.gitbook.io/fx-docs/developers/integrating-fxsave", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "fxSP enforced instant-redemption fee cap (verified 2026-01-04; pinned review 2026-10-07)",
        "https://eth.blockscout.com/api/v2/smart-contracts/0x9cfefd90d4c8428d4cbac9baaa6d52c6ba7897f9",
        ["route", "fees"],
      ),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the fxSAVE vault's idle fxSP balance as current direct redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of falling back to the prior heuristic strategy-buffer estimate.",
      "Ethereum fxSP proxy 0x65c9a641afceb9c0e6034e558a319488fa0fa3be used implementation 0x9cfefd90d4c8428d4cbac9baaa6d52c6ba7897f9 at block 26141525 via https://api-ethereum-mainnet-erigon.n.dwellir.com; re-review the bound when the implementation changes. The fxUSD-only router swaps the USDC leg separately.",
    ],
  }),
  "susn-noon": erc4626InstantConfig({
    symbol: "USN",
    reviewedAt: REVIEWED_SUSN_WITHDRAWAL_RAIL_AT,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    totalScoreCap: 65,
    feeDescription:
      "Noon docs state Noon does not charge fees or other dApp charges; sUSN unstaking exits to USN through the withdrawal-handler request/claim rail with no protocol fee (gas only).",
    docs: [
      sourceRefFull("Noon USN and sUSN", "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn"),
      sourceRef(
        "Noon minting and redemption",
        "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn/minting-and-redemption",
        ["route", "access", "settlement"],
      ),
      sourceRef(
        "Noon fees and other charges",
        "https://docs.noon.capital/built-for-high-yields/fees-and-other-charges",
        ["fees"],
      ),
      sourceRef(
        "sUSN staking vault (Ethereum)",
        "https://etherscan.io/address/0xE24a3DC889621612422A64E6388927901608B91D#readContract",
        ["route", "capacity"],
      ),
      sourceRef(
        "Noon WithdrawalHandler (Ethereum)",
        "https://etherscan.io/address/0x0DaBc0D9B270c9B0C4C77AaCeAa712b56D0F9178#readContract",
        ["route", "settlement"],
      ),
      sourceRef(
        "WithdrawalHandler admin timelock (Ethereum)",
        "https://etherscan.io/address/0x36857EF0B10A61A68d58C29eE256990fa9699722#readContract",
        ["settlement"],
      ),
      sourceRef(
        "Noon current liquidity: sUSN seven-day cooldown to USN",
        "https://docs.noon.capital/2.-usdusn-and-usdsusn/liquidity.md",
        ["route", "settlement"],
      ),
      sourceRef(
        "Noon sUSN Staking Terms, Section 11 suspension powers",
        "https://docs.noon.capital/7.-terms-and-policies/asset-terms-susn-staking-terms.md",
        ["access", "settlement"],
      ),
    ],
    notes: [
      "Exits run a holder-initiated request/claim rail with no operator step: a withdraw moves USN to the WithdrawalHandler with a timestamp in the same transaction, and claimWithdrawal pays after the handler's on-chain withdrawPeriod (604,800 seconds today, live-read each run by the redemption observer).",
      "withdrawPeriod is changeable only through the 48-hour GenericTimelock that admins the handler, but the value is unbounded and a change applies retroactively to requests already in flight; ten whitelisted addresses keep a one-transaction instant path.",
      "Capacity is the vault's measured idle USN read on-chain each run (100% of totalAssets as of the 2026-09-22 review), combined with the 7-day settlement bound; if the live snapshot is unavailable, the route is left unrated instead of using a prior model.",
      "Noon's current liquidity documentation states a seven-day sUSN-to-USN cooldown. The July 31, 2026 staking terms, Section 11, separately permit a temporary freeze on all staking withdrawals and interest payments during a treasury Suspension Event. These documented terms do not establish current same-notional measuredUnwind capacity, a full USD-realization bound or an exact-complete route certificate.",
    ],
  }),
  "usdcx-movement": defineReviewedStablecoinRedeemConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
    outputAssets: ["usdc-circle"],
    executionModel: "deterministic-onchain",
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    costModel: {
      ...documentedVariableFee(
        "Circle's xReserve fee reference lists destination-specific withdrawal charges: Ethereum has no protocol fee plus a 1 USDC gas charge, with optional forwarding adding 0.20 USDC plus 0.80 USDC gas; other destinations list up to 2 protocol bps plus 2 USDC gas. The bounds below are the published ceiling across destinations; remote-chain execution gas is separate",
      ),
      feeBpsMin: 0,
      feeBpsMax: 2,
      gasOrBridgeCostUsd: 2,
    },
    docs: [
      sourceRefFull("Circle xReserve", "https://www.circle.com/xreserve"),
      sourceRef("Circle xReserve fees (reviewed 2026-10-03)", "https://developers.circle.com/xreserve/references/fees", ["fees"]),
      sourceRefRouteCapacityAccess(
        "Movement USDCx announcement",
        "https://www.movementnetwork.xyz/article/introducing-usdcx-movements-native-usdc-backed-stablecoin",
      ),
    ],
    notes: [
      "USDCx exits into tracked Circle USDC through the xReserve contract; final fiat redemption remains Circle's issuer route.",
      "Fresh reserve telemetry reads xReserve's balanceOfNativeCollateral(USDC, Movement domain 10005) on Ethereum as the live escrowed-USDC exit bound; when that read is unavailable the route is left unrated instead of assuming the full supply is releasable.",
    ],
  }),
  ...defineConfigFamily(
    [
      {
        id: "susdt-spark",
        symbol: "USDT",
        reviewedAt: "2026-05-17",
        feeDescription:
          "Spark docs describe Savings vault tokens as fee-free ERC-4626 products; spUSDT withdrawals redeem for USDT at the live vault exchange rate.",
        docs: [
          sourceRefFull("Spark docs", "https://docs.spark.fi/"),
          sourceRef("Spark app", "https://spark.fi/", ["route"]),
        ],
        notes: [
          "Fresh ERC-4626 reserve telemetry reads the vault's idle USDT balance as current direct redemption capacity; if the live snapshot is unavailable, the wrapper route is left unrated instead of assuming full-supply immediacy.",
        ],
      },
      {
        id: "susdc-spark",
        symbol: "USDC",
        reviewedAt: "2026-05-17",
        feeDescription:
          "Spark docs describe Savings vault tokens as fee-free ERC-4626 products; spUSDC withdrawals redeem for USDC at the live vault exchange rate.",
        docs: [
          sourceRefFull("Spark docs", "https://docs.spark.fi/"),
          sourceRef("Spark app", "https://spark.fi/", ["route"]),
        ],
        notes: [
          "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as current direct redemption capacity; if the live snapshot is unavailable, the wrapper route is left unrated instead of assuming full-supply immediacy.",
        ],
      },
    ],
    ({ id: _id, ...row }) => erc4626InstantConfig(row),
  ),
  "gtusdc-gauntlet": gauntletMorphoConfig(
    "Gauntlet USDC Core vault",
    "https://app.morpho.org/ethereum/vault/0xdd0f28e19c1780eb6396170735d45153d261490d/gauntlet-usdc-core",
  ),
  "gtusdcp-gauntlet": gauntletMorphoConfig(
    "Gauntlet USDC Prime vault",
    "https://app.morpho.org/ethereum/vault/0x8c106eedad96553e64287a5a6839c3cc78afa3d0/gauntlet-usdc-prime",
  ),
  "yvusdc-yearn": erc4626InstantConfig({
    symbol: "USDC",
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    feeDescription:
      "Yearn v3 vault withdrawals redeem yvUSDC-1 to USDC at the live vault exchange rate; Yearn reports performance fees on yield, not a separate withdrawal fee.",
    docs: [
      sourceRefFull("Yearn v3 USDC vault", "https://yearn.fi/v3/1/0xbe53a109b494e5c9f97b9cd39fe969be68bf6204"),
      sourceRefFull("Yearn docs", "https://docs.yearn.fi/"),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry measures Yearn V3 default-queue withdrawable capacity from total idle USDC plus each funded strategy's maxRedeem(vault) value; if the live snapshot is unavailable, the route is left unrated instead of falling back to full NAV.",
    ],
  }),
  "sgho-aave": erc4626InstantConfig({
    symbol: "GHO",
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    feeDescription:
      "Aave sGHO previewRedeem returns the GHO amount received for redeeming sGHO shares; no separate sGHO redemption fee is documented.",
    docs: [
      sourceRefFull("Aave sGHO guide", "https://aave.com/docs/aave-v3/guides/sgho"),
      sourceRefRouteCapacityAccess(
        "Aave sGHO governance configuration",
        "https://governance.aave.com/t/arfc-sgho-launch-configuration/24346",
      ),
    ],
    notes: [
      "This route models the current legacy sGHO/stkGHO-compatible contract's previewRedeem exit into GHO, not the separate Aave Umbrella stkGHO safety-module cooldown route.",
      "Fresh sGHO telemetry scores the contract's live previewRedeem(totalSupply) output as current direct redemption capacity into GHO; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "stusds-sky": erc4626InstantConfig({
    symbol: "USDS",
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    feeDescription:
      "Sky stUSDS implements ERC-4626 withdraw/redeem to USDS at the chi exchange rate; the published implementation does not apply a separate exit fee.",
    docs: [
      sourceRefFull("Sky stUSDS docs", "https://developers.skyeco.com/protocol/tokens/stusds/"),
      sourceRefRouteCapacity("Sky protocol token routes", "https://developers.sky.money/quick-start/protocol-token-routes/"),
    ],
    notes: [
      "stUSDS is an ERC-4626 risk-capital wrapper over USDS: holders can deposit USDS to receive stUSDS or withdraw USDS with their stUSDS balance.",
      "The wrapper leg exits into USDS; downstream USDS par-exit quality remains governed by Sky's PSM route, while stUSDS holder value can reflect module liquidity and slashing risk.",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle USDS balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
    ],
  }),
  "stcusd-cap": erc4626InstantConfig({
    symbol: "cUSD",
    reviewedAt: "2026-05-17",
    feeDescription:
      "stcUSD unstakes to cUSD fee-free at the live vault exchange rate (only accrued-yield/lockedProfit NAV growth, no separate stcUSD wrapper fee); the 0.25% (0% whitelisted) fee is the downstream cUSD mint/burn/redeem leg, not the stcUSD step",
    docs: [
      sourceRefFull("Cap stcUSD mechanics", "https://docs.cap.app/protocol-overview/stcusd-mechanics"),
      sourceRefRouteCapacity("Cap cUSD mechanics", "https://docs.cap.app/protocol-overview/cusd-mechanics"),
      sourceRefRouteCapacityFees("Cap vault", "https://docs.cap.app/concepts/vault"),
    ],
    notes: [
      "Fresh ERC-4626 reserve telemetry reads the vault's idle cUSD balance as current direct wrapper capacity; final cUSD par exit inherits Cap's proportional reserve-basket redemption route.",
    ],
  }),
  "sbold-k3-capital": erc4626InstantConfig({
    symbol: "BOLD",
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    // The static documented-bound downgrade is retired: the adapter now reads
    // K3's collateral-health gate (maxCollInBold) each run and self-downgrades
    // to documented-bound whenever the gate is restricted or unreadable, so an
    // observed-open run may resolve live-direct.
    fallback: { basis: "strategy-buffer" },
    feeDescription:
      "K3 docs describe sBOLD entry fees only on deposit and mint; withdraw/redeem burns shares and returns BOLD at the vault exchange rate.",
    docs: [
      sourceRefRouteCapacity("K3 sBOLD introduction", "https://k3-capital.gitbook.io/sbold/introducing-sbold"),
      sourceRefRouteCapacityFees("K3 sBOLD technical details", "https://k3-capital.gitbook.io/sbold/technical-details"),
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
  "ybold-yearn": erc4626InstantConfig({
    symbol: "BOLD",
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    feeDescription: "Yearn yBOLD docs state yBOLD is always redeemable for underlying BOLD without withdrawal fees or a waiting period.",
    docs: [
      sourceRefFull("Yearn yBOLD vault", "https://yearn.fi/v3/1/0x9f4330700a36b29952869fac9b33f45eedd8a3d8"),
      sourceRefRouteCapacityFees("Yearn yBOLD docs", "https://docs.yearn.fi/getting-started/products/yvaults/yBold"),
      sourceRefRouteCapacityFees("Yearn yBOLD API", "https://ydaemon.yearn.fi/1/vaults/0x9f4330700a36b29952869fac9b33f45eedd8a3d8"),
    ],
    notes: [
      "yBOLD exits into BOLD through ERC-4626 withdrawal/redeem mechanics; downstream BOLD par exit remains Liquity's collateral-redemption route.",
      "The Yearn API currently identifies yBOLD as a tokenized BOLD Stability Pool product and reports zero management and performance fees.",
      "Fresh ERC-4626 reserve telemetry measures Yearn V3 default-queue withdrawable capacity from total idle BOLD plus each funded strategy's maxRedeem(vault) value; if the live snapshot is unavailable, the route is left unrated instead of falling back to full NAV.",
    ],
  }),
  "nusd-neutrl": defineStablecoinRedeemConfig({
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "unquantified" },
    accessModel: "permissionless-onchain",
    holderEligibility: "issuer-discretionary",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    reviewedAt: "2026-10-02",
    costModel: fixedFee(
      4900,
      "The September 17 Neutrl redemption programme pays 0.51 USDC per NUSD: redemptionRate() = 510000000000000000 and quoteRedeem(1e18) = 510000 USDC units at Ethereum block 26105308 on 2026-10-02, a measured 4,900 bps discount to the $1 target rather than a separate transaction fee",
    ),
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity"],
      rationale:
        "The programme's USDC payout and fixed rate are verified, but no raw programme capacity bound is established. Its measured 4,900 bps cost yields zero executable capacity within the policy request budget; this is not a zero-reserve claim. The frontend agreement makes funding and issuer-imposed caps discretionary, so raw capacity remains unknown and cannot grant route credit.",
      reviewedAt: "2026-10-02",
      docs: [
        sourceRef(
          "Neutrl redemption programme agreement, Sections III(D) and VI",
          "https://redeem.neutrl.finance/",
          ["route", "access"],
        ),
      ],
    },
    docs: [
      sourceRef(
        "Neutrl September 17 fixed-rate USDC redemption programme announcement",
        "https://x.com/Neutrl/status/2100614848241414280",
        ["route", "fees", "access"],
      ),
      sourceRef(
        "Neutrl NusdRedemption verified contract; pinned Ethereum block 26105308",
        "https://eth.blockscout.com/address/0xb3f07d3392102fc23264a78e2a1a8b6421123828?tab=contract",
        ["route", "fees", "settlement", "access"],
      ),
      sourceRef(
        "Neutrl redemption frontend and holder release agreement",
        "https://redeem.neutrl.finance/",
        ["route", "fees", "settlement", "access"],
      ),
    ],
    notes: [
      "The issuer route is the separate redemption programme at 0xb3f07d3392102fc23264a78e2a1a8b6421123828, not the historical KYC-gated instant/queued par route. NUSD() and USDC() at block 26105308 bind the tracked NUSD token and Ethereum USDC; paused() and isRedeemWhitelistEnforced() both returned false.",
      "The frontend requires the holder's wallet to sign the current onchain acknowledgement and release of claims before redeeming. The agreement requires legal/beneficial ownership, legal capacity and age of majority, excludes sanctioned/restricted persons, and permits issuer refusal, delay, blocking or freezing; permissionless contract access does not imply universal holder eligibility.",
      "Section III(D) makes programme availability contingent on USDC and issuer discretion, including aggregate/per-holder caps. Raw programme capacity remains a bounded-terms gap. The fixed-usd zero represents only executable capacity within the policy cost budget, because the measured payout cost is 4,900 bps; no zero reserves, full-supply obligation or live reserve balance is inferred.",
    ],
  }),
  "yusd-yieldfi": {
    ...erc4626InstantConfig({
      symbol: "USDC",
      fallback: { fallbackRatio: 0.1, confidence: "documented-bound", basis: "strategy-buffer" },
      reviewedAt: "2026-10-02",
      settlementModel: "queued",
      feeDescription:
        "YieldFi yUSD token terms list no redemption fee other than network gas; requests still settle after the documented cooldown/keeper process.",
      docs: [
        sourceRef("YieldFi v2 yUSD pause banner observed 2026-10-02", "https://v2.yield.fi/yusd", ["route"]),
        sourceRefRouteCapacityFees("YieldFi yUSD token terms", "https://docs.yield.fi/legal-documents/token-terms/yusd"),
        sourceRef(
          "YieldFi smart contract interaction",
          "https://docs.yield.fi/technical-docs/smart-contract-interaction",
          ["route", "capacity", "access", "settlement"],
        ),
        sourceRef("YieldFi fees", "https://docs.yield.fi/fees", ["fees"]),
      ],
      notes: [
        "Route status is unknown: on 2026-10-02 the v2.yield.fi/yusd frontend displayed \"Mint and Redeem operations for yUSD and vyUSD are paused until we seek remediation from SAGA as per the contractual agreement with them.\" The observation establishes no pause start date, loss amount, suspension record or cessation of independent DEX exits.",
        "The historical yUSD route is an ERC-4626 vault over USDC; redemption burns shares immediately but underlying USDC is delivered through a queued request after the cooldown period. These terms and the reserve telemetry below do not establish that redemption is currently open.",
        "Because yUSD allocates into delta-neutral and private-credit strategy positions, the reviewed route uses the documented queued route with a conservative 10% strategy-buffer capacity instead of scoring against full supply.",
        "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as the current redeemable bound while the queued request flow still governs settlement; the reviewed 10% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
      ],
    }),
    routeStatus: "unknown",
  },
  "said-gaib": erc4626InstantConfig({
    symbol: "AID",
    outputAssets: ["aid-gaib"],
    reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
    settlementModel: "queued",
    outputAssetType: "stable-single",
    feeDescription:
      "sAID exits to AID through a monthly FIFO withdrawal cycle at unstaking NAV; verified source exposes no separate unstaking-fee deduction",
    docs: [
      sourceRefFull("GAIB sAID docs", "https://docs.gaib.ai/products/gaib-products/staked-ai-dollar-said"),
      sourceRef("GAIB AID docs", "https://docs.gaib.ai/products/gaib-products/ai-dollar-aid", ["route", "access"]),
    ],
    notes: [
      "sAID is not a $1-pegged wrapper; this route models the holder-exercisable withdrawal into AID at unstaking NAV, including possible unrealized-loss haircuts.",
      "Final AID redemption into supported stablecoins remains whitelisted for primary-market users, while regular users generally exit AID through app or DEX liquidity.",
      "Fresh ERC-4626 reserve telemetry reads the vault's idle AID balance as the current redeemable bound while the monthly FIFO cycle still governs settlement; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
      "Output type corrected 2026-07-19: the withdrawal pays AID (tracked aid-gaib, a $1-target stablecoin) — the previously declared output asset — so the nav placeholder type was replaced with stable-single; the unstaking-NAV conversion-rate and haircut caveats above are unchanged and remain captured by the queued rules-based-nav execution model.",
    ],
  }),
  "zys-zephyr-protocol": defineReviewedStablecoinRedeemConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    outputAssets: ["zsd-zephyr-protocol"],
    reviewedAt: REVIEWED_EXIT_CREDIT_AT,
    costModel: fixedFee(
      10,
      "Zephyr's consensus RingCT verification deducts a fixed 0.1% conversion fee from the yield price on every REDEEM_YIELD conversion",
    ),
    docs: [
      sourceRefRouteCapacityAccess("Zephyr integration documentation", "https://zephyrprotocol.com/documentation"),
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
  "aa-falconx-mev-capital": defineReviewedStablecoinRedeemConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
    outputAssets: ["usdc-circle"],
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    costModel: undisclosedReviewedFee(
      "Idle Perpetual Yield Tranches expose CDO tranche redemption mechanics; public materials reviewed do not publish one fixed senior-tranche redemption fee",
    ),
    docs: [
      sourceRefFull("Idle Yield Tranches methods", "https://docs.idle.finance/developers/yield-tranches/methods"),
      sourceRefRouteCapacityAccess(
        "Pareto credit vault addresses",
        "https://docs.pareto.credit/developers/addresses/product/credit-vaults",
      ),
    ],
    notes: [
      "Modeled as a NAV tranche exit to underlying USDC exposure, with whitelist and CDO-liquidity constraints rather than an issuer fiat redemption route.",
    ],
  }),
  "usdb-blast": defineReviewedStablecoinRedeemConfig(REVIEWED_FOLLOWUP_REMEDIATION_AT, {
    outputAssets: ["dai-makerdao"],
    settlementModel: "days",
    outputAssetType: "stable-single",
    costModel: undisclosedReviewedFee(
      "Blast docs describe USDB redemption for DAI when bridging back to Ethereum; bridge gas and withdrawal costs are variable and no separate fixed redemption fee was identified",
    ),
    routeExitCorrelation: "wrapper-to-parent-dependency",
    docs: [
      sourceRefFull("Blast developer docs", "https://docs.blast.io/"),
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
  "weusd-picwe": defineReviewedStablecoinRedeemConfig(REVIEWED_YIELD_COVERAGE_WAVE_AT, {
    outputAssets: ["usdc-circle"],
    costModel: fixedFee(100, "PicWe docs describe a 1% WEUSD redemption fee"),
    docs: [
      sourceRefFull("PicWe WEUSD", "https://docs.picwe.org/what-is-weusd"),
      sourceRef("PicWe mint and redeem", "https://docs.picwe.org/mint-and-redeem", ["route", "fees"]),
    ],
  }),
  "autousd-auto-finance": erc4626InstantConfig({
    symbol: "USDC",
    fallback: { fallbackRatio: 0.05, basis: "strategy-buffer" },
    reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
    feeDescription:
      "Auto Finance autopools redeem/withdraw burns autoUSD shares for USDC without a separate exit-fee deduction; streaming and periodic fees are NAV/accounting fees",
    docs: [
      sourceRefFull("Auto Finance autopools overview", "https://docs.auto.finance/auto-pools-protocol/autopools-tl-dr.md"),
      sourceRef(
        "Auto Finance protocol mechanics",
        "https://docs.auto.finance/auto-pools-protocol/protocol-mechanics.md",
        ["route", "capacity", "access", "settlement"],
      ),
      sourceRefRouteCapacityAccess(
        "Auto Finance contract addresses",
        "https://docs.auto.finance/developer-docs/contracts-overview/contract-addresses",
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
    costModel: documentedVariableFee(
      "The request-based eEARN exit charges the admin-set withdrawal-validator fee; previewRedeem conversion equality does not establish that fee. Only fresh admitted validator telemetry quantifies the current charge, with no static zero or permanent 5 bps fallback",
      "formula",
    ),
    reviewedAt: "2026-10-07",
    docs: [
      sourceRef("Ember Earn", "https://trade.bluefin.io/ember/eEARN", ["route", "access"]),
      sourceRef(
        "Ethereum eEARN request-based vault",
        "https://etherscan.io/address/0x9be9294722f8aad37b11a9792be2c782182cafa2#code",
        ["route", "access", "settlement"],
      ),
      sourceRef("Ember withdrawal validator (fee reviewed at Ethereum block 26142848 on 2026-10-07)", "https://etherscan.io/address/0x4c735b0989f1a7464991bcca9f0e8c661ba54465#readProxyContract", ["route", "fees"]),
    ],
    notes: [
      "The holder path submits a request to an operator-processed queue. The reviewed route therefore publishes queued settlement; no positive capacity is eligible for the shared 300-second horizon without a bounded completion path.",
      "Fresh specialized telemetry pins the vault, validator, protocol-config proxies and implementations, reads pause/queue state and the current admin-configurable fee, and keeps idle USDC diagnostic-only. Identity or state-read drift fails closed with no static capacity fallback.",
      "Fee reviewed 2026-10-07: withdrawalFee(vault) measured 5 bps at Ethereum block 26142848. That historical reading is not a permanent schedule; stale, failed or inadmissible live fee evidence leaves the fee unquantified. Standard ERC-4626 redeem/withdraw are disabled and preview conversion is not the validator's charged fee.",
    ],
  }),
  "trusd-tori": defineStablecoinRedeemConfig({
    accessModel: "whitelisted-onchain",
    outputAssetType: "stable-basket",
    outputAssets: ["usdc-circle", "usdt-tether"],
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    executionModel: "rules-based-nav",
    costModel: fixedFee(10, "Tori documents a 0.1% fee on direct trUSD minting and redemption"),
    routeExitCorrelation: "same-protocol-liquidity",
    reviewedAt: "2026-08-13",
    docs: [
      sourceRef("Institutional access and direct mint/redeem", "https://docs.tori.finance/resources/institutional", [
        "route",
        "access",
        "fees",
      ]),
      sourceRef("trUSD product", "https://docs.tori.finance/products/trusd", ["route", "access", "fees"]),
      sourceRef("trUSD FAQ", "https://docs.tori.finance/faq/trusd", ["route", "access", "fees", "settlement"]),
      sourceRef("Official contracts", "https://docs.tori.finance/resources/contracts", ["route", "access"]),
      sourceRef("Risk disclosures", "https://docs.tori.finance/resources/risks", ["capacity", "route"]),
    ],
    notes: [
      "The modeled primary rail is direct trUSD redemption by KYC/AML and risk-verified participants using whitelisted wallets, paying USDC or USDT at NAV/market rate.",
      "The reviewed 10% strategy-buffer heuristic avoids treating trUSD's delta-neutral reserve stack as immediately redeemable full supply; Tori does not publish a current USDC/USDT buffer or executable capacity.",
      "Unverified users' market swaps are secondary liquidity and are excluded from the redemption backstop.",
    ],
  }),
  "jpyt-dephaser": defineReviewedStablecoinRedeemConfig("2026-08-13", {
    outputAssetType: "stable-basket",
    outputAssets: ["usdt-tether", "usdc-circle"],
    settlementModel: "days",
    executionModel: "rules-based-nav",
    costModel: undisclosedReviewedFee(
      "DePhaser's public terms disclose user-paid gas, while the contract source exposes protocol fee controls and reviewed materials do not establish an immutable numeric redemption fee",
    ),
    routeStatus: "open",
    routeExitCorrelation: "same-protocol-liquidity",
    docs: [
      sourceRef("DePhaser overview", "https://docs.dephaser.com/", ["route", "access"]),
      sourceRef("DePhaser money flow", "https://docs.dephaser.com/how-it-works/money-flow/", [
        "route",
        "capacity",
        "settlement",
      ]),
      sourceRef("DePhaser reliable yen stablecoin", "https://docs.dephaser.com/how-it-works/reliable-yen-stablecoin", [
        "route",
      ]),
      sourceRef("DePhaser Terms of Service", "https://docs.dephaser.com/policy/terms-of-service", [
        "route",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("DePhaser DEX and redemption timing", "https://docs.dephaser.com/how-it-works/dex", ["settlement"]),
      sourceRef("DePhaser contracts repository", "https://github.com/0xDephaser/contracts", [
        "route",
        "access",
        "fees",
        "settlement",
      ]),
      sourceRef("Optimism public RPC", "https://optimism-rpc.publicnode.com", ["capacity", "route"]),
      sourceRef("Base public RPC", "https://base-rpc.publicnode.com", ["capacity", "route"]),
    ],
    notes: [
      "Redemption burns JPYT and unlocks USDT on Optimism or USDC on Base after the security cooldown; the reviewed route has no published reserve-capacity ceiling beyond deposit-manager/Aave liquidity.",
      "Execution is rules-based NAV: redemption pays the average Lock-In Exchange Rate, not spot JPY/USD par, so redemption value can deviate from current peg value because of the locked FX basis.",
      "The documented completion window is no more than 24 hours, but the conservative days bucket preserves the non-atomic two-step request/execute flow.",
    ],
  }),
  "suiusde-sui": defineStablecoinRedeemConfig({
    accessModel: "whitelisted-onchain",
    outputAssets: ["usdc-circle"],
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: undisclosedReviewedFee(
      "The public SDK exposes a collateral defaultFee field, but reviewed primary sources do not publish the active numeric redemption fee",
    ),
    holderEligibility: "whitelisted-primary",
    routeExitCorrelation: "wrapper-to-parent-dependency",
    reviewedAt: "2026-08-13",
    docs: [
      sourceRef("Sui/Ethena suiUSDe announcement", "https://www.sui.io/blog/suig-ethena-suiusde-stablecoin", [
        "route",
        "access",
      ]),
      sourceRef("SuiUSDe SDK README", "https://github.com/ethena-labs/suiusde-sdk", ["route", "access", "settlement"]),
      sourceRef("SDK redemption transaction builder", "https://raw.githubusercontent.com/ethena-labs/suiusde-sdk/main/src/redeem.ts", [
        "route",
        "settlement",
      ]),
      sourceRef("SDK role-gated action surface", "https://raw.githubusercontent.com/ethena-labs/suiusde-sdk/main/src/suiusde.ts", [
        "route",
        "access",
        "settlement",
      ]),
      sourceRef("SDK config and pause state", "https://raw.githubusercontent.com/ethena-labs/suiusde-sdk/main/src/generated/suiusde/config.ts", [
        "capacity",
        "access",
      ]),
      sourceRef("SDK redemption limiter", "https://raw.githubusercontent.com/ethena-labs/suiusde-sdk/main/src/generated/suiusde/limiter.ts", [
        "capacity",
        "access",
      ]),
      sourceRef("SDK collateral query", "https://raw.githubusercontent.com/ethena-labs/suiusde-sdk/main/src/suiusde.ts", [
        "capacity",
        "fees",
      ]),
    ],
    notes: [
      "The modeled route is suiUSDe's own role-gated Sui redemption into USDC, not a generic bridge to parent USDe; the SDK builds the redemption and USDC transfer in one transaction.",
      "The reviewed 10% strategy-buffer heuristic avoids treating suiUSDe's delta-neutral reserve stack as immediately redeemable full supply; enablement, pause state, global/collateral/benefactor limits, and current redeem balance remain operational controls outside this static bound.",
    ],
  }),
};

const FINALIZED_STABLECOIN_REDEEM_BACKSTOP_REGISTRY = finalizeBackstopRegistry(
  defineRecordEntries(RAW_STABLECOIN_REDEEM_BACKSTOP_CONFIGS, { sourceFilePath: SOURCE_FILE_PATH }),
  [
    { stablecoinIds: ["ousg-ondo-finance", "u-united-stables", "usd0-usual"] },
    { stablecoinIds: ["dusd-dtrinity", "yousd-yield-optimizer"], reviewedAt: REVIEWED_REMEDIATION_AT },
    {
      stablecoinIds: ["pusd-polymarket", "susd-solayer", "usx-dforce", "xdai-gnosis"],
      reviewedAt: REVIEWED_MAY_BATCH_AT,
    },
  ],
);

export const STABLECOIN_REDEEM_BACKSTOP_ENTRIES = FINALIZED_STABLECOIN_REDEEM_BACKSTOP_REGISTRY.entries;
