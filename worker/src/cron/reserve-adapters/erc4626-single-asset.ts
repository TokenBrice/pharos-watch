import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeBalanceOfCallData,
} from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  decimalNumberFromBigInt,
  fetchJsonPostWithRetry,
  fetchOnchainUint256,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";
import {
  ERC4626_ASSET_SELECTOR,
  ERC4626_TOTAL_ASSETS_SELECTOR,
  computeErc4626CollateralizationRatio,
  makeContractRawCaller,
} from "./erc4626";
import { parseBoundedDecimals, ratioFromRaw } from "./slice-math";

interface SingleAssetSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  expectedAssetAddress?: string;
  redemptionLiquidity?: MorphoVaultRedemptionLiquidityConfig;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}

interface MorphoVaultV1RedemptionLiquidityConfig {
  source: "morpho-vault-v1";
  chainId: number;
  apiUrl?: string;
}

interface MorphoVaultV2RedemptionLiquidityConfig {
  source: "morpho-vault-v2";
  chainId: number;
  apiUrl?: string;
}

type MorphoVaultRedemptionLiquidityConfig =
  | MorphoVaultV1RedemptionLiquidityConfig
  | MorphoVaultV2RedemptionLiquidityConfig;

type MorphoVaultLiquiditySource = "morpho-vault-v1-liquidity" | "morpho-vault-v2-liquidity";

interface MorphoVaultLiquidityTelemetry {
  source: MorphoVaultLiquiditySource;
  liquidityRaw: bigint;
  liquidityUsd?: number;
  forceDeallocatableLiquidityRaw?: bigint;
  forceDeallocatableLiquidityUsd?: number;
}

interface RedemptionCapacityTelemetry {
  capacityUsd: number;
  capacityRaw: string;
  capacitySource: "erc4626-idle-underlying" | MorphoVaultLiquiditySource;
  freshnessKind: "same-run-onchain" | "same-run-api";
  routeStatusSource: "onchain" | "protocol-api";
  idleUnderlyingBalanceRaw?: string;
  underlyingDecimals: number;
  capacityRatioOfSupply?: number;
  morphoVaultV1LiquidityRaw?: string;
  morphoVaultV1LiquidityUsd?: number;
  morphoVaultV2LiquidityRaw?: string;
  morphoVaultV2LiquidityUsd?: number;
  morphoVaultV2ForceDeallocatableLiquidityRaw?: string;
  morphoVaultV2ForceDeallocatableLiquidityUsd?: number;
}

interface MorphoVaultV1LiquidityResponse {
  data?: {
    vaultByAddress?: {
      address?: unknown;
      listed?: unknown;
      asset?: {
        address?: unknown;
      } | null;
      chain?: {
        id?: unknown;
      } | null;
      liquidity?: {
        underlying?: unknown;
        usd?: unknown;
      } | null;
      warnings?: Array<{
        type?: unknown;
        level?: unknown;
      }> | null;
    } | null;
  };
  errors?: unknown;
}

interface MorphoVaultV2LiquidityResponse {
  data?: {
    vaultV2ByAddress?: {
      address?: unknown;
      listed?: unknown;
      asset?: {
        address?: unknown;
      } | null;
      chain?: {
        id?: unknown;
      } | null;
      liquidity?: unknown;
      liquidityUsd?: unknown;
      forceDeallocatableLiquidity?: unknown;
      forceDeallocatableLiquidityUsd?: unknown;
      warnings?: Array<{
        type?: unknown;
        level?: unknown;
      }> | null;
    } | null;
  };
  errors?: unknown;
}

const DEFAULT_MORPHO_GRAPHQL_URL = "https://api.morpho.org/graphql";

const MORPHO_VAULT_V1_LIQUIDITY_QUERY = `
query PharosVaultV1Liquidity($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    address
    listed
    asset {
      address
    }
    chain {
      id
    }
    liquidity {
      underlying
      usd
    }
    warnings {
      type
      level
    }
  }
}
`;

const MORPHO_VAULT_V2_LIQUIDITY_QUERY = `
query PharosVaultV2Liquidity($address: String!, $chainId: Int!) {
  vaultV2ByAddress(address: $address, chainId: $chainId) {
    address
    listed
    asset {
      address
    }
    chain {
      id
    }
    liquidity
    liquidityUsd
    forceDeallocatableLiquidity
    forceDeallocatableLiquidityUsd
    warnings {
      type
      level
    }
  }
}
`;

