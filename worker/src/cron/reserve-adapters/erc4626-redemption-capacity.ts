import { toErrorMessage } from "@shared/lib/error-utils";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import {
  encodeAddress,
  encodeUint256,
} from "../../lib/evm-selectors";
import type { AdapterContext } from "./types";
import {
  decodeAbiWordAt,
  decodeStrictAddressArrayWord,
  decodeUint256Word,
} from "./abi-decode";
import {
  decimalNumberFromBigInt,
  fetchJsonPostWithRetry,
  makeOnchainCallers,
  reserveDegradedWarning,
  requireOnchainInput,
} from "./helpers";
import {
  ERC4626_CONVERT_TO_ASSETS_SELECTOR,
} from "./erc4626";
import { parseBoundedDecimals, ratioFromRaw } from "./slice-math";
import { throwIfAborted } from "../../lib/abort";
import { observeSfrxusdCrosschainRedemptionRoute } from "./sfrxusd-crosschain-redemption";
import type { SfrxusdCrosschainV9RouteAttempt } from "../../lib/sfrxusd-crosschain-redemption-route";
import type { ExecutableRedemptionObservation } from "./executable-redemption-observers";

export type Erc4626RedemptionLiquidityConfig = NonNullable<
  LiveReserveAdapterParamsByKey["erc4626-single-asset"]["redemptionLiquidity"]
>;
type MorphoVaultV1RedemptionLiquidityConfig = Extract<Erc4626RedemptionLiquidityConfig, { source: "morpho-vault-v1" }>;
type MorphoVaultV2RedemptionLiquidityConfig = Extract<Erc4626RedemptionLiquidityConfig, { source: "morpho-vault-v2" }>;

type Erc4626CapacitySource =
  | "erc4626-idle-underlying"
  | "erc4626-atomic-full-backing"
  | "morpho-vault-v1-liquidity"
  | "morpho-vault-v2-liquidity"
  | "yearn-v3-withdrawable"
  | "sbold-sp-withdrawable"
  | "fraxtal-hop-withdrawable";

