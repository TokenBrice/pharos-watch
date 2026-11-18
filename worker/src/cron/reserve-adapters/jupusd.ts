import { z } from "zod";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice } from "@shared/types/reserves";
import type { ReserveAdapterCoin } from "@shared/types/stablecoin-meta-schemas";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  normalizeSlices,
  parseBoundedDecimals,
  requireJsonInput,
  reserveDegradedWarning,
  reserveFatalWarning,
  unverifiedFreshnessMetadata,
} from "./helpers";

const ADAPTER_KEY = "jupusd";

interface JupUsdHolding {
  amount?: string;
  decimals?: number | null;
  name?: string;
  type?: string;
}

interface JupUsdDataPayload {
  holdings?: JupUsdHolding[];
  totalSupply?: string;
}

const JupUsdOraclePayloadSchema = z.object({
  ripcord: z.boolean(),
  ripcordDetails: z.string().optional(),
});

type JupUsdOraclePayload = z.output<typeof JupUsdOraclePayloadSchema>;

type JupUsdParams = LiveReserveAdapterParamsByKey["jupusd"];

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

// Per-fetch budgets keep both internal fetches inside the orchestrator's
// 20s per-attempt wall so a slow endpoint surfaces a labeled per-fetch error
// instead of a bare "adapter-timeout".
const JUPUSD_DATA_BUDGET: JupUsdFetchBudget = { perAttemptTimeoutMs: 8_000, totalTimeoutMs: 16_000 };
const JUPUSD_ORACLE_BUDGET: JupUsdFetchBudget = { perAttemptTimeoutMs: 4_000, totalTimeoutMs: 8_000 };

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

function parseAmount(amount: string | undefined, decimals: number | null | undefined): number | null {
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
  const precision = parseBoundedDecimals(decimals);
  if (precision == null) return null;
  const parsed = decimalNumberFromBigInt(BigInt(amount), precision);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function resolveHoldingMeta(name: string): Pick<JupUsdHoldingValue, "risk" | "coinId" | "depType" | "unknown"> {
  return HOLDING_META[name] ?? { risk: "high", unknown: true };
}

export function adaptJupUsdData(
  payload: JupUsdDataPayload,
  options: {
    oracle?: JupUsdOraclePayload | null;
    oracleUrl?: string;
    extraWarnings?: readonly LiveReserveWarning[];
  } = {},
): AdapterResult {
  const values = new Map<string, JupUsdHoldingValue>();
  const unknownHoldingNames = new Set<string>();
  const warnings: LiveReserveWarning[] = [];
  let unknownValue = 0;
  const unavailableHoldingNames: string[] = Array.isArray(payload.holdings) ? [] : ["holdings"];
  for (const [holdingIndex, holding] of (Array.isArray(payload.holdings) ? payload.holdings : []).entries()) {
    const name = typeof holding.name === "string" && holding.name.trim().length > 0
      ? holding.name.trim()
      : "Unmapped reserve holding";
    const value = parseAmount(holding.amount, holding.decimals);
    if (value == null) {
      unavailableHoldingNames.push(`${holdingIndex}:${name}`);
      continue;
    }
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

  if (unavailableHoldingNames.length > 0) {
    return {
      slices: [],
      warnings: [reserveFatalWarning("holdings-incomplete",
        `JupUSD holding amounts or scales unavailable: ${unavailableHoldingNames.join(", ")}`)],
      metadata: { details: {
        unavailableHoldingNames,
        measuredHoldingsUsd: [...values.values()].reduce((sum, entry) => sum + entry.value, 0),
        measuredHoldings: [...values.values()],
      } },
    };
  }
  const totalReserveUsd = [...values.values()].reduce((sum, entry) => sum + entry.value, 0);
  if (totalReserveUsd <= 0) {
    throw new Error("jupusd transparency payload returned zero reserve holdings");
  }

  const { oracle, oracleUrl } = options;
  const routeStatusReason = oracle?.ripcord
    ? (oracle.ripcordDetails || "JupUSD oracle reports ripcord mode")
    : oracleUrl && !oracle
      ? "JupUSD oracle route status could not be observed"
      : undefined;
  const totalSupply = parseAmount(payload.totalSupply, 6);
  if (totalSupply == null || totalSupply <= 0) {
    throw new Error("jupusd missing or invalid totalSupply");
  }
  // True assets ÷ liability: never clamped, so genuine overcollateralization
  // shows and a shortfall degrades per the undercollateralization policy.
  const collateralizationRatio = totalReserveUsd / totalSupply;
  const unknownExposurePct = (unknownValue / totalReserveUsd) * 100;
  if (unknownValue > 0) {
    const message = `JupUSD reserve feed included unmapped holding(s): ${Array.from(unknownHoldingNames).sort().join(", ")}`;
    warnings.push(buildUnknownExposureWarning({ adapterKey: "jupusd", code: "unknown-holding", message, unknownExposurePct }));
  }
  if (options.extraWarnings?.length) {
    warnings.push(...options.extraWarnings);
  }
  if (collateralizationRatio != null) {
    warnings.push(...buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `JupUSD reserve holdings cover ${pct}% of reported supply`,
      coverageRatio: collateralizationRatio,
      thresholdRatio: 1,
    }));
  }

  return {
    slices: normalizeSlices(
      [...values.values()].map((entry) => ({
        sourceKey: entry.unknown ? "jupusd:unknown" : `jupusd:${entry.name.toLowerCase()}`,
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
      collateralizationRatio,
      unknownExposurePct,
      supplyUsd: totalSupply,
      ...(unknownHoldingNames.size > 0 ? { unknownHoldingNames: Array.from(unknownHoldingNames).sort() } : {}),
      ...buildRedemptionSnapshotMetadata({
        ...(oracle != null
          ? {
              routeStatus: oracle.ripcord ? "paused" as const : "open" as const,
              routeStatusSource: "protocol-api" as const,
              routeObserved: true as const,
              ...(oracleUrl ? { sourceUrls: [oracleUrl] } : {}),
            }
          : {
              routeStatus: "unknown" as const,
              routeStatusSource: "static-config" as const,
            }),
        ...(routeStatusReason ? { routeStatusReason } : {}),
        holderEligibility: "whitelisted-primary",
      }),
      ...unverifiedFreshnessMetadata(
        "jupusd-transparency-api",
        "JupUSD holdings and supply have no verified source timestamp",
      ),
    },
  };
}

function readParams(config: LiveReservesConfig): JupUsdParams {
  return parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
}

export async function fetchJupUsdReserves(
  _coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  const { oracleUrl } = readParams(config);
  const extraWarnings: LiveReserveWarning[] = [];
  const [payload, oracle] = await Promise.all([
    fetchJupUsdJson<JupUsdDataPayload>("transparency data", input.url, signal, JUPUSD_DATA_BUDGET, ctx),
    oracleUrl
      ? fetchJupUsdJson<unknown>(
          "oracle",
          oracleUrl,
          signal,
          JUPUSD_ORACLE_BUDGET,
          ctx,
        ).then((payload) => JupUsdOraclePayloadSchema.parse(payload)).catch((error) => {
          if (signal.aborted) throw error;
          extraWarnings.push(reserveDegradedWarning(
            "jupusd-oracle-unavailable",
            `JupUSD oracle route status could not be observed: ${toErrorMessage(error)}`,
          ));
          return null;
        })
      : Promise.resolve(null),
  ]);
  return adaptJupUsdData(payload, { oracleUrl, oracle, extraWarnings });
}
