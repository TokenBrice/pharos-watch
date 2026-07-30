import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { rethrowIfAborted } from "../../lib/abort";
import { encodeBalanceOfCallData, encodeUint256 } from "../../lib/evm-selectors";
import {
  fetchEvmBlockNumber,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  fetchEvmStorageAtBlock,
} from "../../lib/evm-rpc";
import {
  buildRedemptionSnapshotMetadata,
  fetchJsonWithRetry,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveInfoWarning,
  verifiedFreshnessMetadata,
} from "./helpers";
import { decodeAddressWord, decodeBoolWord, decodeUint256Word } from "./abi-decode";
import { runAdapterIo } from "./concurrency";
import { normalizeEvmAddress, resolveCoinContractAddress } from "./evm";
import { fetchOnchainMulticall3, fetchOnchainUint256 } from "./onchain";
import { EIP1967_BEACON_SLOT, multicallResultByLabel, runtimeCodeHash } from "./onchain-identity";

interface MakinaStrategyEnvelope {
  data?: MakinaStrategyData;
  meta?: {
    generated_at?: unknown;
  };
}

interface MakinaStrategyData {
  address?: unknown;
  aum?: unknown;
  lastReportedAum?: unknown;
  sharePrice?: unknown;
  shareSupply?: unknown;
  shareLimit?: unknown;
  apy7d?: unknown;
  apy30d?: unknown;
  accountingToken?: MakinaToken;
  shareToken?: MakinaToken;
  ntt?: unknown;
}

interface MakinaAllocationsEnvelope {
  data?: {
    base_tokens?: unknown;
    positions?: unknown;
    groups?: unknown;
    stats?: unknown;
  };
  meta?: {
    generated_at?: unknown;
  };
}

interface MakinaToken {
  address?: unknown;
  chainId?: unknown;
  name?: unknown;
  symbol?: unknown;
  decimals?: unknown;
}

interface MakinaBaseToken {
  balance?: unknown;
  type?: unknown;
  protocol?: unknown;
  token?: MakinaToken;
  accounting_token_value?: unknown;
  accounting_token?: MakinaToken;
  percentage?: unknown;
}

interface MakinaPosition {
  id?: unknown;
  value?: unknown;
  created_at_block?: unknown;
  created_at?: unknown;
  updated_at_block?: unknown;
  updated_at?: unknown;
  chain_id?: unknown;
  protocol?: unknown;
  market_id?: unknown;
  strategy?: unknown;
  type?: unknown;
  is_debt?: unknown;
  token?: MakinaToken;
  group?: unknown;
  percentage?: unknown;
}

type MakinaBucketKind = "protocol" | "base-token" | "unknown" | "other";