function parseSliceConfig(config: LiveReservesConfig): SingleAssetSliceConfig {
  const params = parseLiveReserveAdapterParams("erc4626-single-asset", config.params);
  return {
    name: params.slice.name,
    risk: params.slice.risk,
    ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
    ...(params.slice.depType ? { depType: params.slice.depType } : {}),
    ...(params.slice.expectedAssetAddress
      ? { expectedAssetAddress: params.slice.expectedAssetAddress.toLowerCase() }
      : {}),
    ...(params.redemptionLiquidity ? { redemptionLiquidity: params.redemptionLiquidity } : {}),
    ...(params.rpcUrl ? { rpcUrl: params.rpcUrl } : {}),
    ...(params.fallbackRpcUrl ? { fallbackRpcUrl: params.fallbackRpcUrl } : {}),
  };
}

function decodeErc20Decimals(raw: bigint | null): number | null {
  return raw == null ? null : parseBoundedDecimals(raw);
}

function parseMorphoAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function parseNonNegativeBigIntLike(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value >= 0n ? value : null;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed >= 0n ? parsed : null;
}

function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseMorphoChainId(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function describeMorphoWarning(value: { type?: unknown; level?: unknown }): string {
  const type = typeof value.type === "string" ? value.type : "unknown";
  const level = typeof value.level === "string" ? value.level : "unknown";
  return `${type}/${level}`;
}

async function fetchMorphoVaultV2LiquidityTelemetry(args: {
  coinId: string;
  contractAddress: string;
  assetAddress: string;
  config: MorphoVaultV2RedemptionLiquidityConfig;
  signal: AbortSignal;
  ctx?: AdapterContext;
}): Promise<{ telemetry: MorphoVaultLiquidityTelemetry | null; warnings: LiveReserveWarning[] }> {
  const apiUrl = args.config.apiUrl ?? DEFAULT_MORPHO_GRAPHQL_URL;
  try {
    const payload = await fetchJsonPostWithRetry<MorphoVaultV2LiquidityResponse>(
      apiUrl,
      {
        query: MORPHO_VAULT_V2_LIQUIDITY_QUERY,
        variables: {
          address: args.contractAddress,
          chainId: args.config.chainId,
        },
      },
      args.signal,
      12_000,
      args.ctx,
      { headers: { Accept: "application/json" } },
    );
    if (payload.errors != null) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v2-liquidity-unavailable",
            `Morpho V2 liquidity query returned GraphQL errors for ${args.coinId}`,
          ),
        ],
      };
    }

    const vault = payload.data?.vaultV2ByAddress;
    if (!vault) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v2-liquidity-unavailable",
            `Morpho V2 liquidity query returned no vault for ${args.coinId}`,
          ),
        ],
      };
    }

    const reportedVaultAddress = parseMorphoAddress(vault.address);
    if (reportedVaultAddress !== args.contractAddress.toLowerCase()) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v2-identity-mismatch",
            `Morpho V2 liquidity vault address mismatch for ${args.coinId}`,
          ),
        ],
      };
    }

    const reportedAssetAddress = parseMorphoAddress(vault.asset?.address);
    if (reportedAssetAddress !== args.assetAddress.toLowerCase()) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v2-asset-mismatch",
            `Morpho V2 liquidity asset mismatch for ${args.coinId}`,
          ),
        ],
      };
    }

    const reportedChainId = parseMorphoChainId(vault.chain?.id);
    if (reportedChainId !== args.config.chainId) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v2-chain-mismatch",
            `Morpho V2 liquidity chain mismatch for ${args.coinId}`,
          ),
        ],
      };
    }

    if (vault.listed !== true) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v2-unlisted",
            `Morpho V2 liquidity vault is not listed for ${args.coinId}`,
          ),
        ],
      };
    }

    if (vault.warnings?.length) {
      const warningList = vault.warnings.map(describeMorphoWarning).join(", ");
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v2-warning",
            `Morpho V2 liquidity vault warnings for ${args.coinId}: ${warningList}`,
          ),
        ],
      };
    }

    const liquidityRaw = parseNonNegativeBigIntLike(vault.liquidity);
    if (liquidityRaw == null) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v2-liquidity-invalid",
            `Morpho V2 liquidity payload has invalid liquidity for ${args.coinId}`,
          ),
        ],
      };
    }

    const liquidityUsd = parseOptionalNonNegativeNumber(vault.liquidityUsd);
    const forceDeallocatableLiquidityRaw = parseNonNegativeBigIntLike(vault.forceDeallocatableLiquidity);
    const forceDeallocatableLiquidityUsd = parseOptionalNonNegativeNumber(vault.forceDeallocatableLiquidityUsd);

    return {
      telemetry: {
        source: "morpho-vault-v2-liquidity",
        liquidityRaw,
        ...(liquidityUsd != null ? { liquidityUsd } : {}),
        ...(forceDeallocatableLiquidityRaw != null ? { forceDeallocatableLiquidityRaw } : {}),
        ...(forceDeallocatableLiquidityUsd != null ? { forceDeallocatableLiquidityUsd } : {}),
      },
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      telemetry: null,
      warnings: [
        reserveDegradedWarning(
          "morpho-vault-v2-liquidity-unavailable",
          `Morpho V2 liquidity fetch failed for ${args.coinId}: ${message}`,
        ),
      ],
    };
  }
}

