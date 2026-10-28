// Reader for the published Bank Run Gauge.
//
// The gauge has exactly one producer: `refreshAggregateMintBurnFlowCache`
// (`worker/src/api/mint-burn-flows.ts`), which computes it over the
// admitted, enabled tracked-pair universe with tracked-chain mcap
// weighting and publishes it under `aggregateFlowCacheKey(24)`. Every other
// surface — the daily digest included — reads that publication through this
// module instead of recomputing the composite from `mint_burn_hourly`, so the
// gauge cannot diverge between the API and the digest.
//
// Deliberately lightweight: no mint-burn contract registry import, so digest
// and other hot paths can use it (see `mint-burn-canonical-chain.ts`).

import { isRecord, numberValue } from "@shared/lib/type-guards";
import {
  resolveMintBurnValuation,
  resolveMintBurnValuationCompleteness,
} from "@shared/lib/mint-burn-valuation";
import {
  MintBurnValuationCompletenessSchema,
  MintBurnFlowsResponseSchema,
  MintBurnValuationSchema,
  MintBurnCoinFlowSchema,
  type MintBurnCoinCoverage,
  type MintBurnValuation,
  type MintBurnValuationCompleteness,
  type MintBurnFlowsResponse,
} from "@shared/types/mint-burn";
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
  /** Known-valuation 24h net; `null` when the publication gated it. */
  net24hUsd: number | null;
  /** Observed tracked-chain supply; absent legacy weights remain unavailable. */
  gaugeWeightUsd: number | null;
  /** 24h window valuation; `unknown` on publications that predate completeness. */
  valuation24h: MintBurnValuation;
  /** Pressure baseline valuation; `unknown` on publications that predate completeness. */
  baselineValuation: MintBurnValuationCompleteness;
  scanCoverage: MintBurnCoinCoverage["windows"] | null;
}

export interface PublishedGaugeChain {
  chainId: string;
  /** Known-valuation 24h net; `null` when the publication gated it. */
  net24hUsd: number | null;
  valuation: MintBurnValuationCompleteness;
}

export interface PublishedMintBurnGauge {
  /** Mcap-weighted composite, or `null` when no tracked coin had valid data. */
  score: number | null;
  /**
   * Weighted coins whose pressure input in `score` has partial valuation;
   * `null` on publications that predate valuation completeness (unknown).
   */
  partialValuationInputs: number | null;
  /**
   * Weight withheld from `score` and weight scored (v6.23 publications); `null`
   * when the publication does not carry them, so the withheld weight is unbounded.
   */
  partialValuationMcapUsd: number | null;
  scoredMcapUsd: number | null;
  scanCoverage?: MintBurnFlowsResponse["gauge"]["scanCoverage"];
  coins: PublishedGaugeCoin[];
  /** Per-chain 24 h net flow, sorted by absolute net flow (descending). */
  chains: PublishedGaugeChain[];
  /** Exact producer window; legacy or unreadable provenance is unavailable. */
  window: NonNullable<MintBurnFlowsResponse["window"]> | null;
  /** Exact admitted scope used by the producer; absent legacy scope proves nothing. */
  publication: NonNullable<MintBurnFlowsResponse["publication"]> | null;
  /** Producer body clock, independent of the cache publication clock. */
  updatedAt: number | null;
  /** Producer cache publication timestamp, not a unique generation ID or read clock. */
  publishedAt: number;
  /** Publication older than {@link PUBLISHED_GAUGE_STALE_AFTER_SEC}. */
  stale: boolean;
}

export type PublishedMintBurnGaugeResult =
  | { kind: "ok"; gauge: PublishedMintBurnGauge }
  | { kind: "unavailable"; reason: "missing" | "malformed" | "expired" };

/** Optional non-negative weight: absent is `null`; present but invalid is a contract break (`false`). */
function parseOptionalWeight(value: unknown): number | null | false {
  if (value === undefined) return null;
  const weight = numberValue(value);
  return weight === null || weight < 0 ? false : weight;
}

/** Required nullable net: `null` is a gated value; absent or non-finite is a contract break. */
function parseNullableNet(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  const net = numberValue(value);
  return net === null ? { ok: false } : { ok: true, value: net };
}

