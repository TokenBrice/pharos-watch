import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  decimalNumberFromBigInt,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  notApplicableFreshnessMetadata,
  reserveDegradedWarning,
  requireOnchainInput,
  slicesFromValues,
} from "./helpers";

const ADAPTER_KEY = "cap-vault";
const ASSETS_SELECTOR = "0x71a97305";
const TOTAL_SUPPLIES_SELECTOR = "0x9782e821";
const TOTAL_BORROWS_SELECTOR = "0x8d730124";
const AVAILABLE_BALANCE_SELECTOR = "0xa0821be3";
const PAUSED_SELECTOR = "0x2e48152c";

interface CapVaultAssetConfig {
  address: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

interface CapVaultAssetState {
  address: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  decimals: number;
  totalSupplied: number;
  totalBorrowed: number;
  available: number;
  paused: boolean;
}

function encodeAddressArg(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function decodeBool(raw: string | null): boolean | null {
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  return BigInt(raw) !== 0n;
}

function decodeAddressArray(raw: string | null): string[] {
  if (!raw?.startsWith("0x")) return [];
  const stripped = raw.slice(2);
  if (stripped.length < 128 || stripped.length % 64 !== 0) return [];
  const words: string[] = [];
  for (let index = 0; index < stripped.length; index += 64) {
    words.push(stripped.slice(index, index + 64));
  }
  const offset = Number(BigInt(`0x${words[0]}`) / 32n);
  if (!Number.isInteger(offset) || offset < 0 || offset >= words.length) return [];
  const length = Number(BigInt(`0x${words[offset]}`));
  if (!Number.isInteger(length) || length < 0 || offset + 1 + length > words.length) return [];
  return words.slice(offset + 1, offset + 1 + length).flatMap((word) => {
    const address = parseEvmAddressResult(`0x${word}` as `0x${string}`);
    return address ? [address] : [];
  });
}

function normalizeAssetConfigs(config: LiveReservesConfig): Map<string, CapVaultAssetConfig> {
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  return new Map(
    (params.assets ?? []).map((asset) => [
      asset.address.toLowerCase(),
      {
        address: asset.address.toLowerCase(),
        name: asset.name,
        risk: asset.risk,
        ...(asset.coinId ? { coinId: asset.coinId } : {}),
        ...(asset.depType ? { depType: asset.depType } : {}),
      },
    ]),
  );
}

function resolveAssetConfig(address: string, configs: Map<string, CapVaultAssetConfig>): CapVaultAssetConfig {
  return configs.get(address.toLowerCase()) ?? {
    address: address.toLowerCase(),
    name: `Cap asset ${address.slice(0, 6)}...${address.slice(-4)}`,
    risk: "medium",
  };
}

export function adaptCapVaultState(args: {
  assets: CapVaultAssetState[];
  supplyUsd: number | null;
  contractAddress: string;
}): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const activeAssets = args.assets.filter((asset) => asset.totalSupplied > 0);
  const totalReserveUsd = activeAssets.reduce((sum, asset) => sum + asset.totalSupplied, 0);
  const immediateRedeemableUsd = activeAssets.reduce(
    (sum, asset) => sum + (asset.paused ? 0 : Math.max(0, asset.available)),
    0,
  );
  const pausedAssets = activeAssets.filter((asset) => asset.paused);
  for (const asset of pausedAssets) {
    warnings.push(reserveDegradedWarning(
      "cap-asset-paused",
      `Cap vault asset "${asset.name}" is paused and excluded from immediate redeemable capacity`,
    ));
  }

  return {
    slices: slicesFromValues(activeAssets.map((asset) => ({
      name: asset.name,
      value: asset.totalSupplied,
      risk: asset.risk,
      ...(asset.coinId ? { coinId: asset.coinId } : {}),
      ...(asset.depType ? { depType: asset.depType } : {}),
    }))),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "cap-vault-onchain" }),
      contractAddress: args.contractAddress,
      assetCount: activeAssets.length,
      pausedAssetCount: pausedAssets.length,
      totalReserveUsd,
      ...(args.supplyUsd != null ? { supplyUsd: args.supplyUsd } : {}),
      immediateRedeemableUsd,
      ...(args.supplyUsd != null && args.supplyUsd > 0
        ? { immediateRedeemableRatio: immediateRedeemableUsd / args.supplyUsd }
        : {}),
      assets: activeAssets.map((asset) => ({
        address: asset.address,
        name: asset.name,
        totalSupplied: asset.totalSupplied,
        totalBorrowed: asset.totalBorrowed,
        available: asset.available,
        paused: asset.paused,
      })),
      redemption: {
        capacityUsd: immediateRedeemableUsd,
        ...(args.supplyUsd != null && args.supplyUsd > 0
          ? { capacityRatioOfSupply: immediateRedeemableUsd / args.supplyUsd }
          : {}),
        capacityKind: "live-direct-bounded" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus: immediateRedeemableUsd > 0 && pausedAssets.length === 0
          ? "open" as const
          : immediateRedeemableUsd > 0
            ? "degraded" as const
            : "paused" as const,
        holderEligibility: "any-holder",
        sourceUrls: ["https://docs.cap.app/concepts/vault"],
      },
    },
  };
}

