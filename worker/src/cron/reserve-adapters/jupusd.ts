import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  fetchJsonWithRetry,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  requireJsonInput,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
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

function parseAmount(amount: string | undefined, decimals: number | undefined): number {
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return 0;
  const precision = Number.isInteger(decimals) && decimals != null && decimals >= 0 ? decimals : 0;
  return Number(amount) / (10 ** precision);
}

function resolveHoldingMeta(name: string): Pick<JupUsdHoldingValue, "risk" | "coinId" | "depType" | "unknown"> {
  return HOLDING_META[name] ?? { risk: "high", unknown: true };
}

export function adaptJupUsdData(
  payload: JupUsdDataPayload,
  options: {
    sourceTimestamp?: number | null;
    oracle?: JupUsdOraclePayload | null;
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
  const warnings = unknownValue > 0
    ? [buildUnknownExposureWarning({
        code: "unknown-holding",
        message: `JupUSD reserve feed included unmapped holding(s): ${Array.from(unknownHoldingNames).sort().join(", ")}`,
        unknownExposurePct,
      })]
    : [];

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
      redemption: {
        capacityUsd: totalReserveUsd,
        ...(ratio != null ? { capacityRatioOfSupply: ratio } : {}),
        capacityKind: "live-direct-bounded" as const,
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" as const : "same-run-api" as const,
        routeStatus,
        ...(routeStatusReason ? { routeStatusReason } : {}),
        holderEligibility: "whitelisted-primary",
        settlementDelaySec: 0,
        sourceUrls: [
          "https://api.jupusd.money/api/data",
          "https://api.jupusd.money/openapi.json",
        ],
      },
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "jupusd-transparency-api",
            "JupUSD data payload does not expose a source timestamp",
          )),
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
  const [payload, snapshots, oracle] = await Promise.all([
    fetchJsonWithRetry<JupUsdDataPayload>(input.url, signal, 12_000, ctx),
    params.snapshotsUrl
      ? fetchJsonWithRetry<JupUsdSnapshotPayload>(params.snapshotsUrl, signal, 12_000, ctx).catch(() => null)
      : Promise.resolve(null),
    params.oracleUrl
      ? fetchJsonWithRetry<JupUsdOraclePayload>(params.oracleUrl, signal, 12_000, ctx).catch(() => null)
      : Promise.resolve(null),
  ]);
  const latestTimestamp = parseTimestampLikeToUnixSeconds(snapshots?.snapshots?.[0]?.timestamp);
  return adaptJupUsdData(payload, {
    sourceTimestamp: latestTimestamp,
    oracle,
  });
}
