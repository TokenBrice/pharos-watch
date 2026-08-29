import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  catchAndWarn,
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  freshnessMetadataFromTimestamp,
  normalizeSlices,
  parseBoundedDecimals,
  parseTimestampLikeToUnixSeconds,
  requireJsonInput,
} from "./helpers";

const ADAPTER_KEY = "jupusd";

interface JupUsdHolding {
  amount?: string;
  decimals?: number;
  name?: string;
  type?: string;
}

interface JupUsdDataPayload {
  holdings?: JupUsdHolding[];
  totalSupply?: string;
}

interface JupUsdSnapshotPayload {
  snapshots?: Array<{
    timestamp?: string | number;
  }>;
}

interface JupUsdOraclePayload {
  ripcord?: boolean;
  ripcordDetails?: string;
}

interface JupUsdParams {
  snapshotsUrl?: string;
  oracleUrl?: string;
}

interface JupUsdHoldingValue {
  name: string;
  value: number;
  risk: ReserveSlice["risk"];
  unknown?: boolean;
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

const HOLDING_META: Record<string, Pick<JupUsdHoldingValue, "risk" | "coinId" | "depType">> = {
  USDC: { risk: "low", coinId: "usdc-circle", depType: "collateral" },
  USDtb: { risk: "low", coinId: "usdtb-ethena", depType: "collateral" },
};

interface JupUsdFetchBudget {
  perAttemptTimeoutMs: number;
  totalTimeoutMs: number;
}

// Per-fetch budgets keep all three internal fetches inside the orchestrator's
// 20s per-attempt wall so a slow endpoint surfaces a labeled per-fetch error
// instead of a bare "adapter-timeout". The snapshots history feed is the slow
// one (~450KB payload) and only contributes the freshness timestamp, so it is
// bounded and degrades to unverified freshness when it cannot answer in time.
const JUPUSD_DATA_BUDGET: JupUsdFetchBudget = { perAttemptTimeoutMs: 8_000, totalTimeoutMs: 16_000 };
const JUPUSD_ORACLE_BUDGET: JupUsdFetchBudget = { perAttemptTimeoutMs: 4_000, totalTimeoutMs: 8_000 };
const JUPUSD_SNAPSHOTS_BUDGET: JupUsdFetchBudget = { perAttemptTimeoutMs: 10_000, totalTimeoutMs: 16_000 };

async function fetchJupUsdJson<T>(
  label: string,
  url: string,
  signal: AbortSignal,
  budget: JupUsdFetchBudget,
  ctx?: AdapterContext,
): Promise<T> {
  const deadline = AbortSignal.timeout(budget.totalTimeoutMs);
  try {
    return await fetchJsonWithRetry<T>(
      url,
      AbortSignal.any([signal, deadline]),
      budget.perAttemptTimeoutMs,
      ctx,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    if (deadline.aborted) {
      throw new Error(`jupusd ${label} fetch timed out after ${budget.totalTimeoutMs}ms: ${url}`);
    }
    const detail = toErrorMessage(error);
    throw new Error(`jupusd ${label} fetch failed: ${detail}`);
  }
}

function parseAmount(amount: string | undefined, decimals: number | undefined): number {
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return 0;
  const precision = decimals == null ? 0 : parseBoundedDecimals(decimals);
  if (precision == null) return 0;
  const parsed = decimalNumberFromBigInt(BigInt(amount), precision);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveHoldingMeta(name: string): Pick<JupUsdHoldingValue, "risk" | "coinId" | "depType" | "unknown"> {
  return HOLDING_META[name] ?? { risk: "high", unknown: true };
}

export function adaptJupUsdData(
  payload: JupUsdDataPayload,
  options: {
    sourceTimestamp?: number | null;
    oracle?: JupUsdOraclePayload | null;
    extraWarnings?: readonly LiveReserveWarning[];
  } = {},
): AdapterResult {
  const values = new Map<string, JupUsdHoldingValue>();
  const unknownHoldingNames = new Set<string>();
  let unknownValue = 0;
  for (const holding of payload.holdings ?? []) {
    const name = typeof holding.name === "string" && holding.name.trim().length > 0
      ? holding.name.trim()
      : "Unmapped reserve holding";
    const value = parseAmount(holding.amount, holding.decimals);
    if (value <= 0) continue;
    const current = values.get(name);
    const meta = resolveHoldingMeta(name);
    if (meta.unknown) {
      unknownHoldingNames.add(name);
      unknownValue += value;
    }
    values.set(name, {
      name: meta.unknown ? "Unmapped JupUSD reserve holdings" : name,
      value: (current?.value ?? 0) + value,
      risk: current?.risk ?? meta.risk,
      ...(meta.unknown ? { unknown: true } : {}),
      ...(current?.coinId ?? meta.coinId ? { coinId: current?.coinId ?? meta.coinId } : {}),
      ...(current?.depType ?? meta.depType ? { depType: current?.depType ?? meta.depType } : {}),
    });
  }

  const totalReserveUsd = [...values.values()].reduce((sum, entry) => sum + entry.value, 0);
  if (totalReserveUsd <= 0) {
    throw new Error("jupusd transparency payload returned zero reserve holdings");
  }

  const sourceTimestamp = options.sourceTimestamp ?? null;
  const routeStatus = options.oracle?.ripcord ? "paused" : "open";
  const routeStatusReason = options.oracle?.ripcord
    ? (options.oracle.ripcordDetails || "JupUSD oracle reports ripcord mode")
    : undefined;
  const totalSupply = parseAmount(payload.totalSupply, 6);
  const ratio = totalSupply > 0 ? Math.min(1, totalReserveUsd / totalSupply) : undefined;
  const unknownExposurePct = totalReserveUsd > 0 ? (unknownValue / totalReserveUsd) * 100 : 0;
  const warnings: LiveReserveWarning[] = [];
  if (unknownValue > 0) {
    warnings.push(buildUnknownExposureWarning({
      code: "unknown-holding",
      message: `JupUSD reserve feed included unmapped holding(s): ${Array.from(unknownHoldingNames).sort().join(", ")}`,
      unknownExposurePct,
    }));
  }
  if (options.extraWarnings?.length) {
    warnings.push(...options.extraWarnings);
  }

  return {
    slices: normalizeSlices(
      [...values.values()].map((entry) => ({
        name: entry.name,
        pct: (entry.value / totalReserveUsd) * 100,
        risk: entry.risk,
        ...(entry.coinId ? { coinId: entry.coinId } : {}),
        ...(entry.depType ? { depType: entry.depType } : {}),
      })),
    ),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      totalReserveUsd,
      ...(totalSupply > 0 ? { supplyUsd: totalSupply } : {}),
      unknownExposurePct,
      ...(unknownHoldingNames.size > 0 ? { unknownHoldingNames: Array.from(unknownHoldingNames).sort() } : {}),
      immediateRedeemableUsd: totalReserveUsd,
      ...(ratio != null ? { immediateRedeemableRatio: ratio } : {}),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: totalReserveUsd,
        ...(ratio != null ? { capacityRatioOfSupply: ratio } : {}),
        capacityKind: "live-direct-bounded",
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "same-run-api",
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus,
        routeStatusSource: "protocol-api",
        ...(routeStatusReason ? { routeStatusReason } : {}),
        holderEligibility: "whitelisted-primary",
        settlementDelaySec: 0,
        sourceUrls: [
          "https://api.jupusd.money/api/data",
          "https://api.jupusd.money/openapi.json",
        ],
      }),
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "jupusd-transparency-api",
        "JupUSD data payload does not expose a source timestamp",
      ),
    },
  };
}

