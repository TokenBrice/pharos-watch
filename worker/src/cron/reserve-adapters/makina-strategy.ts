import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { rethrowIfAborted } from "../../lib/abort";
import {
  buildRedemptionSnapshotMetadata,
  fetchJsonWithRetry,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveInfoWarning,
  verifiedFreshnessMetadata,
} from "./helpers";
import { fetchOnchainUint256 } from "./onchain";

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
  finalizationDelaySec: number;
  nextRequestId: number;
  lastFinalizedRequestId: number;
}

const DEFAULT_ACCOUNTING_DECIMALS = 6;
const DEFAULT_OTHER_THRESHOLD_PCT = 2;
const DEFAULT_RECONCILIATION_TOLERANCE_PCT = 0.5;
const IS_WHITELIST_ENABLED_SELECTOR = "0x184d69ab";
const FINALIZATION_DELAY_SELECTOR = "0xf9823a5c";
const NEXT_REQUEST_ID_SELECTOR = "0x6a84a985";
const LAST_FINALIZED_REQUEST_ID_SELECTOR = "0x667a739e";

function readParams(config: LiveReservesConfig): MakinaStrategyParams {
  return parseLiveReserveAdapterParams("makina-strategy", config.params);
}

function readSafeOnchainNumber(value: bigint | null): number | null {
  if (value == null || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

export function buildMakinaRedemptionMetadata(state: MakinaRedemptionState) {
  const unfinalizedRequestSpan = Math.max(
    0,
    state.nextRequestId - state.lastFinalizedRequestId - 1,
  );

  return {
    ...buildRedemptionSnapshotMetadata({
      freshnessKind: "same-run-onchain",
      holderEligibility: state.whitelistEnabled ? "whitelisted-primary" : "any-holder",
      settlementDelaySec: state.finalizationDelaySec,
      routeStatus: state.whitelistEnabled ? "cohort-limited" : "open",
      routeStatusSource: "onchain",
      routeStatusReason: state.whitelistEnabled
        ? "AsyncRedeemer whitelist is enabled; requests and claims are limited to approved holders"
        : "AsyncRedeemer whitelist is disabled",
      sourceUrls: [
        "https://eth.blockscout.com/address/0x1303c26cfe06bac5bfee29907f37919643def75c?tab=contract",
      ],
    }),
    redemptionQueue: {
      nextRequestId: state.nextRequestId,
      lastFinalizedRequestId: state.lastFinalizedRequestId,
      unfinalizedRequestSpan,
    },
  };
}

async function fetchMakinaRedemptionState(
  asyncRedeemerAddress: string | undefined,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<MakinaRedemptionState | null> {
  if (!asyncRedeemerAddress) return null;

  const call = (data: string) =>
    fetchOnchainUint256({
      contract: asyncRedeemerAddress,
      data,
      signal,
      ctx,
      chain: "ethereum",
      rpcMode: "etherscan-proxy",
    });
  let reads: Awaited<ReturnType<typeof call>>[];
  try {
    reads = await Promise.all([
      call(IS_WHITELIST_ENABLED_SELECTOR),
      call(FINALIZATION_DELAY_SELECTOR),
      call(NEXT_REQUEST_ID_SELECTOR),
      call(LAST_FINALIZED_REQUEST_ID_SELECTOR),
    ]);
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
  const [whitelistRaw, delayRaw, nextRaw, finalizedRaw] = reads;
  const finalizationDelaySec = readSafeOnchainNumber(delayRaw);
  const nextRequestId = readSafeOnchainNumber(nextRaw);
  const lastFinalizedRequestId = readSafeOnchainNumber(finalizedRaw);
  if (
    whitelistRaw == null ||
    (whitelistRaw !== 0n && whitelistRaw !== 1n) ||
    finalizationDelaySec == null ||
    nextRequestId == null ||
    lastFinalizedRequestId == null
  ) {
    return null;
  }

  return {
    whitelistEnabled: whitelistRaw === 1n,
    finalizationDelaySec,
    nextRequestId,
    lastFinalizedRequestId,
  };
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
  const [strategy, allocations, redemptionState] = await Promise.all([
    fetchJsonWithRetry<MakinaStrategyEnvelope>(primary.url, signal, 12_000, ctx),
    fetchJsonWithRetry<MakinaAllocationsEnvelope>(params.allocationsUrl, signal, 12_000, ctx),
    fetchMakinaRedemptionState(params.asyncRedeemerAddress, signal, ctx),
  ]);
  return adaptMakinaStrategyReserves(strategy, allocations, params, redemptionState);
}
