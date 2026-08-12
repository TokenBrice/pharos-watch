import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import {
  DECIMALS_SELECTOR,
  PAUSED_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddress,
  encodeBalanceOfCallData,
  encodeUint256,
} from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decodeAbiWordAt,
  decodeStrictAddressArrayWord,
  decodeStrictBoolWord,
  decodeUint256Word,
} from "./abi-decode";
import { parseEvmAddressResult, resolveCoinContractAddress } from "./evm";
import {
  decimalNumberFromBigInt,
  fetchJsonPostWithRetry,
  makeOnchainCallers,
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
import { observeSfrxusdCrosschainRedemptionRoute } from "./sfrxusd-crosschain-redemption";
import type { SfrxusdCrosschainV9RouteAttempt } from "../../lib/sfrxusd-crosschain-redemption-route";
import {
  observeExecutableRedemptionRoute,
  type ExecutableRedemptionObservation,
} from "./executable-redemption-observers";

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

type RedemptionLiquidityConfig = NonNullable<
  LiveReserveAdapterParamsByKey["erc4626-single-asset"]["redemptionLiquidity"]
>;
type MorphoVaultV1RedemptionLiquidityConfig = Extract<
  RedemptionLiquidityConfig,
  { source: "morpho-vault-v1" }
>;
type MorphoVaultV2RedemptionLiquidityConfig = Extract<
  RedemptionLiquidityConfig,
  { source: "morpho-vault-v2" }
>;

type MorphoVaultLiquiditySource = "morpho-vault-v1-liquidity" | "morpho-vault-v2-liquidity";
type YearnV3WithdrawableLiquiditySource = "yearn-v3-withdrawable";
type SboldSpWithdrawableLiquiditySource = "sbold-sp-withdrawable";
type SfrxusdCrosschainWithdrawableLiquiditySource = "fraxtal-hop-withdrawable";

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

interface SboldSpWithdrawableLiquidityTelemetry {
  source: SboldSpWithdrawableLiquiditySource;
  withdrawableRaw: bigint;
}

interface SfrxusdCrosschainWithdrawableLiquidityTelemetry {
  source: SfrxusdCrosschainWithdrawableLiquiditySource;
  withdrawableRaw: bigint;
  blockNumber: number;
  sourceUrls: string[];
}

interface RedemptionCapacityTelemetry {
  capacityUsd: number;
  capacityRaw: string;
  capacitySource:
    | "erc4626-idle-underlying"
    | "erc4626-atomic-full-backing"
    | MorphoVaultLiquiditySource
    | YearnV3WithdrawableLiquiditySource
    | SboldSpWithdrawableLiquiditySource
    | SfrxusdCrosschainWithdrawableLiquiditySource
    | ExecutableRedemptionObservation["capacitySource"];
  freshnessKind: "same-run-onchain" | "same-run-api";
  routeStatusSource: "onchain" | "protocol-api";
  idleUnderlyingBalanceRaw?: string;
  underlyingDecimals: number;
  capacityRatioOfSupply?: number;
  settlementDelaySec?: number;
  blockNumber?: number;
  sourceUrls?: string[];
  sourceTimestamp?: number;
  capacityKind?: "live-direct" | "live-direct-bounded";
  holderEligibility?: "any-holder";
  routeStatus?: "open" | "paused" | "degraded";
  routeStatusReason?: string;
  feeBps?: number;
  observerDiagnostics?: Record<string, unknown>;
  yearnV3WithdrawableRaw?: string;
  sboldSpWithdrawableRaw?: string;
  sfrxusdCrosschainWithdrawableRaw?: string;
  morphoVaultV1LiquidityRaw?: string;
  morphoVaultV1LiquidityUsd?: number;
  morphoVaultV2LiquidityRaw?: string;
  morphoVaultV2LiquidityUsd?: number;
  morphoVaultV2ForceDeallocatableLiquidityRaw?: string;
  morphoVaultV2ForceDeallocatableLiquidityUsd?: number;
}

function buildExecutableRedemptionCapacityTelemetry(
  observation: ExecutableRedemptionObservation,
  supplyAssetsRaw: bigint,
): RedemptionCapacityTelemetry | null {
  const capacityRaw =
    observation.capacityRaw > supplyAssetsRaw
      ? supplyAssetsRaw
      : observation.capacityRaw;
  const capacityUsd = decimalNumberFromBigInt(
    capacityRaw,
    observation.underlyingDecimals,
  );
  if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;
  const capacityRatioOfSupply = ratioFromRaw(capacityRaw, supplyAssetsRaw);
  return {
    capacityUsd,
    capacityRaw: capacityRaw.toString(),
    capacitySource: observation.capacitySource,
    freshnessKind: observation.freshnessKind,
    routeStatusSource: observation.routeStatusSource,
    underlyingDecimals: observation.underlyingDecimals,
    ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
    capacityKind: observation.capacityKind,
    blockNumber: observation.blockNumber,
    sourceTimestamp: observation.sourceTimestamp,
    sourceUrls: observation.sourceUrls,
    holderEligibility: observation.holderEligibility,
    routeStatus: observation.routeStatus,
    routeStatusReason: observation.routeStatusReason,
    feeBps: observation.feeBps,
    observerDiagnostics: observation.diagnostics,
  };
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
const YEARN_V3_IS_SHUTDOWN_SELECTOR = "0xbf86d690";
const MAX_YEARN_V3_QUEUE_LENGTH = 10;
// K3 sBOLD calcFragments() -> (totalBold, boldAmount, collValue, collInBold).
// Word index 1 (boldAmount) is the compounded BOLD across the vault's Liquity V2
// Stability Pools — the on-demand SP-withdrawable amount that sBOLD._maxWithdraw
// caps redemptions at, and which excludes not-yet-swapped collateral (index 3).
// Selector = keccak256("calcFragments()")[:4]; verified against the deployed
// vault (see sbold-k3-capital redemption config evidence note).
const SBOLD_CALC_FRAGMENTS_SELECTOR = "0x160b71df";
const SBOLD_CALC_FRAGMENTS_LIQUID_BOLD_WORD_INDEX = 1;

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

  const defaultQueue = decodeStrictAddressArrayWord(defaultQueueResult, {
    maxItems: MAX_YEARN_V3_QUEUE_LENGTH,
  });
  const totalIdleRaw = decodeUint256Word(decodeAbiWordAt(totalIdleResult, 0));
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
  const onchain = makeOnchainCallers(
    { chain: args.chain, rpcMode: args.rpcMode },
    {
      signal: args.signal,
      ctx: args.ctx,
      rpcUrl: args.rpcUrl,
      fallbackRpcUrl: args.fallbackRpcUrl,
      timeoutMs: args.timeoutMs,
    },
  );

  for (const strategyAddress of defaultQueue) {
    throwIfAborted(args.signal);
    const strategyParamsResult = await args.call(`${YEARN_V3_STRATEGIES_SELECTOR}${encodeAddress(strategyAddress)}`);
    const currentDebtRaw = decodeUint256Word(decodeAbiWordAt(strategyParamsResult, 2));
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

    const maxRedeemRaw = await onchain.uint256(
      strategyAddress,
      `${YEARN_V3_MAX_REDEEM_SELECTOR}${encodeAddress(args.contractAddress)}` as `0x${string}`,
    );
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

    const strategyWithdrawableRaw = await onchain.uint256(
      strategyAddress,
      `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(maxRedeemRaw)}` as `0x${string}`,
    );
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

async function fetchSboldSpWithdrawableLiquidityTelemetry(args: {
  coinId: string;
  call: (data: string) => Promise<string | null>;
}): Promise<{
  telemetry: SboldSpWithdrawableLiquidityTelemetry | null;
  warnings: LiveReserveWarning[];
}> {
  const result = await args.call(SBOLD_CALC_FRAGMENTS_SELECTOR);
  const withdrawableRaw = decodeUint256Word(
    decodeAbiWordAt(result, SBOLD_CALC_FRAGMENTS_LIQUID_BOLD_WORD_INDEX),
  );
  if (withdrawableRaw == null) {
    return {
      telemetry: null,
      warnings: [
        reserveDegradedWarning(
          "sbold-sp-withdrawable-unavailable",
          `sBOLD calcFragments() Stability-Pool-withdrawable probe failed for ${args.coinId}`,
        ),
      ],
    };
  }
  return {
    telemetry: { source: "sbold-sp-withdrawable", withdrawableRaw },
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

interface RoutePauseProbe {
  paused: boolean | null;
  shutdown: boolean | null;
}

const NO_PAUSE_PROBE: RoutePauseProbe = { paused: null, shutdown: null };

const ROUTE_OPEN_REASON_BY_CAPACITY_SOURCE: Partial<
  Record<RedemptionCapacityTelemetry["capacitySource"], string>
> = {
  "erc4626-atomic-full-backing":
    "Reviewer-asserted unconstrained external-savings redemption; full convertible backing readable on-chain this run",
  "erc4626-idle-underlying":
    "Idle underlying redemption liquidity readable on-chain this run; no on-chain pause surface reported paused",
  "morpho-vault-v1-liquidity":
    "Morpho listed-vault in-kind liquidity positive via protocol API this run",
  "morpho-vault-v2-liquidity":
    "Morpho listed-vault in-kind liquidity positive via protocol API this run",
  "yearn-v3-withdrawable":
    "Yearn V3 withdrawable liquidity positive and isShutdown() false this run",
  "sbold-sp-withdrawable":
    "sBOLD Stability Pool withdrawable BOLD positive via calcFragments() this run",
};

function resolveRouteOpenness(
  capacitySource: RedemptionCapacityTelemetry["capacitySource"],
  capacityRaw: bigint,
  pauseProbe: RoutePauseProbe,
): Pick<RedemptionCapacityTelemetry, "routeStatus" | "routeStatusReason"> {
  if (pauseProbe.paused === true) {
    return {
      routeStatus: "paused",
      routeStatusReason: "Vault paused() returned true on-chain",
    };
  }
  if (pauseProbe.shutdown === true) {
    return {
      routeStatus: "paused",
      routeStatusReason: "Yearn vault isShutdown() returned true on-chain",
    };
  }
  // Zero capacity is not an open route: nothing is redeemable this run, so the
  // status stays unknown rather than asserting openness the reads do not show.
  if (capacityRaw <= 0n) return {};
  // Every Yearn V3 vault exposes isShutdown(); an unreadable probe leaves the
  // shutdown claim in the reason unproven, so fail closed.
  if (capacitySource === "yearn-v3-withdrawable" && pauseProbe.shutdown !== false) return {};
  const routeStatusReason = ROUTE_OPEN_REASON_BY_CAPACITY_SOURCE[capacitySource];
  return routeStatusReason ? { routeStatus: "open", routeStatusReason } : {};
}

function buildRedemptionCapacityTelemetry(
  idleUnderlyingBalanceRaw: bigint | null,
  underlyingDecimalsRaw: bigint | null,
  supplyAssetsRaw: bigint,
  morphoVaultLiquidity: MorphoVaultLiquidityTelemetry | null,
  yearnV3WithdrawableLiquidity: YearnV3WithdrawableLiquidityTelemetry | null,
  sboldSpWithdrawableLiquidity: SboldSpWithdrawableLiquidityTelemetry | null,
  sfrxusdCrosschainWithdrawableLiquidity: SfrxusdCrosschainWithdrawableLiquidityTelemetry | null,
  atomicFullBacking: boolean,
  pauseProbe: RoutePauseProbe,
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
      ...resolveRouteOpenness("erc4626-atomic-full-backing", supplyAssetsRaw, pauseProbe),
    };
  }

  const idleCapacityRaw = idleUnderlyingBalanceRaw ?? 0n;
  const morphoCapacityRaw = morphoVaultLiquidity?.liquidityRaw ?? 0n;
  const yearnCapacityRaw = yearnV3WithdrawableLiquidity?.withdrawableRaw ?? 0n;
  const sboldCapacityRaw = sboldSpWithdrawableLiquidity?.withdrawableRaw ?? 0n;
  const sfrxusdCrosschainCapacityRaw = sfrxusdCrosschainWithdrawableLiquidity?.withdrawableRaw ?? 0n;
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
  if (sboldCapacityRaw > uncappedCapacityRaw) {
    capacitySource = sboldSpWithdrawableLiquidity?.source ?? "sbold-sp-withdrawable";
    uncappedCapacityRaw = sboldCapacityRaw;
  }
  if (sfrxusdCrosschainCapacityRaw > uncappedCapacityRaw) {
    capacitySource = sfrxusdCrosschainWithdrawableLiquidity?.source ?? "fraxtal-hop-withdrawable";
    uncappedCapacityRaw = sfrxusdCrosschainCapacityRaw;
  }
  if (
    uncappedCapacityRaw === 0n
    && idleUnderlyingBalanceRaw == null
    && morphoVaultLiquidity == null
    && yearnV3WithdrawableLiquidity == null
    && sboldSpWithdrawableLiquidity == null
    && sfrxusdCrosschainWithdrawableLiquidity == null
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
  const usesSfrxusdCrosschainCapacity = capacitySource === "fraxtal-hop-withdrawable";
  return {
    capacityUsd,
    capacityRaw: capacityRaw.toString(),
    capacitySource,
    freshnessKind: usesProtocolApiCapacity && !usesYearnV3Capacity ? "same-run-api" : "same-run-onchain",
    routeStatusSource: usesProtocolApiCapacity && !usesYearnV3Capacity ? "protocol-api" : "onchain",
    ...(idleUnderlyingBalanceRaw != null ? { idleUnderlyingBalanceRaw: idleUnderlyingBalanceRaw.toString() } : {}),
    underlyingDecimals,
    ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
    ...resolveRouteOpenness(capacitySource, capacityRaw, pauseProbe),
    ...(usesYearnV3Capacity && yearnV3WithdrawableLiquidity
      ? {
          settlementDelaySec: yearnV3WithdrawableLiquidity.settlementDelaySec,
          yearnV3WithdrawableRaw: yearnV3WithdrawableLiquidity.withdrawableRaw.toString(),
        }
      : {}),
    ...(capacitySource === "sbold-sp-withdrawable" && sboldSpWithdrawableLiquidity
      ? { sboldSpWithdrawableRaw: sboldSpWithdrawableLiquidity.withdrawableRaw.toString() }
      : {}),
    ...(usesSfrxusdCrosschainCapacity && sfrxusdCrosschainWithdrawableLiquidity
      ? {
          capacityKind: "live-direct-bounded" as const,
          blockNumber: sfrxusdCrosschainWithdrawableLiquidity.blockNumber,
          sourceUrls: sfrxusdCrosschainWithdrawableLiquidity.sourceUrls,
          holderEligibility: "any-holder" as const,
          routeStatus: "open" as const,
          sfrxusdCrosschainWithdrawableRaw:
            sfrxusdCrosschainWithdrawableLiquidity.withdrawableRaw.toString(),
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
  let sfrxusdRouteAttempt: SfrxusdCrosschainV9RouteAttempt | null = null;
  if (assetAddress) {
    const executableObservation = await observeExecutableRedemptionRoute(
      coin.id,
      contractAddress,
      signal,
      _ctx,
      {
        extraRpcUrls: [sliceConfig.rpcUrl, sliceConfig.fallbackRpcUrl].filter(
          (url): url is string => Boolean(url),
        ),
      },
    );
    if (executableObservation) {
      redemptionCapacity = buildExecutableRedemptionCapacityTelemetry(
        executableObservation,
        convertToAssetsRaw ?? totalAssetsRaw,
      );
      if (!redemptionCapacity) {
        throw new Error(
          `${coin.id} executable redemption observer returned invalid capacity telemetry`,
        );
      }
    } else {
      const usesSfrxusdCrosschainRoute =
        sliceConfig.redemptionLiquidity?.source === "fraxtal-hop-withdrawable";
      let idleUnderlyingBalanceRaw: bigint | null = null;
      let underlyingDecimalsRaw: bigint | null = usesSfrxusdCrosschainRoute ? 18n : null;
      if (!usesSfrxusdCrosschainRoute) {
        const onchain = makeOnchainCallers(primaryInput, {
          signal,
          ctx: _ctx,
          rpcUrl: sliceConfig.rpcUrl,
          fallbackRpcUrl: sliceConfig.fallbackRpcUrl,
          timeoutMs: timeout,
        });
        [idleUnderlyingBalanceRaw, underlyingDecimalsRaw] = await Promise.all([
          onchain.uint256(assetAddress, encodeBalanceOfCallData(contractAddress)),
          onchain.uint256(assetAddress, DECIMALS_SELECTOR),
        ]);
      }
      const atomicFullBacking = sliceConfig.redemptionLiquidity?.source === "atomic-full-backing";
      let morphoVaultLiquidity: MorphoVaultLiquidityTelemetry | null = null;
      let yearnV3WithdrawableLiquidity: YearnV3WithdrawableLiquidityTelemetry | null = null;
      let sboldSpWithdrawableLiquidity: SboldSpWithdrawableLiquidityTelemetry | null = null;
      let sfrxusdCrosschainWithdrawableLiquidity: SfrxusdCrosschainWithdrawableLiquidityTelemetry | null =
        null;
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
      } else if (sliceConfig.redemptionLiquidity?.source === "sbold-sp-withdrawable") {
        const sboldResult = await fetchSboldSpWithdrawableLiquidityTelemetry({
          coinId: coin.id,
          call,
        });
        warnings.push(...sboldResult.warnings);
        sboldSpWithdrawableLiquidity = sboldResult.telemetry;
      } else if (sliceConfig.redemptionLiquidity?.source === "fraxtal-hop-withdrawable") {
        const attempt = await observeSfrxusdCrosschainRedemptionRoute(
          sliceConfig.redemptionLiquidity,
          contractAddress,
          signal,
          _ctx,
          {
            ethereumRpcUrls: [sliceConfig.rpcUrl, sliceConfig.fallbackRpcUrl].filter(
              (url): url is string => Boolean(url),
            ),
          },
        );
        sfrxusdRouteAttempt = attempt;
        if (attempt.status === "accepted") {
          sfrxusdCrosschainWithdrawableLiquidity = {
            source: "fraxtal-hop-withdrawable",
            withdrawableRaw: BigInt(
              attempt.state.capacity.cappedPreviewOutputFrxUsdRaw,
            ),
            blockNumber: attempt.state.fraxtalBlock.blockNumber,
            sourceUrls: attempt.state.sourceUrls,
          };
        } else {
          warnings.push(
            reserveDegradedWarning(
              `sfrxusd-crosschain-redemption-${attempt.rejectionCode}`,
              `sfrxUSD cross-chain redemption route validation failed closed: ${attempt.rejectionCode}`,
            ),
          );
        }
      }
      // Route-openness evidence. The fraxtal hop manages its own route state, so
      // it is left untouched; every other path probes the vault's pause surfaces
      // once, after the capacity reads, so no extra round trip is serialized.
      let pauseProbe = NO_PAUSE_PROBE;
      if (!usesSfrxusdCrosschainRoute) {
        const probesYearnShutdown =
          sliceConfig.redemptionLiquidity?.source === "yearn-v3-withdrawable";
        const [pausedResult, shutdownResult] = await Promise.all([
          call(PAUSED_SELECTOR),
          probesYearnShutdown ? call(YEARN_V3_IS_SHUTDOWN_SELECTOR) : Promise.resolve(null),
        ]);
        pauseProbe = {
          paused: decodeStrictBoolWord(pausedResult),
          shutdown: probesYearnShutdown ? decodeStrictBoolWord(shutdownResult) : null,
        };
      }
      redemptionCapacity = buildRedemptionCapacityTelemetry(
        idleUnderlyingBalanceRaw,
        underlyingDecimalsRaw,
        convertToAssetsRaw ?? totalAssetsRaw,
        morphoVaultLiquidity,
        yearnV3WithdrawableLiquidity,
        sboldSpWithdrawableLiquidity,
        sfrxusdCrosschainWithdrawableLiquidity,
        atomicFullBacking,
        pauseProbe,
      );
    }
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
            ...(redemptionCapacity.sboldSpWithdrawableRaw != null
              ? { sboldSpWithdrawableRaw: redemptionCapacity.sboldSpWithdrawableRaw }
              : {}),
            ...(redemptionCapacity.sfrxusdCrosschainWithdrawableRaw != null
              ? {
                  sfrxusdCrosschainWithdrawableRaw:
                    redemptionCapacity.sfrxusdCrosschainWithdrawableRaw,
                }
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
            ...(redemptionCapacity.feeBps != null
              ? { redemptionFeeBps: redemptionCapacity.feeBps }
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
              capacityKind: redemptionCapacity.capacityKind ?? "live-direct" as const,
              ...(redemptionCapacity.settlementDelaySec != null
                ? { settlementDelaySec: redemptionCapacity.settlementDelaySec }
                : {}),
              ...(redemptionCapacity.blockNumber != null
                ? { blockNumber: redemptionCapacity.blockNumber }
                : {}),
              ...(redemptionCapacity.sourceTimestamp != null
                ? { sourceTimestamp: redemptionCapacity.sourceTimestamp }
                : {}),
              ...(redemptionCapacity.sourceUrls
                ? { sourceUrls: redemptionCapacity.sourceUrls }
                : {}),
              ...(redemptionCapacity.holderEligibility
                ? { holderEligibility: redemptionCapacity.holderEligibility }
                : {}),
              ...(redemptionCapacity.feeBps != null
                ? { feeBps: redemptionCapacity.feeBps }
                : {}),
              ...(redemptionCapacity.routeStatusReason
                ? { routeStatusReason: redemptionCapacity.routeStatusReason }
                : {}),
              ...(redemptionCapacity.observerDiagnostics
                ? { observerDiagnostics: redemptionCapacity.observerDiagnostics }
                : {}),
            }
          : {
              capacityKind: "documented-eventual" as const,
            }),
        freshnessKind: redemptionCapacity?.freshnessKind ?? "same-run-onchain" as const,
        routeStatus:
          warnings.length > 0
            ? "degraded" as const
            : redemptionCapacity?.routeStatus ?? "unknown" as const,
        routeStatusSource: redemptionCapacity?.routeStatusSource ?? "onchain" as const,
        ...(sfrxusdRouteAttempt ? { v9RouteAttempt: sfrxusdRouteAttempt } : {}),
      },
    },
  };
}
