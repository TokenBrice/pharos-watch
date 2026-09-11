import { z } from "zod";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  requireJsonInput,
  reserveDegradedWarning,
  verifiedFreshnessMetadata,
} from "./helpers";

const ADAPTER_KEY = "dgld-gold-mapper";
const GOLD_SOURCE_KEY = "dgld-gold-mapper:gold";

// Gold Token SA's live bar registry reconciles per-chain token supply to named
// PAMP bar serials with zero gap and refreshes daily. A residual mismatch beyond
// this share is published as unknown exposure rather than silently absorbed.
const RECONCILIATION_TOLERANCE_PCT = 0.5;

const DgldNetworkSchema = z.object({
  id: z.string(),
  reconState: z.string(),
  reconCheckedAt: z.string().nullable().optional(),
  decimals: z.number().int().nonnegative(),
  token: z.object({ address: z.string(), symbol: z.string() }),
  supply: z.object({ raw: z.string(), decimal: z.string() }),
  gap: z.object({ raw: z.string(), decimal: z.string() }),
});

const DgldNetworksSchema = z.object({ networks: z.array(DgldNetworkSchema) });

const DgldBarSchema = z.object({
  barId: z.string(),
  network: z.string(),
  status: z.string(),
  amount: z.object({ raw: z.string(), decimal: z.string() }),
});

const DgldBarsSchema = z.object({ bars: z.array(DgldBarSchema) });

interface DgldGoldMapperState {
  networks: z.infer<typeof DgldNetworksSchema>["networks"];
  bars: z.infer<typeof DgldBarsSchema>["bars"];
}

interface DgldGoldMapperParams {
  label: string;
  risk: ReserveSlice["risk"];
}

function readParams(config: LiveReservesConfig): DgldGoldMapperParams {
  return parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
}