async function fetchMorphoVaultV1LiquidityTelemetry(args: {
  coinId: string;
  contractAddress: string;
  assetAddress: string;
  config: MorphoVaultV1RedemptionLiquidityConfig;
  signal: AbortSignal;
  ctx?: AdapterContext;
}): Promise<{ telemetry: MorphoVaultLiquidityTelemetry | null; warnings: LiveReserveWarning[] }> {
  const apiUrl = args.config.apiUrl ?? DEFAULT_MORPHO_GRAPHQL_URL;
  try {
    const payload = await fetchJsonPostWithRetry<MorphoVaultV1LiquidityResponse>(
      apiUrl,
      {
        query: MORPHO_VAULT_V1_LIQUIDITY_QUERY,
        variables: {
          address: args.contractAddress,
          chainId: args.config.chainId,
        },
      },
      args.signal,
      12_000,
      args.ctx,
      { headers: { Accept: "application/json" } },
    );
    if (payload.errors != null) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v1-liquidity-unavailable",
            `Morpho V1 liquidity query returned GraphQL errors for ${args.coinId}`,
          ),
        ],
      };
    }

    const vault = payload.data?.vaultByAddress;
    if (!vault) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v1-liquidity-unavailable",
            `Morpho V1 liquidity query returned no vault for ${args.coinId}`,
          ),
        ],
      };
    }

    const reportedVaultAddress = parseMorphoAddress(vault.address);
    if (reportedVaultAddress !== args.contractAddress.toLowerCase()) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v1-identity-mismatch",
            `Morpho V1 liquidity vault address mismatch for ${args.coinId}`,
          ),
        ],
      };
    }

    const reportedAssetAddress = parseMorphoAddress(vault.asset?.address);
    if (reportedAssetAddress !== args.assetAddress.toLowerCase()) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v1-asset-mismatch",
            `Morpho V1 liquidity asset mismatch for ${args.coinId}`,
          ),
        ],
      };
    }

    const reportedChainId = parseMorphoChainId(vault.chain?.id);
    if (reportedChainId !== args.config.chainId) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v1-chain-mismatch",
            `Morpho V1 liquidity chain mismatch for ${args.coinId}`,
          ),
        ],
      };
    }

    if (vault.listed !== true) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v1-unlisted",
            `Morpho V1 liquidity vault is not listed for ${args.coinId}`,
          ),
        ],
      };
    }

    if (vault.warnings?.length) {
      const warningList = vault.warnings.map(describeMorphoWarning).join(", ");
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v1-warning",
            `Morpho V1 liquidity vault warnings for ${args.coinId}: ${warningList}`,
          ),
        ],
      };
    }

    const liquidityRaw = parseNonNegativeBigIntLike(vault.liquidity?.underlying);
    if (liquidityRaw == null) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "morpho-vault-v1-liquidity-invalid",
            `Morpho V1 liquidity payload has invalid liquidity for ${args.coinId}`,
          ),
        ],
      };
    }

    const liquidityUsd = parseOptionalNonNegativeNumber(vault.liquidity?.usd);

    return {
      telemetry: {
        source: "morpho-vault-v1-liquidity",
        liquidityRaw,
        ...(liquidityUsd != null ? { liquidityUsd } : {}),
      },
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      telemetry: null,
      warnings: [
        reserveDegradedWarning(
          "morpho-vault-v1-liquidity-unavailable",
          `Morpho V1 liquidity fetch failed for ${args.coinId}: ${message}`,
        ),
      ],
    };
  }
}