export interface RedemptionCapacityTelemetry {
  capacityUsd: number;
  capacityRaw: string;
  capacitySource:
    | Erc4626CapacitySource
    | ExecutableRedemptionObservation["capacitySource"];
  settlementBoundUnproven?: true;
  freshnessKind: "same-run-onchain" | "same-run-api";
  routeStatusSource: "onchain" | "protocol-api";
  idleUnderlyingBalanceRaw?: string;
  underlyingDecimals: number;
  capacityRatioOfSupply?: number;
  settlementDelaySec?: number;
  blockNumber?: number;
  sourceUrls?: string[];
  sourceTimestamp?: number;
  capacityKind?: "live-direct" | "live-direct-bounded" | "documented-bound";
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

type Erc4626CapacityRoute = Pick<
  RedemptionCapacityTelemetry,
  "freshnessKind" | "routeStatusSource" | "capacityKind" | "settlementDelaySec" |
    "blockNumber" | "sourceUrls" | "holderEligibility" | "routeStatus" | "routeStatusReason"
>;
type Erc4626CapacityDiagnostics = { capacityUnavailable?: true; liquidityUsd?: number; forceDeallocatableLiquidityRaw?: bigint; forceDeallocatableLiquidityUsd?: number; collateralHealthGate?: "open" | "restricted" | "unreadable" };

export type Erc4626CapacityObservation = {
  source: Erc4626CapacitySource;
  capacityRaw: bigint;
  underlyingDecimals: number;
  warnings: LiveReserveWarning[];
  route: Erc4626CapacityRoute;
  diagnostics: Record<string, unknown>;
  v9RouteAttempt?: SfrxusdCrosschainV9RouteAttempt;
};

export type Erc4626CapacityPauseProbe = { paused: boolean | null; shutdown: boolean | null };

export type ObserveConfiguredErc4626CapacityInput = {
  coinId: string;
  contractAddress: string;
  assetAddress: string;
  configured?: Erc4626RedemptionLiquidityConfig;
  idleCapacityRaw: bigint | null;
  underlyingDecimalsRaw: bigint | null;
  supplyAssetsRaw: bigint;
  call: (data: string) => Promise<string | null>;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcMode: ReturnType<typeof requireOnchainInput>["rpcMode"];
  chain: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  timeoutMs: number;
};
type OnchainProbeInput = Pick<ObserveConfiguredErc4626CapacityInput, "coinId" | "contractAddress" | "signal" | "ctx" | "rpcMode" | "chain" | "rpcUrl" | "fallbackRpcUrl" | "timeoutMs">;
type MorphoProbeInput = Pick<ObserveConfiguredErc4626CapacityInput, "coinId" | "contractAddress" | "assetAddress" | "signal" | "ctx">;

interface MorphoVaultWarning {
  type?: unknown;
  level?: unknown;
}

type MorphoV1Liquidity = { underlying?: unknown; usd?: unknown };
interface MorphoVault {
  address?: unknown;
  listed?: unknown;
  asset?: { address?: unknown } | null;
  chain?: { id?: unknown } | null;
  warnings?: MorphoVaultWarning[] | null;
  liquidity?: unknown;
  liquidityUsd?: unknown;
  forceDeallocatableLiquidity?: unknown;
  forceDeallocatableLiquidityUsd?: unknown;
}

type MorphoVaultResponse = {
  data?: { vaultByAddress?: MorphoVault | null; vaultV2ByAddress?: MorphoVault | null };
  errors?: unknown;
};
type ParsedMorphoVaultLiquidity = {
  liquidityRaw: bigint | null;
  liquidityUsd?: number;
  forceDeallocatableLiquidityRaw?: bigint;
  forceDeallocatableLiquidityUsd?: number;
};
type CapacityProbeResult = {
  capacityRaw: bigint | null;
  warnings: LiveReserveWarning[];
  route?: Erc4626CapacityRoute;
  diagnostics?: Record<string, unknown>;
};

const DEFAULT_MORPHO_GRAPHQL_URL = "https://api.morpho.org/graphql";
const YEARN_V3_TOTAL_IDLE_SELECTOR = "0x9aa7df94";
const YEARN_V3_GET_DEFAULT_QUEUE_SELECTOR = "0xa9bbf1cc";
const YEARN_V3_STRATEGIES_SELECTOR = "0x39ebf823";
const YEARN_V3_MAX_REDEEM_SELECTOR = "0xd905777e";
const MAX_YEARN_V3_QUEUE_LENGTH = 10;
// K3 sBOLD calcFragments() -> (totalBold, boldAmount, collValue, collInBold).
// Word index 1 (boldAmount) is the compounded BOLD across the vault's Liquity V2
// Stability Pools — the on-demand SP-withdrawable amount that sBOLD._maxWithdraw
// caps redemptions at, and which excludes not-yet-swapped collateral (index 3).
const SBOLD_CALC_FRAGMENTS_SELECTOR = "0x160b71df";
const SBOLD_CALC_FRAGMENTS_LIQUID_BOLD_WORD_INDEX = 1;
const SBOLD_CALC_FRAGMENTS_COLL_IN_BOLD_WORD_INDEX = 3;
// BaseSBold.maxCollInBold(); sBOLD._checkCollHealth() permits withdrawals only
// while calcFragments().collInBold <= this owner-configured threshold.
const SBOLD_MAX_COLL_IN_BOLD_SELECTOR = "0xbf2428e6";

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

function decodeErc20Decimals(raw: bigint | null): number | null {
  return raw == null ? null : parseBoundedDecimals(raw);
}

function routeForSource(source: Erc4626CapacitySource): Erc4626CapacityRoute {
  const api = source === "morpho-vault-v1-liquidity" || source === "morpho-vault-v2-liquidity";
  return { freshnessKind: api ? "same-run-api" : "same-run-onchain", routeStatusSource: api ? "protocol-api" : "onchain" };
}

function probeFailure(code: string, message: string): CapacityProbeResult {
  return {
    capacityRaw: null,
    warnings: [reserveDegradedWarning(code, message)],
  };
}

async function fetchYearnV3WithdrawableCapacity(input: OnchainProbeInput & { call: (data: string) => Promise<string | null>; settlementDelaySec?: number }): Promise<CapacityProbeResult> {
  const [totalIdleResult, defaultQueueResult] = await Promise.all([
    input.call(YEARN_V3_TOTAL_IDLE_SELECTOR),
    input.call(YEARN_V3_GET_DEFAULT_QUEUE_SELECTOR),
  ]);
  if (!totalIdleResult || !defaultQueueResult) {
    return probeFailure("yearn-v3-withdrawable-unavailable", `Yearn V3 withdrawable-capacity probes failed for ${input.coinId}`);
  }

  const defaultQueue = decodeStrictAddressArrayWord(defaultQueueResult, {
    maxItems: MAX_YEARN_V3_QUEUE_LENGTH,
  });
  const totalIdleRaw = decodeUint256Word(decodeAbiWordAt(totalIdleResult, 0));
  if (totalIdleRaw == null) {
    return probeFailure("yearn-v3-total-idle-malformed", `Yearn V3 totalIdle() could not be decoded for ${input.coinId}`);
  }
  if (defaultQueue == null) {
    return probeFailure("yearn-v3-default-queue-malformed", `Yearn V3 default withdrawal queue could not be decoded for ${input.coinId}`);
  }

  let withdrawableRaw = totalIdleRaw;
  const onchain = makeOnchainCallers(
    { chain: input.chain, rpcMode: input.rpcMode },
    {
      signal: input.signal,
      ctx: input.ctx,
      rpcUrl: input.rpcUrl,
      fallbackRpcUrl: input.fallbackRpcUrl,
      timeoutMs: input.timeoutMs,
    },
  );
  for (const strategyAddress of defaultQueue) {
    throwIfAborted(input.signal);
    const strategyParamsResult = await input.call(
      `${YEARN_V3_STRATEGIES_SELECTOR}${encodeAddress(strategyAddress)}`,
    );
    const currentDebtRaw = decodeUint256Word(decodeAbiWordAt(strategyParamsResult, 2));
    if (currentDebtRaw == null) {
      return probeFailure("yearn-v3-strategy-debt-unavailable", `Yearn V3 strategy debt could not be decoded for ${input.coinId} strategy ${strategyAddress}`);
    }
    if (currentDebtRaw === 0n) continue;

    const maxRedeemRaw = await onchain.uint256(
      strategyAddress,
      `${YEARN_V3_MAX_REDEEM_SELECTOR}${encodeAddress(input.contractAddress)}` as `0x${string}`,
    );
    if (maxRedeemRaw == null) {
      return probeFailure("yearn-v3-strategy-max-redeem-unavailable", `Yearn V3 strategy maxRedeem() failed for ${input.coinId} strategy ${strategyAddress}`);
    }
    if (maxRedeemRaw === 0n) continue;

    const strategyWithdrawableRaw = await onchain.uint256(
      strategyAddress,
      `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(maxRedeemRaw)}` as `0x${string}`,
    );
    if (strategyWithdrawableRaw == null) {
      return probeFailure("yearn-v3-strategy-convert-unavailable", `Yearn V3 strategy convertToAssets(maxRedeem) failed for ${input.coinId} strategy ${strategyAddress}`);
    }
    withdrawableRaw += strategyWithdrawableRaw > currentDebtRaw ? currentDebtRaw : strategyWithdrawableRaw;
  }

  return { capacityRaw: withdrawableRaw, warnings: [], route: { freshnessKind: "same-run-onchain", routeStatusSource: "onchain", settlementDelaySec: input.settlementDelaySec ?? 0 } };
}

async function fetchSboldSpWithdrawableCapacity(input: Pick<ObserveConfiguredErc4626CapacityInput, "coinId" | "call">): Promise<CapacityProbeResult> {
  const [result, maxCollInBoldResult] = await Promise.all([
    input.call(SBOLD_CALC_FRAGMENTS_SELECTOR),
    input.call(SBOLD_MAX_COLL_IN_BOLD_SELECTOR),
  ]);
  const withdrawableRaw = decodeUint256Word(
    decodeAbiWordAt(result, SBOLD_CALC_FRAGMENTS_LIQUID_BOLD_WORD_INDEX),
  );
  if (withdrawableRaw == null) {
    return probeFailure("sbold-sp-withdrawable-unavailable", `sBOLD calcFragments() Stability-Pool-withdrawable probe failed for ${input.coinId}`);
  }
  const collInBoldRaw = decodeUint256Word(
    decodeAbiWordAt(result, SBOLD_CALC_FRAGMENTS_COLL_IN_BOLD_WORD_INDEX),
  );
  const maxCollInBoldRaw = decodeUint256Word(decodeAbiWordAt(maxCollInBoldResult, 0));
  const collateralHealthGate =
    collInBoldRaw == null || maxCollInBoldRaw == null
      ? "unreadable"
      : collInBoldRaw <= maxCollInBoldRaw
        ? "open"
        : "restricted";
  return {
    capacityRaw: withdrawableRaw,
    warnings: [],
    route: routeForSource("sbold-sp-withdrawable"),
    diagnostics: { collateralHealthGate },
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

function parseMorphoAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function parseNonNegativeBigIntLike(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed >= 0n ? parsed : null;
}

function describeMorphoWarning(value: MorphoVaultWarning): string {
  const type = typeof value.type === "string" ? value.type : "unknown";
  const level = typeof value.level === "string" ? value.level : "unknown";
  return `${type}/${level}`;
}

function morphoFailure(
  input: { warningCodePrefix: string; versionLabel: string; coinId: string },
  code: string,
  detail: string,
): CapacityProbeResult {
  return probeFailure(
    `${input.warningCodePrefix}-${code}`,
    `${input.versionLabel} ${detail} for ${input.coinId}`,
  );
}

type MorphoQueryInput = MorphoProbeInput & {
  config: { chainId: number; apiUrl?: string };
  query: string;
  versionLabel: "Morpho V1" | "Morpho V2";
  warningCodePrefix: "morpho-vault-v1" | "morpho-vault-v2";
  extractVault: (payload: MorphoVaultResponse) => MorphoVault | null | undefined;
  parseLiquidity: (vault: MorphoVault) => ParsedMorphoVaultLiquidity;
};

async function fetchMorphoVaultLiquidity(input: MorphoQueryInput): Promise<CapacityProbeResult> {
  const apiUrl = input.config.apiUrl ?? DEFAULT_MORPHO_GRAPHQL_URL;
  try {
    const payload = await fetchJsonPostWithRetry<MorphoVaultResponse>(
      apiUrl,
      {
        query: input.query,
        variables: {
          address: input.contractAddress,
          chainId: input.config.chainId,
        },
      },
      input.signal,
      12_000,
      input.ctx,
      { headers: { Accept: "application/json" } },
    );
    if (payload.errors != null) {
      return morphoFailure(input, "liquidity-unavailable", "liquidity query returned GraphQL errors");
    }

    const vault = input.extractVault(payload);
    if (!vault) {
      return morphoFailure(input, "liquidity-unavailable", "liquidity query returned no vault");
    }
    if (parseMorphoAddress(vault.address) !== input.contractAddress.toLowerCase()) {
      return morphoFailure(input, "identity-mismatch", "liquidity vault address mismatch");
    }
    if (parseMorphoAddress(vault.asset?.address) !== input.assetAddress.toLowerCase()) {
      return morphoFailure(input, "asset-mismatch", "liquidity asset mismatch");
    }
    if (parseMorphoChainId(vault.chain?.id) !== input.config.chainId) {
      return morphoFailure(input, "chain-mismatch", "liquidity chain mismatch");
    }
    if (vault.listed !== true) {
      return morphoFailure(input, "unlisted", "liquidity vault is not listed");
    }
    if (vault.warnings?.length) {
      const warningList = vault.warnings.map(describeMorphoWarning).join(", ");
      return probeFailure(
        `${input.warningCodePrefix}-warning`,
        `${input.versionLabel} liquidity vault warnings for ${input.coinId}: ${warningList}`,
      );
    }

    const liquidity = input.parseLiquidity(vault);
    if (liquidity.liquidityRaw == null) {
      return morphoFailure(input, "liquidity-invalid", "liquidity payload has invalid liquidity");
    }
    return {
      capacityRaw: liquidity.liquidityRaw,
      warnings: [],
      route: routeForSource(
        input.warningCodePrefix === "morpho-vault-v1"
          ? "morpho-vault-v1-liquidity"
          : "morpho-vault-v2-liquidity",
      ),
      diagnostics: {
        ...(liquidity.liquidityUsd != null ? { liquidityUsd: liquidity.liquidityUsd } : {}),
        ...(liquidity.forceDeallocatableLiquidityRaw != null
          ? { forceDeallocatableLiquidityRaw: liquidity.forceDeallocatableLiquidityRaw }
          : {}),
        ...(liquidity.forceDeallocatableLiquidityUsd != null
          ? { forceDeallocatableLiquidityUsd: liquidity.forceDeallocatableLiquidityUsd }
          : {}),
      },
    };
  } catch (error) {
    return probeFailure(`${input.warningCodePrefix}-liquidity-unavailable`, `${input.versionLabel} liquidity fetch failed for ${input.coinId}: ${toErrorMessage(error)}`);
  }
}

function fetchMorphoVaultV2Liquidity(
  input: MorphoProbeInput & { config: MorphoVaultV2RedemptionLiquidityConfig },
): Promise<CapacityProbeResult> {
  return fetchMorphoVaultLiquidity({
    ...input,
    query: MORPHO_VAULT_V2_LIQUIDITY_QUERY,
    versionLabel: "Morpho V2",
    warningCodePrefix: "morpho-vault-v2",
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

function fetchMorphoVaultV1Liquidity(
  input: MorphoProbeInput & { config: MorphoVaultV1RedemptionLiquidityConfig },
): Promise<CapacityProbeResult> {
  return fetchMorphoVaultLiquidity({
    ...input,
    query: MORPHO_VAULT_V1_LIQUIDITY_QUERY,
    versionLabel: "Morpho V1",
    warningCodePrefix: "morpho-vault-v1",
    extractVault: (payload) => payload.data?.vaultByAddress,
    parseLiquidity: (vault) => {
      const liquidity = vault.liquidity as MorphoV1Liquidity | null | undefined;
      const liquidityUsd = parseOptionalNonNegativeNumber(liquidity?.usd);
      return {
        liquidityRaw: parseNonNegativeBigIntLike(liquidity?.underlying),
        ...(liquidityUsd != null ? { liquidityUsd } : {}),
      };
    },
  });
}

function makeObservation(
  source: Erc4626CapacitySource,
  capacityRaw: bigint,
  underlyingDecimals: number,
  warnings: LiveReserveWarning[] = [],
  route: Erc4626CapacityRoute = routeForSource(source),
  diagnostics: Record<string, unknown> = {},
  v9RouteAttempt?: SfrxusdCrosschainV9RouteAttempt,
): Erc4626CapacityObservation {
  return {
    source,
    capacityRaw,
    underlyingDecimals,
    warnings,
    route,
    diagnostics,
    ...(v9RouteAttempt ? { v9RouteAttempt } : {}),
  };
}

function makeUnavailableObservation(
  source: Erc4626CapacitySource,
  idleCapacityRaw: bigint | null,
  underlyingDecimals: number | null,
  warnings: LiveReserveWarning[],
  route?: Erc4626CapacityRoute,
  v9RouteAttempt?: SfrxusdCrosschainV9RouteAttempt,
): Erc4626CapacityObservation {
  if (idleCapacityRaw != null && underlyingDecimals != null) {
    return makeObservation("erc4626-idle-underlying", idleCapacityRaw, underlyingDecimals, warnings, undefined, undefined, v9RouteAttempt);
  }
  return makeObservation(source, 0n, underlyingDecimals ?? 0, warnings, route, { capacityUnavailable: true }, v9RouteAttempt);
}

export async function observeConfiguredErc4626Capacity(
  input: ObserveConfiguredErc4626CapacityInput,
): Promise<Erc4626CapacityObservation | null> {
  const configured = input.configured;
  if (!configured) {
    const underlyingDecimals = decodeErc20Decimals(input.underlyingDecimalsRaw);
    return input.idleCapacityRaw != null && underlyingDecimals != null
      ? makeObservation("erc4626-idle-underlying", input.idleCapacityRaw, underlyingDecimals)
      : null;
  }

  if (configured.source === "atomic-full-backing") {
    const underlyingDecimals = decodeErc20Decimals(input.underlyingDecimalsRaw);
    return makeObservation(
      "erc4626-atomic-full-backing",
      input.supplyAssetsRaw,
      underlyingDecimals ?? 0,
      [],
      undefined,
      underlyingDecimals == null ? { capacityUnavailable: true } : {},
    );
  }

  if (configured.source === "fraxtal-hop-withdrawable") {
    const attempt = await observeSfrxusdCrosschainRedemptionRoute(
      configured,
      input.contractAddress,
      input.signal,
      input.ctx,
      {
        ethereumRpcUrls: [input.rpcUrl, input.fallbackRpcUrl].filter(
          (url): url is string => Boolean(url),
        ),
      },
    );
    if (attempt.status === "accepted") {
      return makeObservation(
        "fraxtal-hop-withdrawable",
        BigInt(attempt.state.capacity.cappedPreviewOutputFrxUsdRaw),
        18,
        [],
        {
          freshnessKind: "same-run-onchain",
          routeStatusSource: "onchain",
          capacityKind: "live-direct-bounded",
          blockNumber: attempt.state.fraxtalBlock.blockNumber,
          sourceUrls: attempt.state.sourceUrls,
          holderEligibility: "any-holder",
          routeStatus: "open",
        },
        {},
        attempt,
      );
    }
    return makeUnavailableObservation(
      "fraxtal-hop-withdrawable",
      input.idleCapacityRaw,
      18,
      [
        reserveDegradedWarning(
          `sfrxusd-crosschain-redemption-${attempt.rejectionCode}`,
          `sfrxUSD cross-chain redemption route validation failed closed: ${attempt.rejectionCode}`,
        ),
      ],
      routeForSource("fraxtal-hop-withdrawable"),
      attempt,
    );
  }

  let probe: CapacityProbeResult;
  if (configured.source === "morpho-vault-v2") {
    probe = await fetchMorphoVaultV2Liquidity({ ...input, config: configured });
  } else if (configured.source === "morpho-vault-v1") {
    probe = await fetchMorphoVaultV1Liquidity({ ...input, config: configured });
  } else if (configured.source === "yearn-v3-withdrawable") {
    probe = await fetchYearnV3WithdrawableCapacity({
      ...input,
      settlementDelaySec: configured.settlementDelaySec,
    });
  } else {
    probe = await fetchSboldSpWithdrawableCapacity(input);
  }

  const underlyingDecimals = decodeErc20Decimals(input.underlyingDecimalsRaw);
  const source: Erc4626CapacitySource =
    configured.source === "morpho-vault-v1"
      ? "morpho-vault-v1-liquidity"
      : configured.source === "morpho-vault-v2"
        ? "morpho-vault-v2-liquidity"
        : configured.source;
  if (probe.capacityRaw != null && underlyingDecimals != null) {
    return makeObservation(source, probe.capacityRaw, underlyingDecimals, [], probe.route, probe.diagnostics);
  }

  return makeUnavailableObservation(source, input.idleCapacityRaw, underlyingDecimals, probe.warnings, probe.route);
}

const ROUTE_OPEN_REASON_BY_CAPACITY_SOURCE: Partial<Record<Erc4626CapacitySource, string>> = {
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
  capacitySource: Erc4626CapacitySource,
  capacityRaw: bigint,
  pauseProbe: Erc4626CapacityPauseProbe,
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
  if (capacityRaw <= 0n) return {};
  if (capacitySource === "yearn-v3-withdrawable" && pauseProbe.shutdown !== false) return {};
  const routeStatusReason = ROUTE_OPEN_REASON_BY_CAPACITY_SOURCE[capacitySource];
  return routeStatusReason ? { routeStatus: "open", routeStatusReason } : {};
}

export function buildExecutableRedemptionCapacityTelemetry(
  observation: ExecutableRedemptionObservation,
  supplyAssetsRaw: bigint,
): RedemptionCapacityTelemetry | null {
  const capacityRaw =
    observation.capacityRaw > supplyAssetsRaw ? supplyAssetsRaw : observation.capacityRaw;
  const capacityUsd = decimalNumberFromBigInt(capacityRaw, observation.underlyingDecimals);
  if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;
  const capacityRatioOfSupply = ratioFromRaw(capacityRaw, supplyAssetsRaw);
  return {
    capacityUsd,
    capacityRaw: capacityRaw.toString(),
    capacitySource: observation.capacitySource,
    ...(observation.settlementBoundUnproven ? { settlementBoundUnproven: true } : {}),
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

export function finalizeErc4626RedemptionCapacity(input: {
  supplyAssetsRaw: bigint;
  idleCapacityRaw: bigint | null;
  configured: Erc4626CapacityObservation | null;
  pause: Erc4626CapacityPauseProbe;
}): RedemptionCapacityTelemetry | null {
  const { configured } = input;
  if (!configured || configured.diagnostics.capacityUnavailable === true) return null;

  const { supplyAssetsRaw, idleCapacityRaw, pause } = input;
  const underlyingDecimals = configured.underlyingDecimals;
  if (configured.source === "erc4626-atomic-full-backing") {
    const capacityUsd = decimalNumberFromBigInt(supplyAssetsRaw, underlyingDecimals);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;
    const capacityRatioOfSupply = ratioFromRaw(supplyAssetsRaw, supplyAssetsRaw);
    return {
      capacityUsd,
      capacityRaw: supplyAssetsRaw.toString(),
      capacitySource: "erc4626-atomic-full-backing",
      freshnessKind: "same-run-onchain",
      routeStatusSource: "onchain",
      ...(idleCapacityRaw != null ? { idleUnderlyingBalanceRaw: idleCapacityRaw.toString() } : {}),
      underlyingDecimals,
      ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
      ...resolveRouteOpenness("erc4626-atomic-full-backing", supplyAssetsRaw, pause),
    };
  }

  const idleRaw = idleCapacityRaw ?? 0n;
  let capacitySource: Erc4626CapacitySource = "erc4626-idle-underlying";
  let uncappedCapacityRaw = idleRaw;
  if (
    configured.source !== "erc4626-idle-underlying" &&
    configured.capacityRaw > uncappedCapacityRaw
  ) {
    capacitySource = configured.source;
    uncappedCapacityRaw = configured.capacityRaw;
  }
  const capacityRaw = uncappedCapacityRaw > supplyAssetsRaw ? supplyAssetsRaw : uncappedCapacityRaw;
  const capacityUsd = decimalNumberFromBigInt(capacityRaw, underlyingDecimals);
  if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

  const capacityRatioOfSupply = ratioFromRaw(capacityRaw, supplyAssetsRaw);
  const usesProtocolApiCapacity =
    capacitySource === "morpho-vault-v1-liquidity" ||
    capacitySource === "morpho-vault-v2-liquidity";
  const usesYearnV3Capacity = capacitySource === "yearn-v3-withdrawable";
  const usesSboldSpWithdrawable =
    configured.source === "sbold-sp-withdrawable";
  const usesSfrxusdCrosschainCapacity = capacitySource === "fraxtal-hop-withdrawable";
  const defaultRouteOpenness = resolveRouteOpenness(capacitySource, capacityRaw, pause);
  const diagnostics = configured.diagnostics as Erc4626CapacityDiagnostics;
  const sboldRouteOpenness =
    usesSboldSpWithdrawable && pause.paused !== true
      ? diagnostics.collateralHealthGate === "restricted"
        ? {
            routeStatus: "degraded" as const,
            routeStatusReason:
              "sBOLD collateral in BOLD exceeds maxCollInBold; _maxWithdraw() and _maxRedeem() return zero",
          }
        : diagnostics.collateralHealthGate === "open" && capacityRaw > 0n
          ? {
              routeStatus: "open" as const,
              routeStatusReason:
                "sBOLD Stability Pool withdrawable BOLD positive and collateral-health gate open on-chain this run",
            }
          : defaultRouteOpenness
      : defaultRouteOpenness;
  const route = configured.route;
  return {
    capacityUsd,
    capacityRaw: capacityRaw.toString(),
    capacitySource,
    freshnessKind: usesProtocolApiCapacity ? "same-run-api" : "same-run-onchain",
    routeStatusSource: usesProtocolApiCapacity ? "protocol-api" : "onchain",
    ...(idleCapacityRaw != null ? { idleUnderlyingBalanceRaw: idleCapacityRaw.toString() } : {}),
    underlyingDecimals,
    ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
    ...sboldRouteOpenness,
    ...(usesSboldSpWithdrawable
      ? {
          capacityKind:
            diagnostics.collateralHealthGate === "open"
              ? "live-direct" as const
              : "documented-bound" as const,
        }
      : {}),
    ...(usesYearnV3Capacity
      ? {
          settlementDelaySec: route.settlementDelaySec,
          yearnV3WithdrawableRaw: configured.capacityRaw.toString(),
        }
      : {}),
    ...(capacitySource === "sbold-sp-withdrawable"
      ? { sboldSpWithdrawableRaw: configured.capacityRaw.toString() }
      : {}),
    ...(usesSfrxusdCrosschainCapacity
      ? {
          capacityKind: route.capacityKind ?? "live-direct-bounded" as const,
          blockNumber: route.blockNumber,
          sourceUrls: route.sourceUrls,
          holderEligibility: route.holderEligibility,
          routeStatus: "open" as const,
          sfrxusdCrosschainWithdrawableRaw: configured.capacityRaw.toString(),
        }
      : {}),
    ...(configured.source === "morpho-vault-v1-liquidity"
      ? {
          morphoVaultV1LiquidityRaw: configured.capacityRaw.toString(),
          ...(diagnostics.liquidityUsd != null
            ? { morphoVaultV1LiquidityUsd: diagnostics.liquidityUsd }
            : {}),
        }
      : {}),
    ...(configured.source === "morpho-vault-v2-liquidity"
      ? {
          morphoVaultV2LiquidityRaw: configured.capacityRaw.toString(),
          ...(diagnostics.liquidityUsd != null
            ? { morphoVaultV2LiquidityUsd: diagnostics.liquidityUsd }
            : {}),
          ...(diagnostics.forceDeallocatableLiquidityRaw != null
            ? {
                morphoVaultV2ForceDeallocatableLiquidityRaw:
                  diagnostics.forceDeallocatableLiquidityRaw.toString(),
              }
            : {}),
          ...(diagnostics.forceDeallocatableLiquidityUsd != null
            ? {
                morphoVaultV2ForceDeallocatableLiquidityUsd:
                  diagnostics.forceDeallocatableLiquidityUsd,
              }
            : {}),
        }
      : {}),
  };
}

export function projectErc4626RedemptionMetadata(
  telemetry: RedemptionCapacityTelemetry,
): Record<string, unknown> {
  return {
    redemptionCapacityRaw: telemetry.capacityRaw,
    redemptionCapacitySource: telemetry.capacitySource,
    ...(telemetry.idleUnderlyingBalanceRaw != null ? { idleUnderlyingBalanceRaw: telemetry.idleUnderlyingBalanceRaw } : {}),
    underlyingDecimals: telemetry.underlyingDecimals,
    ...(telemetry.morphoVaultV1LiquidityRaw != null ? { morphoVaultV1LiquidityRaw: telemetry.morphoVaultV1LiquidityRaw } : {}),
    ...(telemetry.morphoVaultV1LiquidityUsd != null ? { morphoVaultV1LiquidityUsd: telemetry.morphoVaultV1LiquidityUsd } : {}),
    ...(telemetry.yearnV3WithdrawableRaw != null ? { yearnV3WithdrawableRaw: telemetry.yearnV3WithdrawableRaw } : {}),
    ...(telemetry.sboldSpWithdrawableRaw != null ? { sboldSpWithdrawableRaw: telemetry.sboldSpWithdrawableRaw } : {}),
    ...(telemetry.sfrxusdCrosschainWithdrawableRaw != null ? { sfrxusdCrosschainWithdrawableRaw: telemetry.sfrxusdCrosschainWithdrawableRaw } : {}),
    ...(telemetry.morphoVaultV2LiquidityRaw != null ? { morphoVaultV2LiquidityRaw: telemetry.morphoVaultV2LiquidityRaw } : {}),
    ...(telemetry.morphoVaultV2LiquidityUsd != null ? { morphoVaultV2LiquidityUsd: telemetry.morphoVaultV2LiquidityUsd } : {}),
    ...(telemetry.morphoVaultV2ForceDeallocatableLiquidityRaw != null ? { morphoVaultV2ForceDeallocatableLiquidityRaw: telemetry.morphoVaultV2ForceDeallocatableLiquidityRaw } : {}),
    ...(telemetry.morphoVaultV2ForceDeallocatableLiquidityUsd != null ? { morphoVaultV2ForceDeallocatableLiquidityUsd: telemetry.morphoVaultV2ForceDeallocatableLiquidityUsd } : {}),
    ...(telemetry.feeBps != null ? { redemptionFeeBps: telemetry.feeBps } : {}),
  };
}
