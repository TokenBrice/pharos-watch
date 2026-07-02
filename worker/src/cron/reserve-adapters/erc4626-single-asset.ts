import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddress,
  encodeBalanceOfCallData,
  encodeUint256,
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
  ERC4626_CONVERT_TO_ASSETS_SELECTOR,
  ERC4626_TOTAL_ASSETS_SELECTOR,
  computeErc4626CollateralizationRatio,
  makeContractRawCaller,
} from "./erc4626";
import { parseBoundedDecimals, ratioFromRaw } from "./slice-math";
import { throwIfAborted } from "../../lib/abort";

interface SingleAssetSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  expectedAssetAddress?: string;
  redemptionLiquidity?: RedemptionLiquidityConfig;
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

interface AtomicFullBackingRedemptionLiquidityConfig {
  source: "atomic-full-backing";
}

interface YearnV3WithdrawableRedemptionLiquidityConfig {
  source: "yearn-v3-withdrawable";
  settlementDelaySec?: number;
}

type RedemptionLiquidityConfig =
  | MorphoVaultV1RedemptionLiquidityConfig
  | MorphoVaultV2RedemptionLiquidityConfig
  | AtomicFullBackingRedemptionLiquidityConfig
  | YearnV3WithdrawableRedemptionLiquidityConfig;

type MorphoVaultLiquiditySource = "morpho-vault-v1-liquidity" | "morpho-vault-v2-liquidity";
type YearnV3WithdrawableLiquiditySource = "yearn-v3-withdrawable";

interface MorphoVaultLiquidityTelemetry {
  source: MorphoVaultLiquiditySource;
  liquidityRaw: bigint;
  liquidityUsd?: number;
  forceDeallocatableLiquidityRaw?: bigint;
  forceDeallocatableLiquidityUsd?: number;
}

interface YearnV3WithdrawableLiquidityTelemetry {
  source: YearnV3WithdrawableLiquiditySource;
  withdrawableRaw: bigint;
  settlementDelaySec: number;
}

interface RedemptionCapacityTelemetry {
  capacityUsd: number;
  capacityRaw: string;
  capacitySource:
    | "erc4626-idle-underlying"
    | "erc4626-atomic-full-backing"
    | MorphoVaultLiquiditySource
    | YearnV3WithdrawableLiquiditySource;
  freshnessKind: "same-run-onchain" | "same-run-api";
  routeStatusSource: "onchain" | "protocol-api";
  idleUnderlyingBalanceRaw?: string;
  underlyingDecimals: number;
  capacityRatioOfSupply?: number;
  settlementDelaySec?: number;
  yearnV3WithdrawableRaw?: string;
  morphoVaultV1LiquidityRaw?: string;
  morphoVaultV1LiquidityUsd?: number;
  morphoVaultV2LiquidityRaw?: string;
  morphoVaultV2LiquidityUsd?: number;
  morphoVaultV2ForceDeallocatableLiquidityRaw?: string;
  morphoVaultV2ForceDeallocatableLiquidityUsd?: number;
}

interface MorphoVaultWarning {
  type?: unknown;
  level?: unknown;
}

interface MorphoVaultLiquidityBase {
  address?: unknown;
  listed?: unknown;
  asset?: {
    address?: unknown;
  } | null;
  chain?: {
    id?: unknown;
  } | null;
  warnings?: MorphoVaultWarning[] | null;
}

interface MorphoVaultV1LiquidityVault extends MorphoVaultLiquidityBase {
  liquidity?: {
    underlying?: unknown;
    usd?: unknown;
  } | null;
}

interface MorphoVaultV2LiquidityVault extends MorphoVaultLiquidityBase {
  liquidity?: unknown;
  liquidityUsd?: unknown;
  forceDeallocatableLiquidity?: unknown;
  forceDeallocatableLiquidityUsd?: unknown;
}

interface MorphoVaultV1LiquidityResponse {
  data?: {
    vaultByAddress?: MorphoVaultV1LiquidityVault | null;
  };
  errors?: unknown;
}