export function adaptDgldGoldMapperState(
  state: DgldGoldMapperState,
  params: DgldGoldMapperParams,
): AdapterResult {
  const warnings: LiveReserveWarning[] = [];

  if (state.networks.length === 0) {
    throw new Error(`${ADAPTER_KEY}: /networks returned no networks`);
  }

  // ── Supply + reconciliation anchor per network ───────────────────────────
  let supplyTokens = 0;
  let oldestReconCheckedAt: number | null = null;
  const networkDetails: Array<Record<string, unknown>> = [];
  const unmatchedNetworks: string[] = [];

  for (const network of state.networks) {
    const supply = parseFiniteNonNegativeDecimal(network.supply.decimal, `supply(${network.id})`);
    const gap = parseFiniteNonNegativeDecimal(network.gap.decimal, `gap(${network.id})`);
    supplyTokens += supply;

    const reconCheckedAt = parseTimestampLikeToUnixSeconds(network.reconCheckedAt);
    if (reconCheckedAt == null) {
      throw new Error(`${ADAPTER_KEY}: network ${network.id} has an unreadable reconCheckedAt`);
    }
    oldestReconCheckedAt = oldestReconCheckedAt == null
      ? reconCheckedAt
      : Math.min(oldestReconCheckedAt, reconCheckedAt);

    if (network.reconState !== "matched") {
      unmatchedNetworks.push(network.id);
    }

    networkDetails.push({
      id: network.id,
      reconState: network.reconState,
      reconCheckedAt: network.reconCheckedAt,
      decimals: network.decimals,
      tokenAddress: network.token.address,
      supply,
      gap,
    });
  }

  if (supplyTokens <= 0) {
    throw new Error(`${ADAPTER_KEY}: summed network supply is not a positive token count`);
  }

  // ── Reserve = Σ live PAMP bar fine-oz ─────────────────────────────────────
  let reserveOz = 0;
  let liveBarCount = 0;
  let redeemedBarCount = 0;
  const liveBarSerials: string[] = [];

  for (const bar of state.bars) {
    if (bar.status === "live") {
      const amountOz = parseFiniteNonNegativeDecimal(bar.amount.decimal, `bar(${bar.barId})`);
      if (amountOz <= 0) {
        throw new Error(`${ADAPTER_KEY}: bar ${bar.barId} has a non-positive fine-oz amount`);
      }
      reserveOz += amountOz;
      liveBarCount += 1;
      liveBarSerials.push(bar.barId);
    } else if (bar.status === "redeemed") {
      redeemedBarCount += 1;
    } else {
      warnings.push(reserveDegradedWarning(
        "unrecognized-bar-status",
        `${ADAPTER_KEY}: bar ${bar.barId} has unrecognized status "${bar.status}" and is excluded from the reserve`,
      ));
    }
  }

  if (reserveOz <= 0) {
    throw new Error(`${ADAPTER_KEY}: no live bar fine-oz could be measured`);
  }

  // ── Reconciliation ────────────────────────────────────────────────────────
  // The registry reconciles supply to live bars with zero gap. A material gap
  // is published as unknown exposure (E4: observed bad news degrades, never a
  // silent constant fallback).
  const gapOz = supplyTokens - reserveOz;
  const unknownExposurePct = supplyTokens > 0 ? Math.abs(gapOz) / supplyTokens * 100 : 0;
  if (unknownExposurePct > RECONCILIATION_TOLERANCE_PCT) {
    warnings.push(reserveDegradedWarning(
      "reconciliation-gap",
      `${ADAPTER_KEY}: live-bar fine-oz (${reserveOz}) diverges from summed supply (${supplyTokens}) by ${unknownExposurePct.toFixed(2)}%`,
    ));
  }

  for (const id of unmatchedNetworks) {
    warnings.push(reserveDegradedWarning(
      "network-recon-mismatch",
      `${ADAPTER_KEY}: network ${id} is not reconciled (reconState is not "matched")`,
    ));
  }

  const collateralizationRatio = reserveOz / supplyTokens;

  const slices: ReserveSlice[] = [{
    sourceKey: GOLD_SOURCE_KEY,
    name: params.label,
    pct: 100,
    risk: params.risk,
  }];

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(oldestReconCheckedAt!),
      totalReserveQuantity: reserveOz,
      supplyTokens,
      collateralizationRatio,
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      details: {
        proofKind: "dgld-gold-mapper-bar-registry",
        reserveUnit: "troy-oz",
        networkCount: state.networks.length,
        liveBarCount,
        redeemedBarCount,
        liveBarSerials,
        networks: networkDetails,
      },
    },
  };
}

export async function fetchDgldGoldMapperReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = readParams(config);
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  const baseUrl = input.url.replace(/\/+$/, "");

  // Sequential reads keep the attempt inside the orchestrator's shared
  // connection budget; each fetch runs through the adapter I/O limiter.
  const networksPayload = await fetchJsonWithRetry<unknown>(
    `${baseUrl}/networks`,
    signal,
    12_000,
    ctx,
  );
  const barsPayload = await fetchJsonWithRetry<unknown>(
    `${baseUrl}/bars`,
    signal,
    12_000,
    ctx,
  );

  let networks: z.infer<typeof DgldNetworksSchema>;
  let bars: z.infer<typeof DgldBarsSchema>;
  try {
    networks = DgldNetworksSchema.parse(networksPayload);
  } catch {
    throw new Error(`${ADAPTER_KEY}: /networks response failed schema validation`);
  }
  try {
    bars = DgldBarsSchema.parse(barsPayload);
  } catch {
    throw new Error(`${ADAPTER_KEY}: /bars response failed schema validation`);
  }

  return adaptDgldGoldMapperState({ networks: networks.networks, bars: bars.bars }, params);
}

/**
 * Parse the issuer's decimal-string field. Rejects non-finite, negative, or
 * oversized values so a malformed registry row cannot publish a silent zero or
 * a fabricated reserve figure.
 */
function parseFiniteNonNegativeDecimal(value: unknown, label: string): number {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new Error(`${ADAPTER_KEY}: ${label} is not a decimal string`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${ADAPTER_KEY}: ${label} is not a finite non-negative number`);
  }
  return parsed;
}