function readParams(config: LiveReservesConfig): JupUsdParams {
  return parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
}

export async function fetchJupUsdReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  const params = readParams(config);
  const extraWarnings: LiveReserveWarning[] = [];
  // Fast fetches first: under the 2-op adapter I/O limiter the third fetch
  // queues behind the first two, so the sub-second oracle probe must not wait
  // behind the slow snapshots history feed.
  const [payload, oracle, snapshots] = await Promise.all([
    fetchJupUsdJson<JupUsdDataPayload>("transparency data", input.url, signal, JUPUSD_DATA_BUDGET, ctx),
    params.oracleUrl
      ? catchAndWarn(
          fetchJupUsdJson<JupUsdOraclePayload>("oracle", params.oracleUrl, signal, JUPUSD_ORACLE_BUDGET, ctx),
          "jupusd-oracle-unavailable",
          `JupUSD oracle feed failed: ${params.oracleUrl}`,
          extraWarnings,
        )
      : Promise.resolve(null),
    params.snapshotsUrl
      ? catchAndWarn(
          fetchJupUsdJson<JupUsdSnapshotPayload>("snapshots", params.snapshotsUrl, signal, JUPUSD_SNAPSHOTS_BUDGET, ctx),
          "jupusd-snapshots-unavailable",
          `JupUSD snapshots feed failed: ${params.snapshotsUrl}`,
          extraWarnings,
        )
      : Promise.resolve(null),
  ]);
  const latestTimestamp = parseTimestampLikeToUnixSeconds(snapshots?.snapshots?.[0]?.timestamp);
  return adaptJupUsdData(payload, {
    sourceTimestamp: latestTimestamp,
    oracle,
    extraWarnings,
  });
}