interface MorphoVaultV2LiquidityResponse {
  data?: {
    vaultV2ByAddress?: MorphoVaultV2LiquidityVault | null;
  };
  errors?: unknown;
}

interface ParsedMorphoVaultLiquidity {
  liquidityRaw: bigint | null;
  liquidityUsd?: number;
  forceDeallocatableLiquidityRaw?: bigint;
  forceDeallocatableLiquidityUsd?: number;
}

const DEFAULT_MORPHO_GRAPHQL_URL = "https://api.morpho.org/graphql";
const YEARN_V3_TOTAL_IDLE_SELECTOR = "0x9aa7df94";
const YEARN_V3_GET_DEFAULT_QUEUE_SELECTOR = "0xa9bbf1cc";
const YEARN_V3_STRATEGIES_SELECTOR = "0x39ebf823";
const YEARN_V3_MAX_REDEEM_SELECTOR = "0xd905777e";
const ABI_WORD_HEX_LENGTH = 64;
const MAX_YEARN_V3_QUEUE_LENGTH = 10;

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

function normalizeAbiHex(raw: string | null): string | null {
  if (!raw || !raw.startsWith("0x")) return null;
  const hex = raw.slice(2);
  if (hex.length === 0 || hex.length % ABI_WORD_HEX_LENGTH !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  return hex;
}

function getAbiWord(raw: string | null, index: number): string | null {
  const hex = normalizeAbiHex(raw);
  if (hex == null || index < 0) return null;
  const start = index * ABI_WORD_HEX_LENGTH;
  const end = start + ABI_WORD_HEX_LENGTH;
  if (end > hex.length) return null;
  return hex.slice(start, end);
}

function parseAbiUint256Word(raw: string | null, index: number): bigint | null {
  const word = getAbiWord(raw, index);
  if (word == null) return null;
  return BigInt(`0x${word}`);
}

function parseAbiAddressWord(raw: string | null, index: number): string | null {
  const word = getAbiWord(raw, index);
  if (word == null) return null;
  const normalized = word.toLowerCase();
  if (!/^0{24}[0-9a-f]{40}$/.test(normalized)) return null;
  return `0x${normalized.slice(-40)}`;
}

function parseAbiAddressArray(raw: string | null): string[] | null {
  const offsetBytes = parseAbiUint256Word(raw, 0);
  if (offsetBytes == null || offsetBytes % 32n !== 0n) return null;
  const offsetWords = Number(offsetBytes / 32n);
  if (!Number.isSafeInteger(offsetWords) || offsetWords < 1) return null;
  const length = parseAbiUint256Word(raw, offsetWords);
  if (length == null || length > BigInt(MAX_YEARN_V3_QUEUE_LENGTH)) return null;
  const lengthNumber = Number(length);
  const addresses: string[] = [];
  for (let index = 0; index < lengthNumber; index += 1) {
    const address = parseAbiAddressWord(raw, offsetWords + 1 + index);
    if (address == null) return null;
    addresses.push(address);
  }
  return addresses;
}

async function fetchYearnV3WithdrawableLiquidityTelemetry(args: {
  coinId: string;
  contractAddress: string;
  call: (data: string) => Promise<string | null>;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcMode: ReturnType<typeof requireOnchainInput>["rpcMode"];
  chain: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  timeoutMs: number;
  settlementDelaySec?: number;
}): Promise<{
  telemetry: YearnV3WithdrawableLiquidityTelemetry | null;
  warnings: LiveReserveWarning[];
}> {
  const [totalIdleResult, defaultQueueResult] = await Promise.all([
    args.call(YEARN_V3_TOTAL_IDLE_SELECTOR),
    args.call(YEARN_V3_GET_DEFAULT_QUEUE_SELECTOR),
  ]);

  if (!totalIdleResult || !defaultQueueResult) {
    return {
      telemetry: null,
      warnings: [
        reserveDegradedWarning(
          "yearn-v3-withdrawable-unavailable",
          `Yearn V3 withdrawable-capacity probes failed for ${args.coinId}`,
        ),
      ],
    };
  }

  const defaultQueue = parseAbiAddressArray(defaultQueueResult);
  const totalIdleRaw = parseAbiUint256Word(totalIdleResult, 0);
  if (totalIdleRaw == null) {
    return {
      telemetry: null,
      warnings: [
        reserveDegradedWarning(
          "yearn-v3-total-idle-malformed",
          `Yearn V3 totalIdle() could not be decoded for ${args.coinId}`,
        ),
      ],
    };
  }
  if (defaultQueue == null) {
    return {
      telemetry: null,
      warnings: [
        reserveDegradedWarning(
          "yearn-v3-default-queue-malformed",
          `Yearn V3 default withdrawal queue could not be decoded for ${args.coinId}`,
        ),
      ],
    };
  }

  let withdrawableRaw = totalIdleRaw;

  for (const strategyAddress of defaultQueue) {
    throwIfAborted(args.signal);
    const strategyParamsResult = await args.call(`${YEARN_V3_STRATEGIES_SELECTOR}${encodeAddress(strategyAddress)}`);
    const currentDebtRaw = parseAbiUint256Word(strategyParamsResult, 2);
    if (currentDebtRaw == null) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "yearn-v3-strategy-debt-unavailable",
            `Yearn V3 strategy debt could not be decoded for ${args.coinId} strategy ${strategyAddress}`,
          ),
        ],
      };
    }
    if (currentDebtRaw === 0n) continue;

    const maxRedeemRaw = await fetchOnchainUint256({
      contract: strategyAddress,
      data: `${YEARN_V3_MAX_REDEEM_SELECTOR}${encodeAddress(args.contractAddress)}` as `0x${string}`,
      signal: args.signal,
      ctx: args.ctx,
      rpcMode: args.rpcMode,
      chain: args.chain,
      rpcUrl: args.rpcUrl,
      fallbackRpcUrl: args.fallbackRpcUrl,
      timeoutMs: args.timeoutMs,
    });
    if (maxRedeemRaw == null) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "yearn-v3-strategy-max-redeem-unavailable",
            `Yearn V3 strategy maxRedeem() failed for ${args.coinId} strategy ${strategyAddress}`,
          ),
        ],
      };
    }
    if (maxRedeemRaw === 0n) continue;

    const strategyWithdrawableRaw = await fetchOnchainUint256({
      contract: strategyAddress,
      data: `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(maxRedeemRaw)}` as `0x${string}`,
      signal: args.signal,
      ctx: args.ctx,
      rpcMode: args.rpcMode,
      chain: args.chain,
      rpcUrl: args.rpcUrl,
      fallbackRpcUrl: args.fallbackRpcUrl,
      timeoutMs: args.timeoutMs,
    });
    if (strategyWithdrawableRaw == null) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            "yearn-v3-strategy-convert-unavailable",
            `Yearn V3 strategy convertToAssets(maxRedeem) failed for ${args.coinId} strategy ${strategyAddress}`,
          ),
        ],
      };
    }

    withdrawableRaw += strategyWithdrawableRaw > currentDebtRaw ? currentDebtRaw : strategyWithdrawableRaw;
  }

  return {
    telemetry: {
      source: "yearn-v3-withdrawable",
      withdrawableRaw,
      settlementDelaySec: args.settlementDelaySec ?? 0,
    },
    warnings: [],
  };
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