interface MakinaBucketValue {
  key: string;
  name: string;
  value: number;
  risk: ReserveSlice["risk"];
  kind: MakinaBucketKind;
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

interface MakinaStrategyParams {
  allocationsUrl: string;
  machineAddress: string;
  asyncRedeemerAddress?: string;
  accountingTokenSymbol?: string;
  accountingTokenDecimals?: number;
  otherThresholdPct?: number;
  reconciliationTolerancePct?: number;
}

export interface MakinaRedemptionState {
  whitelistEnabled: boolean;
  minimumFinalizationDelaySec: number;
  nextRequestId: number;
  lastFinalizedRequestId: number;
  pendingRequestCount: number;
  lockedShares: number;
  grossIdleCapacityUsd: number;
  queueDepthUsd: number;
  reservedUnclaimedUsdc: number;
  minimumRedeemShares: number;
  capacityUsd: number;
  blockNumber: number;
  asyncRedeemerAddress: string;
  implementationAddress: string;
  implementationRuntimeCodeHash: string;
}

interface MakinaRedemptionRead {
  state: MakinaRedemptionState | null;
  warning?: LiveReserveWarning;
}

const DEFAULT_ACCOUNTING_DECIMALS = 6;
const DEFAULT_OTHER_THRESHOLD_PCT = 2;
const DEFAULT_RECONCILIATION_TOLERANCE_PCT = 0.5;
const ETHEREUM_CHAIN = "ethereum";
const CANONICAL_ETHEREUM_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const REVIEWED_ASYNC_REDEEMER_IMPLEMENTATION = "0xd53dc14e0f268494c7540153126d78e4f54cc01c";
const REVIEWED_ASYNC_REDEEMER_IMPLEMENTATION_CODE_HASH =
  "0xeed090b1c06e966eebca301a1fed3f0c152044c04912d8b5d7e7c934fa3a192a";
const REDEEMER_MACHINE_SELECTOR = "0x75c60225";
const MACHINE_ACCOUNTING_TOKEN_SELECTOR = "0xda68cf8b";
const MACHINE_SHARE_TOKEN_SELECTOR = "0x6c9fa59e";
const IS_WHITELIST_ENABLED_SELECTOR = "0x184d69ab";
const FINALIZATION_DELAY_SELECTOR = "0xf9823a5c";
const NEXT_REQUEST_ID_SELECTOR = "0x6a84a985";
const LAST_FINALIZED_REQUEST_ID_SELECTOR = "0x667a739e";
const MIN_REDEEM_AMOUNT_SELECTOR = "0x0912ae6d";
const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";
const BEACON_IMPLEMENTATION_SELECTOR = "0x5c60da1b";

function readParams(config: LiveReservesConfig): MakinaStrategyParams {
  return parseLiveReserveAdapterParams("makina-strategy", config.params);
}

function readSafeOnchainNumber(value: bigint | null): number | null {
  if (value == null || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function decimalNumberFromRaw(value: bigint, decimals: number): number | null {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36 || value < 0n) return null;
  const raw = value.toString();
  const integerDigits = decimals === 0 ? raw : raw.slice(0, -decimals) || "0";
  const fractionalDigits = decimals === 0 ? "" : raw.slice(-decimals).padStart(decimals, "0").replace(/0+$/, "");
  const parsed = Number(fractionalDigits ? `${integerDigits}.${fractionalDigits}` : integerDigits);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function redemptionTelemetryUnavailable(message: string): MakinaRedemptionRead {
  return {
    state: null,
    warning: reserveInfoWarning("makina-redemption-telemetry-unavailable", message),
  };
}

export function buildMakinaRedemptionMetadata(state: MakinaRedemptionState) {
  return {
    ...buildRedemptionSnapshotMetadata({
      capacityUsd: state.capacityUsd,
      capacityKind: "live-queue",
      freshnessKind: "same-run-onchain",
      blockNumber: state.blockNumber,
      holderEligibility: "issuer-discretionary",
      queueDepthUsd: state.queueDepthUsd,
      routeStatus: "open",
      routeStatusSource: "onchain",
      routeStatusReason: state.whitelistEnabled
        ? "AsyncRedeemer whitelist is enabled; Pharos models the route as issuer-discretionary access rather than impaired"
        : "AsyncRedeemer whitelist is disabled",
      sourceUrls: [
        "https://docs.makina.finance/concepts/architecture/machine/redemptions",
        `https://eth.blockscout.com/address/${state.asyncRedeemerAddress}?tab=contract`,
        `https://eth.blockscout.com/address/${state.implementationAddress}?tab=contract`,
      ],
    }),
    redemptionQueue: {
      nextRequestId: state.nextRequestId,
      lastFinalizedRequestId: state.lastFinalizedRequestId,
      unfinalizedRequestSpan: state.pendingRequestCount,
      pendingRequestCount: state.pendingRequestCount,
      minimumFinalizationDelaySec: state.minimumFinalizationDelaySec,
      minimumRedeemShares: state.minimumRedeemShares,
      lockedShares: state.lockedShares,
      grossIdleCapacityUsd: state.grossIdleCapacityUsd,
      queueDepthUsd: state.queueDepthUsd,
      reservedUnclaimedUsdc: state.reservedUnclaimedUsdc,
      usableCapacityFormula: "max(0, Machine idle Ethereum USDC - convertToAssets(DUSD locked in AsyncRedeemer))",
      capacityBasis: "live-proxy-buffer",
      implementationAddress: state.implementationAddress,
      implementationRuntimeCodeHash: state.implementationRuntimeCodeHash,
    },
  };
}

async function fetchMakinaRedemptionState(
  coin: StablecoinMeta,
  params: MakinaStrategyParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<MakinaRedemptionRead> {
  if (!params.asyncRedeemerAddress) return { state: null };

  try {
    const machineAddress = normalizeEvmAddress(params.machineAddress);
    const asyncRedeemerAddress = normalizeEvmAddress(params.asyncRedeemerAddress);
    const shareTokenAddress = normalizeEvmAddress(resolveCoinContractAddress(coin, ETHEREUM_CHAIN) ?? undefined);
    if (!machineAddress || !asyncRedeemerAddress || !shareTokenAddress) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry skipped: missing reviewed Ethereum addresses");
    }

    const rpcOptions = {
      signal,
      timeoutMs: 10_000,
      chainRpcs: ctx?.chainRpcs,
    };
    const blockNumber = await runAdapterIo(
      ctx,
      "makina-redemption-block:ethereum",
      () => fetchEvmBlockNumber(ETHEREUM_CHAIN, rpcOptions),
      { signal },
    );
    if (blockNumber == null) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: Ethereum block pin failed");
    }

    const [reads, beaconSlot] = await Promise.all([
      fetchOnchainMulticall3({
        chain: ETHEREUM_CHAIN,
        signal,
        ctx,
        blockNumberOrTag: blockNumber,
        calls: [
          { label: "redeemer-machine", contract: asyncRedeemerAddress, data: REDEEMER_MACHINE_SELECTOR },
          { label: "machine-accounting-token", contract: machineAddress, data: MACHINE_ACCOUNTING_TOKEN_SELECTOR },
          { label: "machine-share-token", contract: machineAddress, data: MACHINE_SHARE_TOKEN_SELECTOR },
          { label: "machine-idle-usdc", contract: CANONICAL_ETHEREUM_USDC, data: encodeBalanceOfCallData(machineAddress) },
          { label: "redeemer-locked-shares", contract: shareTokenAddress, data: encodeBalanceOfCallData(asyncRedeemerAddress) },
          { label: "redeemer-reserved-usdc", contract: CANONICAL_ETHEREUM_USDC, data: encodeBalanceOfCallData(asyncRedeemerAddress) },
          { label: "redeemer-whitelist", contract: asyncRedeemerAddress, data: IS_WHITELIST_ENABLED_SELECTOR },
          { label: "redeemer-finalization-delay", contract: asyncRedeemerAddress, data: FINALIZATION_DELAY_SELECTOR },
          { label: "redeemer-next-request-id", contract: asyncRedeemerAddress, data: NEXT_REQUEST_ID_SELECTOR },
          { label: "redeemer-last-finalized-request-id", contract: asyncRedeemerAddress, data: LAST_FINALIZED_REQUEST_ID_SELECTOR },
          { label: "redeemer-min-redeem-amount", contract: asyncRedeemerAddress, data: MIN_REDEEM_AMOUNT_SELECTOR },
        ],
      }),
      runAdapterIo(
        ctx,
        `makina-redemption-beacon-slot:${asyncRedeemerAddress}`,
        () => fetchEvmStorageAtBlock(ETHEREUM_CHAIN, asyncRedeemerAddress, EIP1967_BEACON_SLOT, blockNumber, rpcOptions),
        { signal },
      ),
    ]);
    if (!reads) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: same-block route state read failed");
    }

    const redeemerMachine = decodeAddressWord(multicallResultByLabel(reads, "redeemer-machine"));
    if (redeemerMachine !== machineAddress) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: redeemer machine() does not match the configured Machine");
    }
    const accountingToken = decodeAddressWord(multicallResultByLabel(reads, "machine-accounting-token"));
    if (accountingToken !== CANONICAL_ETHEREUM_USDC) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: Machine accounting token is not canonical Ethereum USDC");
    }
    const shareToken = decodeAddressWord(multicallResultByLabel(reads, "machine-share-token"));
    if (shareToken !== shareTokenAddress) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: Machine share token does not match the tracked DUSD contract");
    }

    const beaconAddress = decodeAddressWord(beaconSlot);
    if (!beaconAddress) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: AsyncRedeemer proxy beacon was not resolved");
    }
    const implementationRaw = await runAdapterIo(
      ctx,
      `makina-redemption-beacon-implementation:${beaconAddress}`,
      () => fetchEvmCallHexAtBlock(
        ETHEREUM_CHAIN,
        beaconAddress,
        BEACON_IMPLEMENTATION_SELECTOR,
        blockNumber,
        rpcOptions,
      ),
      { signal },
    );
    const implementationAddress = decodeAddressWord(implementationRaw);
    if (implementationAddress !== REVIEWED_ASYNC_REDEEMER_IMPLEMENTATION) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: proxy implementation changed from the reviewed standard AsyncRedeemer");
    }
    const implementationCode = await runAdapterIo(
      ctx,
      `makina-redemption-implementation-code:${implementationAddress}`,
      () => fetchEvmCodeAtBlock(ETHEREUM_CHAIN, implementationAddress, blockNumber, rpcOptions),
      { signal },
    );
    const implementationRuntimeCodeHash = runtimeCodeHash(implementationCode);
    if (implementationRuntimeCodeHash !== REVIEWED_ASYNC_REDEEMER_IMPLEMENTATION_CODE_HASH) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry withheld: reviewed AsyncRedeemer runtime code hash did not match");
    }

    const lockedSharesRaw = decodeUint256Word(multicallResultByLabel(reads, "redeemer-locked-shares"));
    if (lockedSharesRaw == null) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: locked DUSD share balance read failed");
    }
    const queueDepthRaw = await fetchOnchainUint256({
      contract: machineAddress,
      data: `${CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(lockedSharesRaw)}`,
      signal,
      ctx,
      chain: ETHEREUM_CHAIN,
      blockNumberOrTag: blockNumber,
    });
    if (queueDepthRaw == null) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: queued-share liability conversion failed");
    }

    const whitelistEnabled = decodeBoolWord(multicallResultByLabel(reads, "redeemer-whitelist"));
    const minimumFinalizationDelaySec = readSafeOnchainNumber(decodeUint256Word(
      multicallResultByLabel(reads, "redeemer-finalization-delay"),
    ));
    const nextRequestId = readSafeOnchainNumber(decodeUint256Word(
      multicallResultByLabel(reads, "redeemer-next-request-id"),
    ));
    const lastFinalizedRequestId = readSafeOnchainNumber(decodeUint256Word(
      multicallResultByLabel(reads, "redeemer-last-finalized-request-id"),
    ));
    const minimumRedeemRaw = decodeUint256Word(multicallResultByLabel(reads, "redeemer-min-redeem-amount"));
    const machineIdleRaw = decodeUint256Word(multicallResultByLabel(reads, "machine-idle-usdc"));
    const reservedUnclaimedRaw = decodeUint256Word(multicallResultByLabel(reads, "redeemer-reserved-usdc"));
    if (
      whitelistEnabled == null ||
      minimumFinalizationDelaySec == null ||
      nextRequestId == null ||
      lastFinalizedRequestId == null ||
      minimumRedeemRaw == null ||
      machineIdleRaw == null ||
      reservedUnclaimedRaw == null ||
      lastFinalizedRequestId >= nextRequestId
    ) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: route counters or balances failed validation");
    }

    const accountingDecimals = params.accountingTokenDecimals ?? DEFAULT_ACCOUNTING_DECIMALS;
    const grossIdleCapacityUsd = decimalNumberFromRaw(machineIdleRaw, accountingDecimals);
    const queueDepthUsd = decimalNumberFromRaw(queueDepthRaw, accountingDecimals);
    const reservedUnclaimedUsdc = decimalNumberFromRaw(reservedUnclaimedRaw, accountingDecimals);
    const lockedShares = decimalNumberFromRaw(lockedSharesRaw, 18);
    const minimumRedeemShares = decimalNumberFromRaw(minimumRedeemRaw, 18);
    if (
      grossIdleCapacityUsd == null ||
      queueDepthUsd == null ||
      reservedUnclaimedUsdc == null ||
      lockedShares == null ||
      minimumRedeemShares == null
    ) {
      return redemptionTelemetryUnavailable("Makina AsyncRedeemer telemetry unavailable: route amounts failed decimal normalization");
    }

    return {
      state: {
        whitelistEnabled,
        minimumFinalizationDelaySec,
        nextRequestId,
        lastFinalizedRequestId,
        pendingRequestCount: nextRequestId - lastFinalizedRequestId - 1,
        lockedShares,
        grossIdleCapacityUsd,
        queueDepthUsd,
        reservedUnclaimedUsdc,
        minimumRedeemShares,
        capacityUsd: Math.max(0, grossIdleCapacityUsd - queueDepthUsd),
        blockNumber,
        asyncRedeemerAddress,
        implementationAddress,
        implementationRuntimeCodeHash,
      },
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return redemptionTelemetryUnavailable(
      `Makina AsyncRedeemer telemetry unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringLike(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`makina-strategy invalid ${label}`);
}

function readPositiveNumber(value: unknown, label: string): number {
  const parsed = readNumber(value, label);
  if (parsed <= 0) throw new Error(`makina-strategy ${label} must be positive`);
  return parsed;
}

function readNonNegativeAccountingValue(value: unknown, decimals: number, label: string): number {
  const raw = readString(value);
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(`makina-strategy invalid ${label}`);
  }
  const integerDigits = decimals === 0 ? raw : raw.slice(0, -decimals) || "0";
  const fractionalDigits = decimals === 0 ? "" : raw.slice(-decimals).padStart(decimals, "0");
  const parsed = Number(`${integerDigits}.${fractionalDigits}`);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`makina-strategy invalid ${label}`);
  }
  return parsed;
}

function readTimestamp(value: unknown, label: string): number {
  const parsed = parseTimestampLikeToUnixSeconds(value);
  if (parsed == null || parsed <= 0) {
    throw new Error(`makina-strategy invalid ${label}`);
  }
  return parsed;
}

function tokenSymbol(token: MakinaToken | undefined): string | null {
  return readString(token?.symbol);
}

function protocolKey(protocol: unknown): string | null {
  const raw = readString(protocol);
  return raw ? raw.toLowerCase() : null;
}

function displayProtocol(protocol: string): string {
  switch (protocol) {
    case "aave-v3":
      return "Aave V3 positions";
    case "aave-v4":
      return "Aave V4 positions";
    case "morpho":
      return "Morpho lending positions";
    case "pareto":
      return "Pareto / FalconX credit exposure";
    case "pendle":
      return "Pendle positions";
    case "re":
      return "Re Protocol exposure";
    case "royco":
      return "Royco incentive positions";
    default:
      return `${protocol} positions`;
  }
}

function protocolRisk(protocol: string): ReserveSlice["risk"] {
  switch (protocol) {
    case "aave-v3":
    case "aave-v4":
    case "morpho":
      return "medium";
    case "pendle":
      return "high";
    case "pareto":
    case "re":
    case "royco":
      return "high";
    default:
      return "high";
  }
}

function pushBucket(
  buckets: Map<string, MakinaBucketValue>,
  value: Omit<MakinaBucketValue, "value">,
  amount: number,
): void {
  if (!Number.isFinite(amount) || amount === 0) return;
  const existing = buckets.get(value.key);
  if (existing) {
    existing.value += amount;
    return;
  }
  buckets.set(value.key, { ...value, value: amount });
}

function isKnownAccountingToken(token: MakinaToken | undefined, params: MakinaStrategyParams): boolean {
  const expected = params.accountingTokenSymbol?.toUpperCase() ?? "USDC";
  return tokenSymbol(token)?.toUpperCase() === expected;
}

function reserveSliceFromBucket(bucket: MakinaBucketValue): ReserveSlice {
  return {
    name: bucket.name,
    pct: bucket.value,
    risk: bucket.risk,
    ...(bucket.coinId ? { coinId: bucket.coinId } : {}),
    ...(bucket.depType ? { depType: bucket.depType } : {}),
  };
}

function makeOtherBucket(buckets: MakinaBucketValue[]): MakinaBucketValue {
  const risk = buckets.some((bucket) => bucket.risk === "very-high")
    ? "very-high"
    : buckets.some((bucket) => bucket.risk === "high")
      ? "high"
      : buckets.some((bucket) => bucket.risk === "medium")
        ? "medium"
        : "low";
  return {
    key: "other",
    name: "Other identified Makina positions",
    value: buckets.reduce((sum, bucket) => sum + bucket.value, 0),
    risk,
    kind: "other",
  };
}

export function adaptMakinaStrategyReserves(
  strategy: MakinaStrategyEnvelope,
  allocations: MakinaAllocationsEnvelope,
  params: MakinaStrategyParams,
  redemptionState?: MakinaRedemptionState | null,
  redemptionWarning?: LiveReserveWarning,
): AdapterResult {
  const strategyData = strategy.data;
  const allocationData = allocations.data;
  if (!strategyData || !allocationData) {
    throw new Error("makina-strategy missing data envelope");
  }

  const strategyAddress = readString(strategyData.address);
  if (strategyAddress?.toLowerCase() !== params.machineAddress.toLowerCase()) {
    throw new Error("makina-strategy machine address mismatch");
  }

  const accountingDecimals = params.accountingTokenDecimals ?? (
    typeof strategyData.accountingToken?.decimals === "number"
      ? strategyData.accountingToken.decimals
      : DEFAULT_ACCOUNTING_DECIMALS
  );
  if (!Number.isSafeInteger(accountingDecimals) || accountingDecimals < 0 || accountingDecimals > 36) {
    throw new Error("makina-strategy invalid accounting token decimals");
  }
  if (!isKnownAccountingToken(strategyData.accountingToken, params)) {
    throw new Error("makina-strategy accounting token mismatch");
  }

  const sourceTimestamp = readTimestamp(strategy.meta?.generated_at ?? allocations.meta?.generated_at, "generated_at");
  const reportedAumUsd = readNonNegativeAccountingValue(
    strategyData.lastReportedAum ?? strategyData.aum,
    accountingDecimals,
    "reported AUM",
  );
  const currentAumUsd = readNonNegativeAccountingValue(strategyData.aum, accountingDecimals, "current AUM");
  const shareSupply = readNonNegativeAccountingValue(strategyData.shareSupply, 18, "share supply");
  const shareLimit = readNonNegativeAccountingValue(strategyData.shareLimit, 18, "share limit");
  const sharePrice = readPositiveNumber(strategyData.sharePrice, "share price");
  if (reportedAumUsd <= 0 || shareSupply <= 0 || sharePrice <= 0) {
    throw new Error("makina-strategy non-positive accounting state");
  }

  const warnings: LiveReserveWarning[] = [];
  const buckets = new Map<string, MakinaBucketValue>();
  let totalDebtUsd = 0;
  let grossAssetsUsd = 0;
  let positionCount = 0;
  let debtPositionCount = 0;
  let oldestMaterialPositionUpdatedAt: number | null = null;
  const positionDetails: Array<Record<string, unknown>> = [];
  const chainTotals = new Map<string, number>();

  for (const entry of asArray(allocationData.base_tokens) as MakinaBaseToken[]) {
    const value = readNonNegativeAccountingValue(
      entry.accounting_token_value,
      accountingDecimals,
      "base token accounting value",
    );
    if (value <= 0) continue;
    grossAssetsUsd += value;
    const chainId = readStringLike(entry.token?.chainId) ?? "unknown";
    chainTotals.set(chainId, (chainTotals.get(chainId) ?? 0) + value);
    if (isKnownAccountingToken(entry.token, params)) {
      pushBucket(buckets, {
        key: "base-token",
        name: "Unallocated USDC balances",
        risk: "low",
        kind: "base-token",
        coinId: "usdc-circle",
        depType: "collateral",
      }, value);
      continue;
    }
    const protocol = protocolKey(entry.protocol);
    if (protocol) {
      pushBucket(buckets, {
        key: `protocol:${protocol}`,
        name: displayProtocol(protocol),
        risk: protocolRisk(protocol),
        kind: "protocol",
      }, value);
      continue;
    }
    pushBucket(buckets, {
      key: "unknown",
      name: "Unknown Makina exposure",
      risk: "high",
      kind: "unknown",
    }, value);
  }

  for (const entry of asArray(allocationData.positions) as MakinaPosition[]) {
    const unsignedValue = readNonNegativeAccountingValue(entry.value, accountingDecimals, "position value");
    if (unsignedValue <= 0) continue;
    positionCount += 1;
    const signedValue = readBoolean(entry.is_debt) ? -unsignedValue : unsignedValue;
    if (signedValue < 0) {
      totalDebtUsd += unsignedValue;
      debtPositionCount += 1;
    } else {
      grossAssetsUsd += unsignedValue;
    }
    const chainId = readStringLike(entry.chain_id) ?? "unknown";
    chainTotals.set(chainId, (chainTotals.get(chainId) ?? 0) + signedValue);

    const updatedAt = typeof entry.updated_at === "number" ? entry.updated_at : null;
    const protocol = protocolKey(entry.protocol);
    const name = protocol ? displayProtocol(protocol) : "Unknown Makina exposure";
    const key = protocol ? `protocol:${protocol}` : "unknown";
    const risk = protocol ? protocolRisk(protocol) : "high";
    pushBucket(buckets, { key, name, risk, kind: protocol ? "protocol" : "unknown" }, signedValue);

    positionDetails.push({
      id: readString(entry.id) ?? null,
      protocol: protocol ?? null,
      strategy: readString(entry.strategy) ?? null,
      type: readString(entry.type) ?? null,
      chainId,
      valueUsd: signedValue,
      isDebt: signedValue < 0,
      updatedAt,
      updatedAtBlock: readString(entry.updated_at_block) ?? null,
      tokenSymbol: tokenSymbol(entry.token),
      materialPct: null,
    });
  }

  const netReserveUsd = [...buckets.values()].reduce((sum, bucket) => sum + bucket.value, 0);
  if (!Number.isFinite(netReserveUsd) || netReserveUsd <= 0) {
    throw new Error("makina-strategy produced zero net reserve value");
  }
  const reconciliationDiffPct = Math.abs(netReserveUsd - reportedAumUsd) / reportedAumUsd * 100;
  const reconciliationTolerancePct =
    params.reconciliationTolerancePct ?? DEFAULT_RECONCILIATION_TOLERANCE_PCT;
  if (reconciliationDiffPct > reconciliationTolerancePct) {
    throw new Error(
      `makina-strategy allocation net value differs from reported AUM by ${reconciliationDiffPct.toFixed(3)}%`,
    );
  }

  const otherThresholdPct = params.otherThresholdPct ?? DEFAULT_OTHER_THRESHOLD_PCT;
  const positiveBuckets = [...buckets.values()].filter((bucket) => bucket.value > 0);
  const unknownBuckets = positiveBuckets.filter((bucket) => bucket.kind === "unknown");
  const knownBuckets = positiveBuckets.filter((bucket) => bucket.kind !== "unknown");
  const major = knownBuckets.filter((bucket) => (bucket.value / netReserveUsd) * 100 >= otherThresholdPct);
  const minor = knownBuckets.filter((bucket) => (bucket.value / netReserveUsd) * 100 < otherThresholdPct);
  const displayedBuckets = [
    ...major,
    ...(minor.length > 0 ? [makeOtherBucket(minor)] : []),
    ...unknownBuckets,
  ];
  const unknownExposureUsd = unknownBuckets.reduce((sum, bucket) => sum + bucket.value, 0);
  const unknownExposurePct = unknownExposureUsd / netReserveUsd * 100;
  if (unknownExposurePct > 0) {
    warnings.push(reserveInfoWarning(
      "makina-unknown-exposure",
      `Makina allocation includes ${unknownExposurePct.toFixed(2)}% unlabelled exposure`,
    ));
  }
  if (redemptionWarning) {
    warnings.push(redemptionWarning);
  }

  for (const detail of positionDetails) {
    const valueUsd = typeof detail.valueUsd === "number" ? Math.abs(detail.valueUsd) : 0;
    const materialPct = valueUsd / netReserveUsd * 100;
    detail.materialPct = materialPct;
    if (
      materialPct >= otherThresholdPct &&
      typeof detail.updatedAt === "number" &&
      (oldestMaterialPositionUpdatedAt == null || detail.updatedAt < oldestMaterialPositionUpdatedAt)
    ) {
      oldestMaterialPositionUpdatedAt = detail.updatedAt;
    }
  }

  return {
    slices: normalizeSlices(
      displayedBuckets.map((bucket) => reserveSliceFromBucket({
        ...bucket,
        value: bucket.value / netReserveUsd * 100,
      })),
    ),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd: netReserveUsd,
      totalAssetsUsd: grossAssetsUsd,
      totalLiabilitiesUsd: totalDebtUsd,
      totalDebtUsd,
      shareSupply,
      shareLimit,
      referenceNavUsd: sharePrice,
      sharePrice,
      currentAumUsd,
      reportedAumUsd,
      apy7d: typeof strategyData.apy7d === "number" ? strategyData.apy7d : undefined,
      apy30d: typeof strategyData.apy30d === "number" ? strategyData.apy30d : undefined,
      unknownExposurePct,
      ...(redemptionState ? buildMakinaRedemptionMetadata(redemptionState) : {}),
      details: {
        proofKind: "makina-strategy-accounting-api",
        reconciliationKind: "allocation-net-value-equals-last-reported-aum",
        reconciliationDiffPct,
        oldestMaterialPositionUpdatedAt,
        positionCount,
        debtPositionCount,
        chainTotalsUsd: Object.fromEntries(chainTotals),
        protocolBuckets: displayedBuckets.map((bucket) => ({
          key: bucket.key,
          name: bucket.name,
          valueUsd: bucket.value,
          pct: bucket.value / netReserveUsd * 100,
          kind: bucket.kind,
        })),
        positions: positionDetails,
      },
    },
  };
}

export async function fetchMakinaStrategyReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primary = requireJsonInputFromConfig(config, "makina-strategy");
  const params = readParams(config);
  const [strategy, allocations, redemptionRead] = await Promise.all([
    fetchJsonWithRetry<MakinaStrategyEnvelope>(primary.url, signal, 12_000, ctx),
    fetchJsonWithRetry<MakinaAllocationsEnvelope>(params.allocationsUrl, signal, 12_000, ctx),
    fetchMakinaRedemptionState(coin, params, signal, ctx),
  ]);
  return adaptMakinaStrategyReserves(strategy, allocations, params, redemptionRead.state, redemptionRead.warning);
}
