import type {
  LiveReserveWarning,
  LiveReservesConfig,
  ReserveRisk,
  ReserveSlice,
  StablecoinMeta,
} from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchEvmCallHex,
  parseEvmAddressResult,
  resolveCoinContractAddress,
} from "./evm";
import { getAdapterTimeout, isOnchainEvmInput, isReserveRisk, reserveDegradedWarning } from "./helpers";

const ERC4626_TOTAL_ASSETS_SELECTOR = "0x01e1d114";
const ERC4626_ASSET_SELECTOR = "0x38d52e0f";

interface SingleAssetSliceConfig {
  name: string;
  risk: ReserveRisk;
  coinId?: string;
  depType?: ReserveSlice["depType"];
  expectedAssetAddress?: string;
}

function parseSliceConfig(config: LiveReservesConfig): SingleAssetSliceConfig {
  const slice = config.params?.slice;
  if (!slice || typeof slice !== "object") {
    throw new Error("erc4626-single-asset adapter requires params.slice");
  }

  const name = "name" in slice && typeof slice.name === "string"
    ? slice.name.trim()
    : "";
  const risk = "risk" in slice ? slice.risk : undefined;

  if (!name || !isReserveRisk(risk)) {
    throw new Error("erc4626-single-asset params.slice must include a valid name and risk");
  }

  return {
    name,
    risk,
    ...("coinId" in slice && typeof slice.coinId === "string" ? { coinId: slice.coinId } : {}),
    ...("depType" in slice && typeof slice.depType === "string" ? { depType: slice.depType as ReserveSlice["depType"] } : {}),
    ...("expectedAssetAddress" in slice && typeof slice.expectedAssetAddress === "string"
      ? { expectedAssetAddress: slice.expectedAssetAddress.toLowerCase() }
      : {}),
  };
}

export async function fetchErc4626SingleAssetReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = config.inputs.primary;
  if (!isOnchainEvmInput(primaryInput)) {
    throw new Error("erc4626-single-asset adapter requires an onchain-evm primary input");
  }

  const sliceConfig = parseSliceConfig(config);
  const contractAddress = resolveCoinContractAddress(coin, primaryInput.chain);
  if (!contractAddress) {
    throw new Error(`No ${primaryInput.chain} contract configured for ${coin.id}`);
  }

  const timeout = getAdapterTimeout(config, 12_000);
  const [assetResult, totalAssetsResult] = await Promise.all([
    fetchEvmCallHex(primaryInput.chain, contractAddress, ERC4626_ASSET_SELECTOR, signal, _ctx?.chainRpcs, timeout),
    fetchEvmCallHex(primaryInput.chain, contractAddress, ERC4626_TOTAL_ASSETS_SELECTOR, signal, _ctx?.chainRpcs, timeout),
  ]);

  if (!totalAssetsResult) {
    throw new Error(`ERC-4626 totalAssets() call failed for ${coin.id}`);
  }
  const totalAssetsRaw = BigInt(totalAssetsResult);
  if (totalAssetsRaw <= 0n) {
    throw new Error(`ERC-4626 totalAssets() is zero for ${coin.id}`);
  }

  const warnings: LiveReserveWarning[] = [];
  const assetAddress = assetResult ? parseEvmAddressResult(assetResult) : null;
  if (
    assetAddress
    && sliceConfig.expectedAssetAddress
    && assetAddress !== sliceConfig.expectedAssetAddress
  ) {
    warnings.push(reserveDegradedWarning(
      "asset-mismatch",
      `Vault asset() returned ${assetAddress}, expected ${sliceConfig.expectedAssetAddress}`,
    ));
  }

  return {
    slices: [
      {
        name: sliceConfig.name,
        pct: 100,
        risk: sliceConfig.risk,
        ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
        ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      freshnessMode: "not-applicable",
      chain: primaryInput.chain,
      contractAddress,
      totalAssetsRaw: totalAssetsRaw.toString(),
      ...(assetAddress ? { assetAddress } : {}),
    },
  };
}
