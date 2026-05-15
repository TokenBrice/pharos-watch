import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { fetchEvmCallHexAtBlock } from "../evm-rpc";
import { getArchiveFallbackRpcUrls } from "../public-rpc-registry";
import {
  buildParentDerivedLiveOverride,
  decodeUint256WordBigInt,
  encodeUint256,
  ERC4626_NAV_MAX_RATIO,
  ERC4626_NAV_MIN_RATIO,
  ETHEREUM_CHAIN,
  PROTOCOL_REDEEM_SOURCE,
  ratioToNumber,
  resolveTrustedOverrideParent,
  USDC_CIRCLE_ID,
  type CurrentPriceOverride,
  type Erc4626NavVaultConfig,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const ERC4626_CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a"; // convertToAssets(uint256)

const USDT_TETHER_ID = "usdt-tether";
const USDE_ETHENA_ID = "usde-ethena";
const AVUSD_AVANT_ID = "avusd-avant";
const GHO_AAVE_ID = "gho-aave";
const USN_NOON_ID = "usn-noon";
const YZUSD_YUZU_ID = "yzusd-yuzu";

// ERC-4626 vaults that should be priced from `convertToAssets(1 share)` * parent.price.
// Each entry must have a single tracked parent that already prices through normal consensus.
const ERC4626_NAV_VAULTS: readonly Erc4626NavVaultConfig[] = [
  {
    id: "susdt-spark",
    parentId: USDT_TETHER_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xe2e7a17dff93280dec073c995595155283e3c372",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "susdc-spark",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "steakusdt-steakhouse",
    parentId: USDT_TETHER_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "steakusdc-steakhouse",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbeef088055857739c12cd3765f20b7679def0f51",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "srusde-strata",
    parentId: USDE_ETHENA_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "gtusdc-gauntlet",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xdd0f28e19c1780eb6396170735d45153d261490d",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "gtusdcp-gauntlet",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x8c106eedad96553e64287a5a6839c3cc78afa3d0",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "yvusdc-yearn",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbe53a109b494e5c9f97b9cd39fe969be68bf6204",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "savusd-avant",
    parentId: AVUSD_AVANT_ID,
    chain: "avalanche",
    vault: "0x06d47f3fb376649c3a9dafe069b3d6e35572219e",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "susn-noon",
    parentId: USN_NOON_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xe24a3dc889621612422a64e6388927901608b91d",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "syzusd-yuzu",
    parentId: YZUSD_YUZU_ID,
    chain: "plasma",
    vault: "0xc8a8df9b210243c55d31c73090f06787ad0a1bf6",
    vaultDecimals: 18,
    assetDecimals: 18,
    rpcUrls: ["https://rpc.plasma.to"],
  },
  {
    id: "stkgho-umbrella-aave",
    parentId: GHO_AAVE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x4f827a63755855cdf3e8f3bcd20265c833f15033",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "sbold-k3-capital",
    parentId: "bold-liquity",
    chain: ETHEREUM_CHAIN,
    vault: "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "ybold-yearn",
    parentId: "bold-liquity",
    chain: ETHEREUM_CHAIN,
    vault: "0x9f4330700a36b29952869fac9b33f45eedd8a3d8",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
];

const ERC4626_NAV_VAULTS_BY_ID = new Map<string, Erc4626NavVaultConfig>(
  ERC4626_NAV_VAULTS.map((entry) => [entry.id, entry]),
);

async function fetchErc4626AssetsPerShare(
  config: Erc4626NavVaultConfig,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const oneShareRaw = 10n ** BigInt(config.vaultDecimals);
  const calldata = `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(oneShareRaw)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(config.chain, config.vault, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: [...(config.rpcUrls ?? getArchiveFallbackRpcUrls(config.chain))],
  });
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] ${config.id}: convertToAssets() returned null`);
    return null;
  }
  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] ${config.id}: convertToAssets() returned zero or invalid output`);
    return null;
  }
  const assetsPerShare = ratioToNumber(outputAmount, config.assetDecimals, oneShareRaw, config.vaultDecimals);
  if (!Number.isFinite(assetsPerShare) || assetsPerShare <= 0) return null;
  if (assetsPerShare < ERC4626_NAV_MIN_RATIO || assetsPerShare > ERC4626_NAV_MAX_RATIO) {
    console.warn(
      `[authoritative-price-sources] ${config.id}: convertToAssets() ratio ${assetsPerShare} outside trusted bounds`,
    );
    return null;
  }
  return assetsPerShare;
}

export const erc4626NavProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return ERC4626_NAV_VAULTS_BY_ID.has(stablecoinId);
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const config = ERC4626_NAV_VAULTS_BY_ID.get(asset.id);
    if (!config) return null;

    const parent = resolveTrustedOverrideParent(
      context,
      config.parentId,
      () =>
        `[authoritative-price-sources] ${asset.id}: skipped ERC-4626 NAV price because parent ${config.parentId} provenance is not trusted`,
    );
    if (!parent) return null;

    const assetsPerShare = await fetchErc4626AssetsPerShare(config, "latest", signal);
    if (assetsPerShare == null) return null;

    return buildParentDerivedLiveOverride(parent, assetsPerShare);
  },
};
