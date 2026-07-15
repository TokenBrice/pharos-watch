import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import {
  buildParentDerivedLiveOverride,
  defineRegistryErc4626NavVault,
  ETHEREUM_CHAIN,
  fetchVaultAssetsPerShareViaSelector,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  type CurrentPriceOverride,
  type Erc4626NavVaultConfig,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const PREVIEW_REDEEM_SELECTOR = "0x4cdad506"; // previewRedeem(uint256)

const GHO_AAVE_ID = "gho-aave";

const PREVIEW_REDEEM_VAULTS: readonly Erc4626NavVaultConfig[] = [
  defineRegistryErc4626NavVault({
    id: "sgho-aave",
    parentId: GHO_AAVE_ID,
    chain: ETHEREUM_CHAIN,
  }),
];

const PREVIEW_REDEEM_VAULTS_BY_ID = new Map<string, Erc4626NavVaultConfig>(
  PREVIEW_REDEEM_VAULTS.map((entry) => [entry.id, entry]),
);

async function fetchPreviewRedeemAssetsPerShare(
  config: Erc4626NavVaultConfig,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  return fetchVaultAssetsPerShareViaSelector(
    config,
    PREVIEW_REDEEM_SELECTOR,
    "previewRedeem",
    blockNumberOrTag,
    signal,
    blockNumberOrTag === "latest" ? { throwOnNullQuote: true } : undefined,
  );
}

export const previewRedeemProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveCircuitSource: CIRCUIT_SOURCE.PROTOCOL_REDEEM,
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