function parseCoins(value: unknown): PublishedGaugeCoin[] | null {
  if (!Array.isArray(value)) return null;
  const coins: PublishedGaugeCoin[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { stablecoinId, symbol } = entry;
    if (typeof stablecoinId !== "string" || typeof symbol !== "string") return null;
    const net24hUsd = parseNullableNet(entry.netFlow24hUsd);
    if (!net24hUsd.ok) return null;
    const intensity = entry.pressureShiftScore === null || entry.pressureShiftScore === undefined
      ? null
      : numberValue(entry.pressureShiftScore);
    // A present-but-unparseable intensity is a contract break, not an NR.
    if (entry.pressureShiftScore !== null && entry.pressureShiftScore !== undefined && intensity === null) return null;
    // Absent valuation predates completeness (unknown); a present but malformed one is a contract break.
    let valuation24h: MintBurnValuation | undefined;
    let baselineValuation: MintBurnValuationCompleteness | undefined;
    if (entry.valuation !== undefined) {
      if (!isRecord(entry.valuation)) return null;
      const window24h = MintBurnValuationSchema.safeParse(entry.valuation.window24h);
      const baseline = MintBurnValuationCompletenessSchema.safeParse(entry.valuation.baseline);
      if (!window24h.success || !baseline.success) return null;
      valuation24h = window24h.data;
      baselineValuation = baseline.data;
    }
    const coverage = MintBurnCoinFlowSchema.shape.coverage.safeParse(entry.coverage);
    if (!coverage.success) return null;
    const gaugeWeight = MintBurnCoinFlowSchema.shape.gaugeWeightUsd.safeParse(entry.gaugeWeightUsd);
    if (!gaugeWeight.success) return null;
    coins.push({
      id: stablecoinId,
      symbol,
      intensity,
      net24hUsd: net24hUsd.value,
      gaugeWeightUsd: gaugeWeight.data ?? null,
      valuation24h: resolveMintBurnValuation(valuation24h),
      baselineValuation: resolveMintBurnValuationCompleteness(baselineValuation),
      scanCoverage: coverage.data?.windows ?? null,
    });
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
    const net24hUsd = parseNullableNet(entry.netFlow24hUsd);
    if (!net24hUsd.ok) return null;
    const valuation = entry.valuation === undefined
      ? undefined
      : MintBurnValuationCompletenessSchema.safeParse(entry.valuation);
    if (valuation && !valuation.success) return null;
    chains.push({
      chainId: entry.chainId,
      net24hUsd: net24hUsd.value,
      valuation: resolveMintBurnValuationCompleteness(valuation?.data),
    });
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
  const score = rawScore === null || rawScore === undefined ? null : numberValue(rawScore);
  if (rawScore !== null && rawScore !== undefined && score === null) return null;
  const rawPartialInputs = payload.gauge.partialValuationInputs;
  const partialValuationInputs = rawPartialInputs === undefined ? null : numberValue(rawPartialInputs);
  if (rawPartialInputs !== undefined && (partialValuationInputs === null || partialValuationInputs < 0)) return null;
  const partialValuationMcapUsd = parseOptionalWeight(payload.gauge.partialValuationMcapUsd);
  const scoredMcapUsd = parseOptionalWeight(payload.gauge.scoredMcapUsd);
  if (partialValuationMcapUsd === false || scoredMcapUsd === false) return null;
  const coins = parseCoins(payload.coins);
  if (!coins) return null;
  const chains = parseChains(payload.chains);
  if (!chains) return null;
  const parsedWindow = MintBurnFlowsResponseSchema.shape.window.safeParse(payload.window);
  const window = parsedWindow.success && parsedWindow.data
    && parsedWindow.data.end - parsedWindow.data.start === PUBLISHED_GAUGE_WINDOW_HOURS * 60 * 60
    && parsedWindow.data.start % 3600 === 0 && parsedWindow.data.end % 3600 === 0
    ? parsedWindow.data : null;
  const scanCoverage = MintBurnFlowsResponseSchema.shape.gauge.shape.scanCoverage.safeParse(payload.gauge.scanCoverage);
  if (!scanCoverage.success) return null;
  const publication = MintBurnFlowsResponseSchema.shape.publication.safeParse(payload.publication);
  if (!publication.success) return null;
  const producerClock = numberValue(payload.updatedAt);
  const updatedAt = producerClock !== null && Number.isInteger(producerClock) && producerClock >= 0
    ? producerClock : null;
  return { score, partialValuationInputs, partialValuationMcapUsd, scoredMcapUsd, coins, chains,
    ...(scanCoverage.data ? { scanCoverage: scanCoverage.data } : {}), window,
    publication: publication.data ?? null, updatedAt, publishedAt, stale };
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
  const watermark = gauge.window?.watermark;
  if (watermark && (watermark.timestamp == null || watermark.unavailableReason != null
    || nowSec - watermark.timestamp > watermark.maxAgeSec)) return { kind: "unavailable", reason: "expired" };
  return { kind: "ok", gauge };
}