async function fetchMorphoVaultLiquidityTelemetry<
  Response extends { errors?: unknown },
  Vault extends MorphoVaultLiquidityBase,
>(args: {
  coinId: string;
  contractAddress: string;
  assetAddress: string;
  config: { chainId: number; apiUrl?: string };
  signal: AbortSignal;
  ctx?: AdapterContext;
  query: string;
  versionLabel: "Morpho V1" | "Morpho V2";
  warningCodePrefix: "morpho-vault-v1" | "morpho-vault-v2";
  telemetrySource: MorphoVaultLiquiditySource;
  extractVault: (payload: Response) => Vault | null | undefined;
  parseLiquidity: (vault: Vault) => ParsedMorphoVaultLiquidity;
}): Promise<{ telemetry: MorphoVaultLiquidityTelemetry | null; warnings: LiveReserveWarning[] }> {
  const apiUrl = args.config.apiUrl ?? DEFAULT_MORPHO_GRAPHQL_URL;
  try {
    const payload = await fetchJsonPostWithRetry<Response>(
      apiUrl,
      {
        query: args.query,
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
            `${args.warningCodePrefix}-liquidity-unavailable`,
            `${args.versionLabel} liquidity query returned GraphQL errors for ${args.coinId}`,
          ),
        ],
      };
    }

    const vault = args.extractVault(payload);
    if (!vault) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            `${args.warningCodePrefix}-liquidity-unavailable`,
            `${args.versionLabel} liquidity query returned no vault for ${args.coinId}`,
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
            `${args.warningCodePrefix}-identity-mismatch`,
            `${args.versionLabel} liquidity vault address mismatch for ${args.coinId}`,
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
            `${args.warningCodePrefix}-asset-mismatch`,
            `${args.versionLabel} liquidity asset mismatch for ${args.coinId}`,
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
            `${args.warningCodePrefix}-chain-mismatch`,
            `${args.versionLabel} liquidity chain mismatch for ${args.coinId}`,
          ),
        ],
      };
    }

    if (vault.listed !== true) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            `${args.warningCodePrefix}-unlisted`,
            `${args.versionLabel} liquidity vault is not listed for ${args.coinId}`,
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
            `${args.warningCodePrefix}-warning`,
            `${args.versionLabel} liquidity vault warnings for ${args.coinId}: ${warningList}`,
          ),
        ],
      };
    }

    const liquidity = args.parseLiquidity(vault);
    const { liquidityRaw } = liquidity;
    if (liquidityRaw == null) {
      return {
        telemetry: null,
        warnings: [
          reserveDegradedWarning(
            `${args.warningCodePrefix}-liquidity-invalid`,
            `${args.versionLabel} liquidity payload has invalid liquidity for ${args.coinId}`,
          ),
        ],
      };
    }

    return {
      telemetry: {
        source: args.telemetrySource,
        liquidityRaw,
        ...(liquidity.liquidityUsd != null ? { liquidityUsd: liquidity.liquidityUsd } : {}),
        ...(liquidity.forceDeallocatableLiquidityRaw != null
          ? { forceDeallocatableLiquidityRaw: liquidity.forceDeallocatableLiquidityRaw }
          : {}),
        ...(liquidity.forceDeallocatableLiquidityUsd != null
          ? { forceDeallocatableLiquidityUsd: liquidity.forceDeallocatableLiquidityUsd }
          : {}),
      },
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      telemetry: null,
      warnings: [
        reserveDegradedWarning(
          `${args.warningCodePrefix}-liquidity-unavailable`,
          `${args.versionLabel} liquidity fetch failed for ${args.coinId}: ${message}`,
        ),
      ],
    };
  }
}

