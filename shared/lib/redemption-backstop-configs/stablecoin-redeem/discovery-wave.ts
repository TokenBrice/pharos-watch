import { defineConfigFamily } from "../factory";
import {
  fixedFee,
  sourceRef,
  sourceRefFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
} from "../shared";
import { defineStablecoinRedeemConfig, erc4626InstantConfig } from "./shared";

const REVIEWED_AT = "2026-10-03";
const MORPHO_V2_SOURCE = "https://raw.githubusercontent.com/morpho-org/vault-v2/c034336f82b0415f786fa15fc61fa81bf5256e31/src/VaultV2.sol";
const MORPHO_V2_DOCS = "https://docs.morpho.org/learn/concepts/vault-v2/";

// Match the OnRe unmeasured-liquidity precedent: zero is a conservative
// modeled lower bound, not an observed balance or a fabricated live adapter.
function unmeasuredCapacityConfig(config: RedemptionBackstopConfig): RedemptionBackstopConfig {
  return {
    ...config,
    capacityModel: { kind: "fixed-usd", amountUsd: 0, confidence: "dynamic" },
    v9RouteReviewTerms: config.v9RouteReviewTerms ?? {
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity"],
      rationale: "The holder route is reviewed, but no exact-route adapter measures current executable output liquidity. No capacity is credited from NAV, historical balances or a static supply fallback.",
      reviewedAt: REVIEWED_AT,
      docs: config.docs,
    },
    notes: [
      ...(config.notes ?? []),
      "Zero modeled capacity is a conservative lower bound while executable output liquidity is unmeasured, not an observed empty vault; capacity remains an explicit scoring gap.",
    ],
  };
}

