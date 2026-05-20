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
  type CurrentPriceOverride,
  type Erc4626NavVaultConfig,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const PREVIEW_REDEEM_SELECTOR = "0x4cdad506"; // previewRedeem(uint256)

const GHO_AAVE_ID = "gho-aave";

const PREVIEW_REDEEM_VAULTS: readonly Erc4626NavVaultConfig[] = [
  {
    id: "sgho-aave",
    parentId: GHO_AAVE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x1a88df1cfe15af22b3c4c783d4e6f7f9e0c1885d",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
];

const PREVIEW_REDEEM_VAULTS_BY_ID = new Map<string, Erc4626NavVaultConfig>(
  PREVIEW_REDEEM_VAULTS.map((entry) => [entry.id, entry]),
);

async function fetchPreviewRedeemAssetsPerShare(
  config: Erc4626NavVaultConfig,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const oneShareRaw = 10n ** BigInt(config.vaultDecimals);
  const calldata = `${PREVIEW_REDEEM_SELECTOR}${encodeUint256(oneShareRaw)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(config.chain, config.vault, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: [...(config.rpcUrls ?? getArchiveFallbackRpcUrls(config.chain))],
  });
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] ${config.id}: previewRedeem() returned null`);
    return null;
  }
  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] ${config.id}: previewRedeem() returned zero or invalid output`);
    return null;
  }
  const assetsPerShare = ratioToNumber(outputAmount, config.assetDecimals, oneShareRaw, config.vaultDecimals);
  if (!Number.isFinite(assetsPerShare) || assetsPerShare <= 0) return null;
  if (assetsPerShare < ERC4626_NAV_MIN_RATIO || assetsPerShare > ERC4626_NAV_MAX_RATIO) {
    console.warn(
      `[authoritative-price-sources] ${config.id}: previewRedeem() ratio ${assetsPerShare} outside trusted bounds`,
    );
    return null;
  }
  return assetsPerShare;
}

export const previewRedeemProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return PREVIEW_REDEEM_VAULTS_BY_ID.has(stablecoinId);
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const config = PREVIEW_REDEEM_VAULTS_BY_ID.get(asset.id);
    if (!config) return null;

    const parent = resolveTrustedOverrideParent(
      context,
      config.parentId,
      () =>
        `[authoritative-price-sources] ${asset.id}: skipped previewRedeem price because parent ${config.parentId} provenance is not trusted`,
    );
    if (!parent) return null;

    const assetsPerShare = await fetchPreviewRedeemAssetsPerShare(config, "latest", signal);
    if (assetsPerShare == null) return null;

    return buildParentDerivedLiveOverride(parent, assetsPerShare);
  },
};