function fetchMorphoVaultV2LiquidityTelemetry(args: {
  coinId: string;
  contractAddress: string;
  assetAddress: string;
  config: MorphoVaultV2RedemptionLiquidityConfig;
  signal: AbortSignal;
  ctx?: AdapterContext;
}): Promise<{ telemetry: MorphoVaultLiquidityTelemetry | null; warnings: LiveReserveWarning[] }> {
  return fetchMorphoVaultLiquidityTelemetry<MorphoVaultV2LiquidityResponse, MorphoVaultV2LiquidityVault>({
    ...args,
    query: MORPHO_VAULT_V2_LIQUIDITY_QUERY,
    versionLabel: "Morpho V2",
    warningCodePrefix: "morpho-vault-v2",
    telemetrySource: "morpho-vault-v2-liquidity",
    extractVault: (payload) => payload.data?.vaultV2ByAddress,
    parseLiquidity: (vault) => {
      const liquidityUsd = parseOptionalNonNegativeNumber(vault.liquidityUsd);
      const forceDeallocatableLiquidityRaw = parseNonNegativeBigIntLike(vault.forceDeallocatableLiquidity);
      const forceDeallocatableLiquidityUsd = parseOptionalNonNegativeNumber(vault.forceDeallocatableLiquidityUsd);
      return {
        liquidityRaw: parseNonNegativeBigIntLike(vault.liquidity),
        ...(liquidityUsd != null ? { liquidityUsd } : {}),
        ...(forceDeallocatableLiquidityRaw != null ? { forceDeallocatableLiquidityRaw } : {}),
        ...(forceDeallocatableLiquidityUsd != null ? { forceDeallocatableLiquidityUsd } : {}),
      };
    },
  });
}

