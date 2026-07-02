import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import {
  buildParentDerivedLiveOverride,
  encodeAddress,
  fetchBoundedVaultQuote,
  ETHEREUM_CHAIN,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  USDC_CIRCLE_ID,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const IDLE_CDO_VIRTUAL_PRICE_SELECTOR = "0x9290d427"; // virtualPrice(address)

interface IdleCdoTrancheConfig {
  id: string;
  parentId: string;
  chain: string;
  cdo: string;
  tranche: string;
  assetDecimals: number;
}

// Idle Perpetual Yield Tranches priced from `virtualPrice(address tranche)`
// on the CDO contract. The returned amount is denominated in the underlying
// asset's decimals, so the published price multiplies it by the tracked
// parent's live USD price.
const IDLE_CDO_TRANCHES: readonly IdleCdoTrancheConfig[] = [
  {
    id: "aa-falconx-mev-capital",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    cdo: "0x433d5b175148da32ffe1e1a37a939e1b7e79be4d",
    tranche: "0xc26a6fa2c37b38e549a4a1807543801db684f99c",
    assetDecimals: 6,
  },
];

const IDLE_CDO_TRANCHES_BY_ID = new Map<string, IdleCdoTrancheConfig>(
  IDLE_CDO_TRANCHES.map((entry) => [entry.id, entry]),
);

async function fetchIdleCdoTrancheAssetsPerShare(
  config: IdleCdoTrancheConfig,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
  options?: { throwOnNullQuote?: boolean },
): Promise<number | null> {
  const calldata = `${IDLE_CDO_VIRTUAL_PRICE_SELECTOR}${encodeAddress(config.tranche)}`;
  return fetchBoundedVaultQuote(
    { id: config.id, chain: config.chain, target: config.cdo },
    calldata,
    "virtualPrice",
    blockNumberOrTag,
    (outputAmount) => Number(outputAmount) / 10 ** config.assetDecimals,
    signal,
    options,
  );
}

export const idleCdoTrancheProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveCircuitSource: CIRCUIT_SOURCE.PROTOCOL_REDEEM,
  matches(stablecoinId: string): boolean {
    return IDLE_CDO_TRANCHES_BY_ID.has(stablecoinId);
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const config = IDLE_CDO_TRANCHES_BY_ID.get(asset.id);
    if (!config) return null;

    const parent = resolveTrustedOverrideParent(
      context,
      config.parentId,
      () =>
        `[authoritative-price-sources] ${asset.id}: skipped Idle CDO virtualPrice because parent ${config.parentId} provenance is not trusted`,
    );
    if (!parent) return null;

    const assetsPerShare = await fetchIdleCdoTrancheAssetsPerShare(
      config,
      "latest",
      signal,
      { throwOnNullQuote: true },
    );
    if (assetsPerShare == null) return null;

    return buildParentDerivedLiveOverride(parent, assetsPerShare);
  },
};