// Only the ordinary underlying-token withdrawal is modeled. Emergency
// force-deallocation and in-kind lending positions are not additive cash exits.
const morphoVaultRoutes = defineConfigFamily(
  [
    { id: "senpyusdmwin-sentora", assetId: "pyusd-paypal", symbol: "PYUSD", chain: "ethereum", address: "0x7cbcfc4f64be199ede6db1d916ddcdb69f666b57" },
    { id: "steakusdg-steakhouse", assetId: "usdg-paxos", symbol: "USDG", chain: "robinhood-chain", address: "0xbeeff033f34c046626b8d0a041844c5d1a5409dd" },
    { id: "sirloinusdc-steakhouse", assetId: "usdc-circle", symbol: "USDC", chain: "base", address: "0xbeeff2490feffa212fac2f6553682c219e6a8845" },
    { id: "gusdtq-galaxy", assetId: "usdt-tether", symbol: "USDT", chain: "ethereum", address: "0x71ffb6a81786ec285d429d531cf655107b9d878d" },
    { id: "senpathusd-sentora", assetId: "pathusd-bridge", symbol: "pathUSD", chain: "tempo", address: "0x9a044ae05e5e6290dcf56afd69548565e957a626" },
    { id: "senrlusdv2-sentora", assetId: "rlusd-ripple", symbol: "RLUSD", chain: "ethereum", address: "0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf" },
    { id: "krusdc-keyrock", assetId: "usdc-circle", symbol: "USDC", chain: "arc", address: "0x5befab92a5a3d60f578cb51eeb4e4fd50a1e3123" },
    { id: "kpkusdcprime-kpk", assetId: "usdc-circle", symbol: "USDC", chain: "ethereum", address: "0x4ef53d2caa51c447fdfeeedee8f07fd1962c9ee6" },
    { id: "skymoneyusdtsavings-sky", assetId: "usdt-tether", symbol: "USDT", chain: "ethereum", address: "0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11" },
    { id: "steakcusdc-steakhouse", assetId: "usdc-circle", symbol: "USDC", chain: "ethereum", address: "0xbeef00a59b577423653a1526c7009bde103f542b" },
    { id: "senpyusdpst-sentora", assetId: "pyusd-paypal", symbol: "PYUSD", chain: "ethereum", address: "0x8381a156958711e230f325428b5eb4b6555c75d9" },
    { id: "cscbusdc-clearstar", assetId: "usdc-circle", symbol: "USDC", chain: "base", address: "0x91c056b6d4311a743614fbc03ac32d4e6a2d3a3c" },
    { id: "sparkusdtbc-spark", assetId: "usdt-tether", symbol: "USDT", chain: "ethereum", address: "0xb0c424116172b55cbb6dd3136f5989f7959e5b91", capacityUnmeasured: true },
    { id: "pendleusdc-pendle", assetId: "usdc-circle", symbol: "USDC", chain: "ethereum", address: "0x55c1b6e461a6334b567baf0feb5d728715446f05" },
    { id: "senpyusdprimev2-sentora", assetId: "pyusd-paypal", symbol: "PYUSD", chain: "ethereum", address: "0xc21b08c16458202593d4d9b26b9984ee67b38bbd" },
    { id: "senpyusdmain-sentora", assetId: "pyusd-paypal", symbol: "PYUSD", chain: "ethereum", address: "0xb576765fb15505433af24fee2c0325895c559fb2" },
    { id: "hyperusdca-hyperithm", assetId: "usdc-circle", symbol: "USDC", chain: "monad", address: "0x78999cc96d2ba0341588c60ccb0e91c6c33cf371" },
    { id: "gusdcq-galaxy", assetId: "usdc-circle", symbol: "USDC", chain: "ethereum", address: "0x91600e31fbedc72433d4a57f16639cfe661be7d8" },
    { id: "steakeurcv-steakhouse", assetId: "eurcv-societe-generale-forge", symbol: "EURCV", chain: "ethereum", address: "0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f" },
    { id: "bbqusdc-steakhouse-v2", assetId: "usdc-circle", symbol: "USDC", chain: "ethereum", address: "0xbeeff2c5bf38f90e3482a8b19f12e5a6d2fca757" },
    { id: "skymoneyusdsflagship-sky", assetId: "usds-sky", symbol: "USDS", chain: "ethereum", address: "0xe15fcc81118895b67b6647bbd393182df44e11e0" },
    { id: "arcusdc-galaxy", assetId: "usdc-circle", symbol: "USDC", chain: "arc", address: "0x8e357432cc12ff425c36432f312968aeb16112af" },
    { id: "gtusdtp-gauntlet", assetId: "usdt-tether", symbol: "USDT", chain: "ethereum", address: "0xf3557ad5e984211ac8a0874a670344f2c3376471" },
    { id: "sxsrlusd-sentora", assetId: "rlusd-ripple", symbol: "RLUSD", chain: "ethereum", address: "0xfc8c624b6080a0a780583799f2a862de936f6e22" },
    { id: "ethenausdc-steakhouse", assetId: "usdc-circle", symbol: "USDC", chain: "base", address: "0xbeeff0be997cca5b1c13a7433c2004637975739e" },
    { id: "armusdcs-wintermute", assetId: "usdc-circle", symbol: "USDC", chain: "ethereum", address: "0xa2eaad0d586cf9fd73bb2c09cf6a7e3e187d68cd" },
    { id: "kpkusdcyield-kpk", assetId: "usdc-circle", symbol: "USDC", chain: "ethereum", address: "0xd5cce260e7a755ddf0fb9cdf06443d593aaeaa13" },
  ],
  (row) => {
    const { assetId, symbol, chain, address } = row;
    const config = erc4626InstantConfig({
      symbol,
      reviewedAt: REVIEWED_AT,
      outputAssets: [assetId],
      feeDescription: `The reviewed Morpho Vault V2 ordinary exit burns shares and transfers ${symbol} without a separate withdrawal fee; yield fees affect NAV, while gas, rounding and emergency force-deallocation penalties are separate.`,
      routeExitCorrelation: "same-protocol-liquidity",
      docs: [
        sourceRef("Exact Morpho vault", `https://app.morpho.org/${chain}/vault/${address}`, ["route", "capacity", "access"]),
        sourceRefFull("Morpho Vault V2 source", MORPHO_V2_SOURCE),
        sourceRef("Morpho Vault V2 withdrawal mechanics", MORPHO_V2_DOCS, ["route", "access", "settlement", "fees"]),
      ],
      notes: [
        "The native holder or allowance-authorized spender can withdraw when local exit gates and underlying-token controls permit. Deposit whitelists and interface jurisdiction restrictions are separate from the direct holder route.",
        "Capacity requires current ordinary executable underlying liquidity: idle assets plus the selected liquidity adapter only, without adding overlapping force-deallocatable or in-kind positions. Vault V2 maxWithdraw/maxRedeem intentionally return zero and are not capacity probes.",
        "No reserve-sync adapter for this exact vault is currently configured. Missing or stale direct telemetry leaves capacity unrated; no 5% precedent buffer, recorded API observation, or full-supply fallback is used.",
      ],
    });
    return "capacityUnmeasured" in row && row.capacityUnmeasured ? unmeasuredCapacityConfig(config) : config;
  },
);