function buildRedemptionCapacityTelemetry(
  idleUnderlyingBalanceRaw: bigint | null,
  underlyingDecimalsRaw: bigint | null,
  supplyAssetsRaw: bigint,
  morphoVaultLiquidity: MorphoVaultLiquidityTelemetry | null,
): RedemptionCapacityTelemetry | null {
  const underlyingDecimals = decodeErc20Decimals(underlyingDecimalsRaw);
  if (underlyingDecimals == null) return null;

  const idleCapacityRaw = idleUnderlyingBalanceRaw ?? 0n;
  const morphoCapacityRaw = morphoVaultLiquidity?.liquidityRaw ?? 0n;
  const capacitySource = morphoCapacityRaw > idleCapacityRaw
    ? morphoVaultLiquidity?.source ?? "morpho-vault-v2-liquidity"
    : "erc4626-idle-underlying";
  const uncappedCapacityRaw = morphoCapacityRaw > idleCapacityRaw ? morphoCapacityRaw : idleCapacityRaw;
  if (uncappedCapacityRaw === 0n && idleUnderlyingBalanceRaw == null && morphoVaultLiquidity == null) {
    return null;
  }

  const capacityRaw = uncappedCapacityRaw > supplyAssetsRaw ? supplyAssetsRaw : uncappedCapacityRaw;
  const capacityUsd = decimalNumberFromBigInt(capacityRaw, underlyingDecimals);
  if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

  const capacityRatioOfSupply = ratioFromRaw(capacityRaw, supplyAssetsRaw);
  const usesMorphoCapacity = capacitySource !== "erc4626-idle-underlying";
  return {
    capacityUsd,
    capacityRaw: capacityRaw.toString(),
    capacitySource,
    freshnessKind: usesMorphoCapacity ? "same-run-api" : "same-run-onchain",
    routeStatusSource: usesMorphoCapacity ? "protocol-api" : "onchain",
    ...(idleUnderlyingBalanceRaw != null ? { idleUnderlyingBalanceRaw: idleUnderlyingBalanceRaw.toString() } : {}),
    underlyingDecimals,
    ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
    ...(morphoVaultLiquidity?.source === "morpho-vault-v1-liquidity"
      ? {
          morphoVaultV1LiquidityRaw: morphoVaultLiquidity.liquidityRaw.toString(),
          ...(morphoVaultLiquidity.liquidityUsd != null
            ? { morphoVaultV1LiquidityUsd: morphoVaultLiquidity.liquidityUsd }
            : {}),
        }
      : {}),
    ...(morphoVaultLiquidity?.source === "morpho-vault-v2-liquidity"
      ? {
          morphoVaultV2LiquidityRaw: morphoVaultLiquidity.liquidityRaw.toString(),
          ...(morphoVaultLiquidity.liquidityUsd != null
            ? { morphoVaultV2LiquidityUsd: morphoVaultLiquidity.liquidityUsd }
            : {}),
          ...(morphoVaultLiquidity.forceDeallocatableLiquidityRaw != null
            ? {
                morphoVaultV2ForceDeallocatableLiquidityRaw:
                  morphoVaultLiquidity.forceDeallocatableLiquidityRaw.toString(),
              }
            : {}),
          ...(morphoVaultLiquidity.forceDeallocatableLiquidityUsd != null
            ? {
                morphoVaultV2ForceDeallocatableLiquidityUsd:
                  morphoVaultLiquidity.forceDeallocatableLiquidityUsd,
              }
            : {}),
        }
      : {}),
  };
}

