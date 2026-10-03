import { defineConfigFamily } from "../factory";
import type { RedemptionBackstopConfig } from "../shared";
import {
  sourceRef,
  sourceRefFull,
} from "../shared";
import { erc4626InstantConfig } from "./shared";

const REVIEWED_AT = "2026-10-03";
const MORPHO_V2_SOURCE = "https://raw.githubusercontent.com/morpho-org/vault-v2/c034336f82b0415f786fa15fc61fa81bf5256e31/src/VaultV2.sol";
const MORPHO_V2_DOCS = "https://docs.morpho.org/learn/concepts/vault-v2/";

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
    { id: "sparkusdtbc-spark", assetId: "usdt-tether", symbol: "USDT", chain: "ethereum", address: "0xb0c424116172b55cbb6dd3136f5989f7959e5b91" },
  ],
  (row) => {
    const { assetId, symbol, chain, address } = row;
    return erc4626InstantConfig({
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
        "The native holder or allowance-authorized spender can withdraw when receiveShares, sendShares and receiveAssets gates and underlying-token controls permit. The sendAssets gate governs deposits, not withdrawals; interface jurisdiction restrictions are separate from the direct holder route.",
        "Capacity requires current ordinary executable underlying liquidity: idle assets plus the selected liquidity adapter only, without adding overlapping force-deallocatable or in-kind positions. Vault V2 maxWithdraw/maxRedeem intentionally return zero and are not capacity probes.",
        "The configured erc4626-single-asset adapter checks liquidityAdapter() on the exact vault in this run before using morpho-vault-v2 API liquidity. A zero or unreadable adapter bounds capacity to independently observed idle underlying; unreadable idle, stale or rejected telemetry leaves capacity unrated. No static buffer, recorded API observation or full-supply fallback is used.",
      ],
    });
  },
);

export const DISCOVERY_STABLECOIN_REDEEM_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  ...morphoVaultRoutes,
  "sparkusdc-spark": erc4626InstantConfig({
    symbol: "USDC",
    outputAssets: ["usdc-circle"],
    reviewedAt: REVIEWED_AT,
    routeExitCorrelation: "same-protocol-liquidity",
    feeDescription: "The Base MetaMorpho ordinary ERC-4626 withdrawal returns USDC without a separate withdrawal fee; performance fees affect NAV, while gas and rounding remain additional.",
    docs: [
      sourceRefFull("Exact Base MetaMorpho vault", "https://base.blockscout.com/api/v2/smart-contracts/0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a"),
      sourceRefFull("Morpho V1 vault mechanics", "https://docs.morpho.org/curate/tutorials-v1/vault-creation/"),
    ],
    notes: ["The configured erc4626-single-asset morpho-vault-v1 reader measures current exact-vault idle USDC plus ordinary executable lender liquidity. Fresh admitted reserve-sync telemetry supplies capacity; missing, stale or rejected observations remain unrated, without a static full-supply fallback."],
  }),
  "sfrax-frax": erc4626InstantConfig({
    symbol: "FRAX",
    outputAssets: ["frax-frax"],
    reviewedAt: REVIEWED_AT,
    feeDescription: "The native sFRAX ERC-4626 redemption implementation has no separate redemption fee; gas and base-unit rounding apply.",
    docs: [
      sourceRefFull("Frax sFRAX staking and redemption", "https://docs.frax.finance/frax-v3-100-cr-and-more/sfrax"),
      sourceRefFull("Verified StakedFrax source", "https://eth.blockscout.com/api/v2/smart-contracts/0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32"),
    ],
    notes: ["Atomic native-share redemption pays FRAX, not dollars. The configured erc4626-single-asset adapter measures idle FRAX and clamps capacity to current convertible share backing, excluding surplus undistributed rewards. Missing or stale telemetry leaves capacity unrated; no full-supply fallback is configured."],
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
    notes: ["This permissionless native unwrap returns reUSD only. The configured erc4626-single-asset adapter reads REUSD.balanceOf(vault) as idle underlying capacity and clamps it to convertible share backing. Fresh reserve-sync metadata supplies the capacity bound; missing or stale evidence leaves it unrated, without inferring downstream dollars or a static full-supply guarantee."],
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
    notes: ["The configured erc4626-single-asset adapter uses the reviewed atomic-full-backing source for native WXDAI redemption. The output identity is tracked xDAI, not Ethereum DAI. Native wrapper exit does not certify bridge settlement or fiat exit; missing or stale direct telemetry leaves capacity unrated, with no static fallback."],
  }),
  "susdf-falcon": erc4626InstantConfig({
    symbol: "USDf",
    outputAssets: ["usdf-falcon"],
    accessModel: "permissionless-onchain",
    reviewedAt: REVIEWED_AT,
    feeDescription: "The reviewed native ERC-4626 redeem deducts no local protocol fee; gas and rounding remain additional. Falcon account/platform charges and the parent USDf redemption are distinct.",
    docs: [
      sourceRefFull("Falcon sUSDf savings", "https://docs.falcon.finance/earn/susdf-yield-bearing-token.md"),
      sourceRefFull("Verified current sUSDf implementation", "https://eth.blockscout.com/api/v2/smart-contracts/0x0d132bee412e6619a4863aeedad97541bfda3f34"),
      sourceRef("Falcon account and eligibility terms", "https://docs.falcon.finance/resources/terms-of-use.md", ["access"]),
    ],
    notes: ["The native unwrap is permissionless for unrestricted holders; the implementation checks caller, receiver and owner against its administrator-controlled restriction list, with no positive allowlist. Falcon's off-chain USDf account eligibility is a separate rail. The configured erc4626-single-asset adapter measures idle USDf, bounded by convertible share backing; current local cooldown settings and gas/rounding govern execution, without importing the parent's issuer-redemption terms or a static fallback."],
  }),
};