function fetchMorphoVaultV1LiquidityTelemetry(args: {
  coinId: string;
  contractAddress: string;
  assetAddress: string;
  config: MorphoVaultV1RedemptionLiquidityConfig;
  signal: AbortSignal;
  ctx?: AdapterContext;
}): Promise<{ telemetry: MorphoVaultLiquidityTelemetry | null; warnings: LiveReserveWarning[] }> {
  return fetchMorphoVaultLiquidityTelemetry<MorphoVaultV1LiquidityResponse, MorphoVaultV1LiquidityVault>({
    ...args,
    query: MORPHO_VAULT_V1_LIQUIDITY_QUERY,
    versionLabel: "Morpho V1",
    warningCodePrefix: "morpho-vault-v1",
    telemetrySource: "morpho-vault-v1-liquidity",
    extractVault: (payload) => payload.data?.vaultByAddress,
    parseLiquidity: (vault) => {
      const liquidityUsd = parseOptionalNonNegativeNumber(vault.liquidity?.usd);
      return {
        liquidityRaw: parseNonNegativeBigIntLike(vault.liquidity?.underlying),
        ...(liquidityUsd != null ? { liquidityUsd } : {}),
      };
    },
  });
}

function buildRedemptionCapacityTelemetry(
  idleUnderlyingBalanceRaw: bigint | null,
  underlyingDecimalsRaw: bigint | null,
  supplyAssetsRaw: bigint,
  morphoVaultLiquidity: MorphoVaultLiquidityTelemetry | null,
  yearnV3WithdrawableLiquidity: YearnV3WithdrawableLiquidityTelemetry | null,
  atomicFullBacking: boolean,
): RedemptionCapacityTelemetry | null {
  const underlyingDecimals = decodeErc20Decimals(underlyingDecimalsRaw);
  if (underlyingDecimals == null) return null;

  if (atomicFullBacking) {
    // Reviewer-asserted unconstrained redemption: the underlying is released on
    // demand from an external savings module (e.g. the Sky DSR pot), so the full
    // convertible backing is immediately redeemable. The idle-balance probe
    // below would understate this to ~0 because the vault holds no idle
    // underlying. Capacity is the supply-equivalent backing (ratio 1.0).
    const capacityUsd = decimalNumberFromBigInt(supplyAssetsRaw, underlyingDecimals);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;
    const capacityRatioOfSupply = ratioFromRaw(supplyAssetsRaw, supplyAssetsRaw);
    return {
      capacityUsd,
      capacityRaw: supplyAssetsRaw.toString(),
      capacitySource: "erc4626-atomic-full-backing",
      freshnessKind: "same-run-onchain",
      routeStatusSource: "onchain",
      ...(idleUnderlyingBalanceRaw != null ? { idleUnderlyingBalanceRaw: idleUnderlyingBalanceRaw.toString() } : {}),
      underlyingDecimals,
      ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
    };
  }

  const idleCapacityRaw = idleUnderlyingBalanceRaw ?? 0n;
  const morphoCapacityRaw = morphoVaultLiquidity?.liquidityRaw ?? 0n;
  const yearnCapacityRaw = yearnV3WithdrawableLiquidity?.withdrawableRaw ?? 0n;
  let capacitySource: RedemptionCapacityTelemetry["capacitySource"] = "erc4626-idle-underlying";
  let uncappedCapacityRaw = idleCapacityRaw;
  if (morphoCapacityRaw > uncappedCapacityRaw) {
    capacitySource = morphoVaultLiquidity?.source ?? "morpho-vault-v2-liquidity";
    uncappedCapacityRaw = morphoCapacityRaw;
  }
  if (yearnCapacityRaw > uncappedCapacityRaw) {
    capacitySource = yearnV3WithdrawableLiquidity?.source ?? "yearn-v3-withdrawable";
    uncappedCapacityRaw = yearnCapacityRaw;
  }
  if (
    uncappedCapacityRaw === 0n
    && idleUnderlyingBalanceRaw == null
    && morphoVaultLiquidity == null
    && yearnV3WithdrawableLiquidity == null
  ) {
    return null;
  }

  const capacityRaw = uncappedCapacityRaw > supplyAssetsRaw ? supplyAssetsRaw : uncappedCapacityRaw;
  const capacityUsd = decimalNumberFromBigInt(capacityRaw, underlyingDecimals);
  if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

  const capacityRatioOfSupply = ratioFromRaw(capacityRaw, supplyAssetsRaw);
  const usesProtocolApiCapacity =
    capacitySource === "morpho-vault-v1-liquidity" || capacitySource === "morpho-vault-v2-liquidity";
  const usesYearnV3Capacity = capacitySource === "yearn-v3-withdrawable";
  return {
    capacityUsd,
    capacityRaw: capacityRaw.toString(),
    capacitySource,
    freshnessKind: usesProtocolApiCapacity && !usesYearnV3Capacity ? "same-run-api" : "same-run-onchain",
    routeStatusSource: usesProtocolApiCapacity && !usesYearnV3Capacity ? "protocol-api" : "onchain",
    ...(idleUnderlyingBalanceRaw != null ? { idleUnderlyingBalanceRaw: idleUnderlyingBalanceRaw.toString() } : {}),
    underlyingDecimals,
    ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
    ...(usesYearnV3Capacity && yearnV3WithdrawableLiquidity
      ? {
          settlementDelaySec: yearnV3WithdrawableLiquidity.settlementDelaySec,
          yearnV3WithdrawableRaw: yearnV3WithdrawableLiquidity.withdrawableRaw.toString(),
        }
      : {}),
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
    const atomicFullBacking = sliceConfig.redemptionLiquidity?.source === "atomic-full-backing";
    let morphoVaultLiquidity: MorphoVaultLiquidityTelemetry | null = null;
    let yearnV3WithdrawableLiquidity: YearnV3WithdrawableLiquidityTelemetry | null = null;
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
    } else if (sliceConfig.redemptionLiquidity?.source === "yearn-v3-withdrawable") {
      const yearnResult = await fetchYearnV3WithdrawableLiquidityTelemetry({
        coinId: coin.id,
        contractAddress,
        call,
        signal,
        ctx: _ctx,
        rpcMode: primaryInput.rpcMode,
        chain: primaryInput.chain,
        rpcUrl: sliceConfig.rpcUrl,
        fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
        timeoutMs: timeout,
        settlementDelaySec: sliceConfig.redemptionLiquidity.settlementDelaySec,
      });
      warnings.push(...yearnResult.warnings);
      yearnV3WithdrawableLiquidity = yearnResult.telemetry;
    }
    redemptionCapacity = buildRedemptionCapacityTelemetry(
      idleUnderlyingBalanceRaw,
      underlyingDecimalsRaw,
      convertToAssetsRaw ?? totalAssetsRaw,
      morphoVaultLiquidity,
      yearnV3WithdrawableLiquidity,
      atomicFullBacking,
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
            ...(redemptionCapacity.yearnV3WithdrawableRaw != null
              ? { yearnV3WithdrawableRaw: redemptionCapacity.yearnV3WithdrawableRaw }
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
              ...(redemptionCapacity.settlementDelaySec != null
                ? { settlementDelaySec: redemptionCapacity.settlementDelaySec }
                : {}),
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