export async function fetchErc4626SingleAssetReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireOnchainInput(config.inputs.primary, "erc4626-single-asset");
  const sliceConfig = parseSliceConfig(config);
  const contractAddress = resolveCoinContractAddress(coin, primaryInput.chain);
  if (!contractAddress) {
    throw new Error(`No ${primaryInput.chain} contract configured for ${coin.id}`);
  }

  const timeout = 12_000;
  const call = makeContractRawCaller({
    contractAddress,
    signal,
    ctx: _ctx,
    rpcMode: primaryInput.rpcMode,
    chain: primaryInput.chain,
    rpcUrl: sliceConfig.rpcUrl,
    fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
    timeoutMs: timeout,
  });
  const [assetResult, totalAssetsResult] = await Promise.all([
    call(ERC4626_ASSET_SELECTOR),
    call(ERC4626_TOTAL_ASSETS_SELECTOR),
  ]);

  if (!totalAssetsResult) {
    throw new Error(`ERC-4626 totalAssets() call failed for ${coin.id}`);
  }
  const totalAssetsRaw = BigInt(totalAssetsResult);
  if (totalAssetsRaw <= 0n) {
    throw new Error(`ERC-4626 totalAssets() is zero for ${coin.id}`);
  }

  const warnings: LiveReserveWarning[] = [];
  const assetAddress = assetResult ? parseEvmAddressResult(assetResult as `0x${string}`) : null;
  if (!assetAddress && sliceConfig.expectedAssetAddress) {
    throw new Error(
      `ERC-4626 asset() could not be read for ${coin.id}; expected ${sliceConfig.expectedAssetAddress}`,
    );
  }
  if (
    assetAddress
    && sliceConfig.expectedAssetAddress
    && assetAddress !== sliceConfig.expectedAssetAddress
  ) {
    throw new Error(
      `ERC-4626 asset() returned ${assetAddress}, expected ${sliceConfig.expectedAssetAddress} for ${coin.id}`,
    );
  }

  // NAV cross-check: totalSupply() shares valued through convertToAssets() vs totalAssets()
  const totalSupplyResult = await call(TOTAL_SUPPLY_SELECTOR);

  let totalSupplyRaw: bigint | undefined;
  if (totalSupplyResult) {
    totalSupplyRaw = BigInt(totalSupplyResult);
  }
  const navCheck = await computeErc4626CollateralizationRatio({
    call,
    totalAssetsRaw,
    totalSupplyRaw,
    warningCode: "erc4626-nav-divergence",
  });
  const { collateralizationRatio, convertToAssetsRaw } = navCheck;
  warnings.push(...navCheck.warnings);

  let redemptionCapacity: RedemptionCapacityTelemetry | null = null;
  if (assetAddress) {
    const [idleUnderlyingBalanceRaw, underlyingDecimalsRaw] = await Promise.all([
      fetchOnchainUint256({
        contract: assetAddress,
        data: encodeBalanceOfCallData(contractAddress),
        signal,
        ctx: _ctx,
        rpcMode: primaryInput.rpcMode,
        chain: primaryInput.chain,
        rpcUrl: sliceConfig.rpcUrl,
        fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
        timeoutMs: timeout,
      }),
      fetchOnchainUint256({
        contract: assetAddress,
        data: DECIMALS_SELECTOR,
        signal,
        ctx: _ctx,
        rpcMode: primaryInput.rpcMode,
        chain: primaryInput.chain,
        rpcUrl: sliceConfig.rpcUrl,
        fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
        timeoutMs: timeout,
      }),
    ]);
    let morphoVaultLiquidity: MorphoVaultLiquidityTelemetry | null = null;
    if (sliceConfig.redemptionLiquidity?.source === "morpho-vault-v2") {
      const morphoResult = await fetchMorphoVaultV2LiquidityTelemetry({
        coinId: coin.id,
        contractAddress,
        assetAddress,
        config: sliceConfig.redemptionLiquidity,
        signal,
        ctx: _ctx,
      });
      warnings.push(...morphoResult.warnings);
      morphoVaultLiquidity = morphoResult.telemetry;
    } else if (sliceConfig.redemptionLiquidity?.source === "morpho-vault-v1") {
      const morphoResult = await fetchMorphoVaultV1LiquidityTelemetry({
        coinId: coin.id,
        contractAddress,
        assetAddress,
        config: sliceConfig.redemptionLiquidity,
        signal,
        ctx: _ctx,
      });
      warnings.push(...morphoResult.warnings);
      morphoVaultLiquidity = morphoResult.telemetry;
    }
    redemptionCapacity = buildRedemptionCapacityTelemetry(
      idleUnderlyingBalanceRaw,
      underlyingDecimalsRaw,
      convertToAssetsRaw ?? totalAssetsRaw,
      morphoVaultLiquidity,
    );
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
      ...notApplicableFreshnessMetadata({
        proofKind: "erc4626-total-assets",
        ...(assetAddress
          ? { assetAddressMatchesExpected: sliceConfig.expectedAssetAddress == null || assetAddress === sliceConfig.expectedAssetAddress }
          : {}),
      }),
      chain: primaryInput.chain,
      contractAddress,
      totalAssetsRaw: totalAssetsRaw.toString(),
      ...(assetAddress ? { assetAddress } : {}),
      ...(redemptionCapacity
        ? {
            redemptionCapacityRaw: redemptionCapacity.capacityRaw,
            redemptionCapacitySource: redemptionCapacity.capacitySource,
            ...(redemptionCapacity.idleUnderlyingBalanceRaw != null
              ? { idleUnderlyingBalanceRaw: redemptionCapacity.idleUnderlyingBalanceRaw }
              : {}),
            underlyingDecimals: redemptionCapacity.underlyingDecimals,
            ...(redemptionCapacity.morphoVaultV1LiquidityRaw != null
              ? { morphoVaultV1LiquidityRaw: redemptionCapacity.morphoVaultV1LiquidityRaw }
              : {}),
            ...(redemptionCapacity.morphoVaultV1LiquidityUsd != null
              ? { morphoVaultV1LiquidityUsd: redemptionCapacity.morphoVaultV1LiquidityUsd }
              : {}),
            ...(redemptionCapacity.morphoVaultV2LiquidityRaw != null
              ? { morphoVaultV2LiquidityRaw: redemptionCapacity.morphoVaultV2LiquidityRaw }
              : {}),
            ...(redemptionCapacity.morphoVaultV2LiquidityUsd != null
              ? { morphoVaultV2LiquidityUsd: redemptionCapacity.morphoVaultV2LiquidityUsd }
              : {}),
            ...(redemptionCapacity.morphoVaultV2ForceDeallocatableLiquidityRaw != null
              ? {
                  morphoVaultV2ForceDeallocatableLiquidityRaw:
                    redemptionCapacity.morphoVaultV2ForceDeallocatableLiquidityRaw,
                }
              : {}),
            ...(redemptionCapacity.morphoVaultV2ForceDeallocatableLiquidityUsd != null
              ? {
                  morphoVaultV2ForceDeallocatableLiquidityUsd:
                    redemptionCapacity.morphoVaultV2ForceDeallocatableLiquidityUsd,
                }
              : {}),
          }
        : {}),
      ...(totalSupplyRaw != null ? { totalSupplyRaw: totalSupplyRaw.toString() } : {}),
      ...(convertToAssetsRaw != null ? { convertToAssetsRaw: convertToAssetsRaw.toString() } : {}),
      ...(collateralizationRatio != null && Number.isFinite(collateralizationRatio)
        ? { collateralizationRatio }
        : {}),
      redemption: {
        ...(redemptionCapacity
          ? {
              capacityUsd: redemptionCapacity.capacityUsd,
              ...(redemptionCapacity.capacityRatioOfSupply != null
                ? { capacityRatioOfSupply: redemptionCapacity.capacityRatioOfSupply }
                : {}),
              capacityKind: "live-direct" as const,
            }
          : {
              capacityKind: "documented-eventual" as const,
            }),
        freshnessKind: redemptionCapacity?.freshnessKind ?? "same-run-onchain" as const,
        routeStatus: warnings.length > 0 ? "degraded" as const : "unknown" as const,
        routeStatusSource: redemptionCapacity?.routeStatusSource ?? "onchain" as const,
      },
    },
  };
}
