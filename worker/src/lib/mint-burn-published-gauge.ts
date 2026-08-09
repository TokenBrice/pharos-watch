// Reader for the published Bank Run Gauge.
//
// The gauge has exactly one producer: `refreshAggregateMintBurnFlowCache`
// (`worker/src/api/mint-burn-flows.ts`), which computes it over the
// `ACTIVE_MINT_BURN_CONFIGS` tracked-pair universe with tracked-chain mcap
// weighting and publishes it under `aggregateFlowCacheKey(24)`. Every other
// surface — the daily digest included — reads that publication through this
// module instead of recomputing the composite from `mint_burn_hourly`, so the
// gauge cannot diverge between the API and the digest.
//
// Deliberately lightweight: no mint-burn contract registry import, so digest
// and other hot paths can use it (see `mint-burn-canonical-chain.ts`).

import { isRecord } from "@shared/lib/type-guards";
import { getCache } from "./db-cache";
import { aggregateFlowCacheKey } from "./mint-burn-flow-cache-keys";
import { tryParseJson } from "./json-parse";

/**
 * The gauge and every per-coin field it is derived from are pinned to the
 * canonical 24-hour interpretation window, independent of the chart window.
 */
const PUBLISHED_GAUGE_WINDOW_HOURS = 24;

/**
 * The producer is the 20-minute critical mint/burn lane. Beyond 2 h the
 * publication has missed ~6 consecutive runs: still usable, but the consumer
 * should record the degradation.
 */
export const PUBLISHED_GAUGE_STALE_AFTER_SEC = 2 * 60 * 60;

/**
 * Beyond one digest cycle the publication describes a different day; the flow
 * data underneath it is stale too, so consumers fail closed rather than
 * republish it.
 */
export const PUBLISHED_GAUGE_MAX_AGE_SEC = 24 * 60 * 60;

export interface PublishedGaugeCoin {
  id: string;
  symbol: string;
  /** Baseline-relative pressure shift; `null` = NR (excluded from the gauge). */
  intensity: number | null;
  net24hUsd: number;
}

export interface PublishedGaugeChain {
  chainId: string;
  net24hUsd: number;
}

export interface PublishedMintBurnGauge {
  /** Mcap-weighted composite, or `null` when no tracked coin had valid data. */
  score: number | null;
  coins: PublishedGaugeCoin[];
  /** Per-chain 24 h net flow, sorted by absolute net flow (descending). */
  chains: PublishedGaugeChain[];
  publishedAt: number;
  /** Publication older than {@link PUBLISHED_GAUGE_STALE_AFTER_SEC}. */
  stale: boolean;
}

export type PublishedMintBurnGaugeResult =
  | { kind: "ok"; gauge: PublishedMintBurnGauge }
  | { kind: "unavailable"; reason: "missing" | "malformed" | "expired" };

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCoins(value: unknown): PublishedGaugeCoin[] | null {
  if (!Array.isArray(value)) return null;
  const coins: PublishedGaugeCoin[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { stablecoinId, symbol } = entry;
    if (typeof stablecoinId !== "string" || typeof symbol !== "string") return null;
    const net24hUsd = finiteNumber(entry.netFlow24hUsd);
    if (net24hUsd === null) return null;
    const rawIntensity = entry.pressureShiftScore ?? entry.flowIntensity;
    const intensity = rawIntensity === null || rawIntensity === undefined
      ? null
      : finiteNumber(rawIntensity);
    // A present-but-unparseable intensity is a contract break, not an NR.
    if (rawIntensity !== null && rawIntensity !== undefined && intensity === null) return null;
    coins.push({ id: stablecoinId, symbol, intensity, net24hUsd });
  }
  return coins;
}

function parseChains(value: unknown): PublishedGaugeChain[] | null {
  // `chains` was added alongside the gauge unification; a publication written
  // before it is still a valid gauge source with an empty chain breakdown.
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const chains: PublishedGaugeChain[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.chainId !== "string") return null;
    const net24hUsd = finiteNumber(entry.netFlow24hUsd);
    if (net24hUsd === null) return null;
    chains.push({ chainId: entry.chainId, net24hUsd });
  }
  return chains;
}

/**
 * Parse a published aggregate mint/burn flow payload into gauge inputs.
 * Returns `null` when the payload does not carry a usable gauge.
 */
export function parsePublishedMintBurnGauge(
  payload: unknown,
  publishedAt: number,
  stale: boolean,
): PublishedMintBurnGauge | null {
  if (!isRecord(payload) || !isRecord(payload.gauge)) return null;
  const rawScore = payload.gauge.score;
  const score = rawScore === null || rawScore === undefined ? null : finiteNumber(rawScore);
  if (rawScore !== null && rawScore !== undefined && score === null) return null;
  const coins = parseCoins(payload.coins);
  if (!coins) return null;
  const chains = parseChains(payload.chains);
  if (!chains) return null;
  return { score, coins, chains, publishedAt, stale };
}

/** Read the single published gauge. Fails closed rather than recomputing. */
export async function readPublishedMintBurnGauge(
  db: D1Database,
  nowSec: number,
): Promise<PublishedMintBurnGaugeResult> {
  const cached = await getCache(db, aggregateFlowCacheKey(PUBLISHED_GAUGE_WINDOW_HOURS));
  if (!cached) return { kind: "unavailable", reason: "missing" };
  const ageSec = nowSec - cached.updatedAt;
  if (ageSec > PUBLISHED_GAUGE_MAX_AGE_SEC) return { kind: "unavailable", reason: "expired" };
  const payload = tryParseJson(cached.value, { onFailure: () => undefined });
  const gauge = parsePublishedMintBurnGauge(
    payload,
    cached.updatedAt,
    ageSec > PUBLISHED_GAUGE_STALE_AFTER_SEC,
  );
  if (!gauge) return { kind: "unavailable", reason: "malformed" };
  return { kind: "ok", gauge };
}