export async function fetchCapVaultReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const contractAddress = resolveCoinContractAddress(coin, input.chain);
  if (!contractAddress) {
    throw new Error(`${ADAPTER_KEY} could not find a ${input.chain} contract for ${coin.id}`);
  }

  const assetConfigs = normalizeAssetConfigs(config);
  const assetsRaw = await fetchOnchainRawCall({
    contract: contractAddress,
    data: ASSETS_SELECTOR,
    signal,
    ctx,
    rpcMode: input.rpcMode,
    chain: input.chain,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  const assetAddresses = decodeAddressArray(assetsRaw);
  if (assetAddresses.length === 0) {
    throw new Error(`${ADAPTER_KEY} assets() returned no assets for ${coin.id}`);
  }

  const tokenSupplyRaw = await fetchOnchainUint256({
    contract: contractAddress,
    data: TOTAL_SUPPLY_SELECTOR,
    signal,
    ctx,
    rpcMode: input.rpcMode,
    chain: input.chain,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  const supplyUsd = tokenSupplyRaw != null ? decimalNumberFromBigInt(tokenSupplyRaw, 18) : null;

  const assetStates = await Promise.all(assetAddresses.map(async (address) => {
    const encodedAddress = encodeAddressArg(address);
    const [decimalsRaw, totalSuppliesRaw, totalBorrowsRaw, availableRaw, pausedRaw] = await Promise.all([
      fetchOnchainUint256({
        contract: address,
        data: DECIMALS_SELECTOR,
        signal,
        ctx,
        rpcMode: input.rpcMode,
        chain: input.chain,
        rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl,
      }),
      fetchOnchainUint256({
        contract: contractAddress,
        data: `${TOTAL_SUPPLIES_SELECTOR}${encodedAddress}`,
        signal,
        ctx,
        rpcMode: input.rpcMode,
        chain: input.chain,
        rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl,
      }),
      fetchOnchainUint256({
        contract: contractAddress,
        data: `${TOTAL_BORROWS_SELECTOR}${encodedAddress}`,
        signal,
        ctx,
        rpcMode: input.rpcMode,
        chain: input.chain,
        rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl,
      }),
      fetchOnchainUint256({
        contract: contractAddress,
        data: `${AVAILABLE_BALANCE_SELECTOR}${encodedAddress}`,
        signal,
        ctx,
        rpcMode: input.rpcMode,
        chain: input.chain,
        rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl,
      }),
      fetchOnchainRawCall({
        contract: contractAddress,
        data: `${PAUSED_SELECTOR}${encodedAddress}`,
        signal,
        ctx,
        rpcMode: input.rpcMode,
        chain: input.chain,
        rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl,
      }),
    ]);
    const decimals = decimalsRaw != null ? Number(decimalsRaw) : 18;
    const assetConfig = resolveAssetConfig(address, assetConfigs);
    return {
      address,
      name: assetConfig.name,
      risk: assetConfig.risk,
      ...(assetConfig.coinId ? { coinId: assetConfig.coinId } : {}),
      ...(assetConfig.depType ? { depType: assetConfig.depType } : {}),
      decimals,
      totalSupplied: totalSuppliesRaw != null ? decimalNumberFromBigInt(totalSuppliesRaw, decimals) : 0,
      totalBorrowed: totalBorrowsRaw != null ? decimalNumberFromBigInt(totalBorrowsRaw, decimals) : 0,
      available: availableRaw != null ? decimalNumberFromBigInt(availableRaw, decimals) : 0,
      paused: decodeBool(pausedRaw) ?? false,
    } satisfies CapVaultAssetState;
  }));

  return adaptCapVaultState({
    assets: assetStates,
    supplyUsd,
    contractAddress,
  });
}