export const DISCOVERY_STABLECOIN_REDEEM_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  ...morphoVaultRoutes,
  "sparkusdc-spark": unmeasuredCapacityConfig(erc4626InstantConfig({
    symbol: "USDC",
    outputAssets: ["usdc-circle"],
    reviewedAt: REVIEWED_AT,
    feeDescription: "The reviewed MetaMorpho ordinary withdraw/redeem returns USDC without a separate withdrawal fee; performance fees accrue through share accounting, and gas and rounding remain additional.",
    routeExitCorrelation: "same-protocol-liquidity",
    docs: [
      sourceRefFull("Exact Spark USDC MetaMorpho source", "https://base.blockscout.com/api/v2/smart-contracts/0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a"),
      sourceRef("Morpho vault withdrawal mechanics", "https://docs.morpho.org/curate/tutorials-v1/vault-creation/", ["route", "capacity", "settlement"]),
    ],
    notes: ["Current capacity must measure idle USDC plus executable lender withdrawals, not supplied notional. No exact-vault reserve-sync adapter or static capacity fallback is configured; missing telemetry leaves this route unrated."],
  })),
  "sfrax-frax": erc4626InstantConfig({
    symbol: "FRAX",
    outputAssets: ["frax-frax"],
    reviewedAt: REVIEWED_AT,
    feeDescription: "The native sFRAX ERC-4626 redemption implementation has no separate redemption fee; gas and base-unit rounding apply.",
    docs: [
      sourceRefFull("Frax sFRAX staking and redemption", "https://docs.frax.finance/frax-v3-100-cr-and-more/sfrax"),
      sourceRefFull("Verified StakedFrax source", "https://eth.blockscout.com/api/v2/smart-contracts/0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32"),
    ],
    notes: ["Atomic native-share redemption pays FRAX, not dollars. Ethereum block 26108096 reverified asset(), totalAssets() and previewRedeem(1e18). Capacity still requires fresh available underlying telemetry; no adapter or full-supply fallback is configured."],
  }),
  "sreusd-resupply": erc4626InstantConfig({
    symbol: "reUSD",
    outputAssets: ["reusd-resupply"],
    reviewedAt: REVIEWED_AT,
    feeDescription: "Resupply savings terms and the reviewed ERC-4626 implementation impose no local withdrawal penalty or fee; gas, rounding and any downstream reUSD exit charges are separate.",
    docs: [
      sourceRefFull("Resupply savings reUSD", "https://docs.resupply.finance/resupply-protocol/savings-reusd.md"),
      sourceRefFull("Verified sreUSD implementation", "https://eth.blockscout.com/api/v2/smart-contracts/0x557ab1e003951a73c12d16f0fea8490e39c33c35"),
    ],
    notes: ["This permissionless native unwrap returns reUSD only. Ethereum block 26108096 reverified vault identity and conversion; absent exact-vault direct telemetry leaves capacity unrated, without inferring downstream dollars or full-supply liquidity."],
  }),
  "sdai-gnosis": erc4626InstantConfig({
    symbol: "WXDAI",
    outputAssets: ["xdai-gnosis"],
    reviewedAt: REVIEWED_AT,
    feeDescription: "The reviewed SavingsXDai standard ERC-4626 withdrawal has no local fee hook; gas and integer rounding apply.",
    docs: [
      sourceRefFull("Verified Gnosis SavingsXDai source", "https://gnosis.blockscout.com/api/v2/smart-contracts/0xaf204776c7245bf4147c2612bf6e5972ee483701"),
      sourceRef("Gnosis xDAI bridge infrastructure", "https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge", ["route"]),
    ],
    notes: ["Gnosis block 48558321 reverified asset() as WXDAI and the live share conversion. The output identity is tracked xDAI, not Ethereum DAI. Native wrapper exit does not certify bridge settlement or fiat exit; missing direct telemetry remains unrated with no fallback."],
  }),
  "susdf-falcon": erc4626InstantConfig({
    symbol: "USDf",
    outputAssets: ["usdf-falcon"],
    accessModel: "whitelisted-onchain",
    reviewedAt: REVIEWED_AT,
    feeDescription: "The reviewed native ERC-4626 redeem deducts no local protocol fee; gas and rounding remain additional. Falcon account/platform charges and the parent USDf redemption are distinct.",
    docs: [
      sourceRefFull("Falcon sUSDf savings", "https://docs.falcon.finance/earn/susdf-yield-bearing-token.md"),
      sourceRefFull("Verified current sUSDf implementation", "https://eth.blockscout.com/api/v2/smart-contracts/0x0d132bee412e6619a4863aeedad97541bfda3f34"),
      sourceRef("Falcon account and eligibility terms", "https://docs.falcon.finance/resources/terms-of-use.md", ["access"]),
    ],
    notes: ["Restricted accounts cannot withdraw; Falcon platform use additionally requires approved account eligibility. Native unwrap returns USDf atomically and does not inherit the parent's redemption cooldown. Ethereum block 26108096 reverified identity/conversion, not stressed capacity; no exact-vault adapter or fallback is configured."],
  }),
  "susdc-spark-v1": unmeasuredCapacityConfig(defineStablecoinRedeemConfig({
    executionModel: "rules-based-nav",
    outputAssets: ["usdc-circle", "susds-sky"],
    outputAssetType: "stable-basket",
    costModel: undisclosedReviewedFee("Legacy V1 USDC redemption uses governance-variable PSM tin/tout; zero values at the research pin do not establish a permanent zero-fee bound. The in-kind sUSDS branch is separate."),
    reviewedAt: REVIEWED_AT,
    docs: [
      sourceRefFull("Spark Savings Legacy V1 and V2", "https://docs.spark.finance/products/spark-savings"),
      sourceRefFull("Verified Legacy UsdcVault implementation", "https://eth.blockscout.com/api/v2/smart-contracts/0xf943cb8d5f06f2bbf352878ebef3ec5c537a20ba"),
    ],
    notes: ["Ethereum block 26108096 reverified USDC asset and share conversion. USDC capacity requires the live PSM pocket; direct sUSDS shares are a different in-kind exit and must not be added to the same pocket. The output set records holder choices, not an equal-weight portfolio. No exact-vault capacity/fee telemetry or static fallback is configured."],
  })),
  "usdr-rise": unmeasuredCapacityConfig(defineStablecoinRedeemConfig({
    outputAssets: ["wm-m0"],
    costModel: fixedFee(0, "The reviewed atomic M0 SwapFacility conversion has no separate percentage charge; gas and wM conversion rounding are additional. Solver and fiat fees are not modeled."),
    reviewedAt: REVIEWED_AT,
    docs: [
      sourceRefFull("RISE Dollar holder conversion", "https://docs.risechain.com/docs/rise-evm/usdr"),
      sourceRefFull("M0 platform deployments", "https://docs.m0.org/resources/addresses/m0-platform"),
      sourceRef("Verified RISE extension implementation", "https://explorer.risechain.com/api/v2/smart-contracts/0xf9733d0bf530b02929ab81cf78e7d0befd3a2d7b", ["route", "access", "fees"]),
    ],
    notes: ["Only the same-chain child-to-wM route is modeled. Non-frozen holder, allowance, approved non-permissioned extensions and an unpaused SwapFacility are required; direct M remains approved-swapper-only. Local M backing is not executable wM output or cash capacity. No exact-route telemetry or fallback is configured."],
  })),
  "mantrausd-mantra": unmeasuredCapacityConfig(defineStablecoinRedeemConfig({
    outputAssets: ["wm-m0"],
    costModel: fixedFee(0, "The reviewed atomic M0 SwapFacility conversion has no separate percentage charge; gas and wM conversion rounding are additional. Solver and fiat fees are not modeled."),
    reviewedAt: REVIEWED_AT,
    docs: [
      sourceRefFull("Mantra USD", "https://mantrausd.com/"),
      sourceRefFull("M0 platform deployments", "https://docs.m0.org/resources/addresses/m0-platform"),
      sourceRef("Verified Mantra extension implementation", "https://blockscout.mantrascan.io/api/v2/smart-contracts/0x9d7a7b406568668e7943740f5b370c86e13dcca8", ["route", "access", "fees"]),
    ],
    notes: ["Only the same-chain child-to-wM route is modeled. Non-frozen holder, allowance, approved non-permissioned extensions and an unpaused SwapFacility are required; direct M remains approved-swapper-only. Local M backing is not executable wM output or cash capacity. No exact-route telemetry or fallback is configured."],
  })),
  "usdfr-forest-road": unmeasuredCapacityConfig(defineStablecoinRedeemConfig({
    accessModel: "whitelisted-onchain",
    executionModel: "rules-based-nav",
    outputAssets: ["usdc-circle"],
    costModel: undisclosedReviewedFee("Forest Road does not disclose a fixed direct USDfr redemption fee in the reviewed how-to; six-decimal output rounding retains the submicro USDfr remainder rather than implying a fee. Gas varies."),
    reviewedAt: REVIEWED_AT,
    docs: [
      sourceRefFull("Forest Road direct USDfr redemption", "https://forestroadvault.com/docs/how-to"),
      sourceRef("Forest Road deployment addresses", "https://forestroadvault.com/docs/addresses", ["route", "capacity"]),
      sourceRef("Forest Road governance and pauses", "https://forestroadvault.com/docs/roles-and-governance", ["access"]),
    ],
    notes: ["Eligible KYC-verified, nonblocked Ethereum holders redeem USDfr to USDC atomically while fully backed and unpaused, bounded by idle USDC in reserve 0x8317736611b542ddb4a820fe344b621a904bdd48 via controller 0x50ac018eb6400f247ffe0fa7f1d4e0e900cdb47c. The sUSDfr 21-day queue and its 1 USDfr minimum do not apply. The prior measured idle USDC snapshot is not a static capacity fallback; no exact-route telemetry adapter is configured."],
  })),
};
