/**
 * Daily public-dataset snapshot writer.
 *
 * Reads canonical caches already produced by other crons (stablecoins,
 * report-card cache, latest PSI, current DEWS stress signals, current DEX
 * liquidity) and writes a single gzipped JSON envelope into the
 * `public_snapshots` D1 table. This row is the substrate for both
 *   GET /api/snapshots/<YYYY-MM-DD>.json (full daily blob, idea 12.6)
 * and
 *   GET /api/snapshot/<YYYY-MM-DD>/stablecoin/<id> (per-coin projection,
 *   idea 11.14).
 *
 * Zero outbound fetches — strictly D1-only — so this job consumes 0/6 of the
 * trigger's connection budget.
 *
 * Idempotent: keyed on the UTC ISO date, `INSERT OR REPLACE` overwrites the
 * row when the cron re-runs on the same UTC day.
 */
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { getCache } from "../lib/db-cache";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { CHAIN_HEALTH_METHODOLOGY_VERSION } from "@shared/lib/chain-health-version";
import { DEPEG_DEWS_METHODOLOGY_VERSION } from "@shared/lib/depeg-dews-version";
import { LIQUIDITY_METHODOLOGY_VERSION } from "@shared/lib/liquidity-score-version";
import { PRICING_PIPELINE_VERSION } from "@shared/lib/pricing-pipeline-version";
import { PSI_METHODOLOGY_VERSION } from "@shared/lib/stability-index-version";
import { REDEMPTION_BACKSTOP_VERSION } from "@shared/lib/redemption-backstop-version";
import { SAFETY_SCORE_VERSION } from "@shared/lib/safety-score-version";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/yield-methodology-version";

type StableMethodologyVersions = {
  pegScore: string;
  dews: string;
  liquidityScore: string;
  psi: string;
  reportCard: string;
  chainHealth: string;
  redemptionBackstop: string;
  pricingPipeline: string;
  yieldMethodology: string;
};

interface StabilityIndexRow {
  computed_at: number;
  score: number;
  band: string;
  components: string | null;
  methodology_version: string | null;
}

interface StressSignalRow {
  stablecoin_id: string;
  computed_at: number;
  score: number;
  band: string;
  signals_json: string | null;
}

interface DexLiquidityRow {
  stablecoin_id: string;
  total_tvl_usd: number | null;
  total_volume_24h_usd: number | null;
  pool_count: number | null;
  liquidity_score: number | null;
  durability_score: number | null;
  coverage_class: string | null;
  updated_at: number;
}

function isoDateUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function safeParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(input).body!.pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function buildMethodologyVersions(): StableMethodologyVersions {
  return {
    pegScore: SAFETY_SCORE_VERSION,
    dews: DEPEG_DEWS_METHODOLOGY_VERSION,
    liquidityScore: LIQUIDITY_METHODOLOGY_VERSION,
    psi: PSI_METHODOLOGY_VERSION,
    reportCard: SAFETY_SCORE_VERSION,
    chainHealth: CHAIN_HEALTH_METHODOLOGY_VERSION,
    redemptionBackstop: REDEMPTION_BACKSTOP_VERSION,
    pricingPipeline: PRICING_PIPELINE_VERSION,
    yieldMethodology: YIELD_METHODOLOGY_VERSION,
  };
}

export async function snapshotPublicDataset(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotDate = isoDateUtc(new Date(nowSec * 1000));

  // --- 1. Stablecoins (canonical market cache; required) ---
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  throwIfAborted(signal);
  if (stablecoinsCache.kind !== "ok") {
    console.warn(`[snapshot-public-dataset] Stablecoins cache unavailable: ${stablecoinsCache.kind}`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "stablecoins_cache_unavailable",
        cacheKind: stablecoinsCache.kind,
      }),
    };
  }

  // --- 2. Report-card cache (optional; degrade if missing) ---
  const reportCardCacheRow = await getCache(db, "report_card_cache");
  throwIfAborted(signal);
  const reportCards = safeParse<unknown>(reportCardCacheRow?.value, null);

  // --- 3. Latest PSI row ---
  let psiRow: StabilityIndexRow | null = null;
  try {
    psiRow = await db
      .prepare(
        "SELECT computed_at, score, band, components, methodology_version FROM stability_index ORDER BY computed_at DESC LIMIT 1",
      )
      .first<StabilityIndexRow>();
    throwIfAborted(signal);
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[snapshot-public-dataset] PSI read failed:", err);
  }

  // --- 4. DEWS stress signals (latest per coin) ---
  let stressRows: StressSignalRow[] = [];
  try {
    // Per-coin dedup: take the latest row only. The bare ORDER BY
    // computed_at DESC would emit every historical signal row and the
    // snapshot blob would grow linearly with retention window.
    const result = await db
      .prepare(
        `SELECT s.stablecoin_id, s.computed_at, s.score, s.band, s.signals_json
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) AS latest_computed_at
           FROM stress_signals
           GROUP BY stablecoin_id
         ) latest
           ON latest.stablecoin_id = s.stablecoin_id
          AND latest.latest_computed_at = s.computed_at
         ORDER BY s.stablecoin_id ASC`,
      )
      .all<StressSignalRow>();
    throwIfAborted(signal);
    stressRows = result.results ?? [];
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[snapshot-public-dataset] DEWS read failed:", err);
  }

  // --- 5. DEX liquidity (latest per coin) ---
  let dexRows: DexLiquidityRow[] = [];
  try {
    const result = await db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd, total_volume_24h_usd, pool_count, liquidity_score,
                durability_score, coverage_class, updated_at
         FROM dex_liquidity
         ORDER BY liquidity_score DESC`,
      )
      .all<DexLiquidityRow>();
    throwIfAborted(signal);
    dexRows = result.results ?? [];
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[snapshot-public-dataset] DEX liquidity read failed:", err);
  }

  const methodologyVersions = buildMethodologyVersions();

  const envelope = {
    snapshotDate,
    generatedAt: nowSec,
    methodologyVersions,
    stablecoins: stablecoinsCache.payload.peggedAssets,
    fxFallbackRates: stablecoinsCache.payload.fxFallbackRates ?? null,
    reportCards,
    psi: psiRow
      ? {
          computedAt: psiRow.computed_at,
          score: psiRow.score,
          band: psiRow.band,
          components: safeParse<Record<string, unknown> | null>(psiRow.components, null),
          methodologyVersion: psiRow.methodology_version ?? methodologyVersions.psi,
        }
      : null,
    dews: stressRows.map((row) => ({
      stablecoinId: row.stablecoin_id,
      computedAt: row.computed_at,
      score: row.score,
      band: row.band,
      signals: safeParse<Record<string, unknown> | null>(row.signals_json, null),
    })),
    liquidity: dexRows.map((row) => ({
      stablecoinId: row.stablecoin_id,
      totalTvlUsd: row.total_tvl_usd,
      totalVolume24hUsd: row.total_volume_24h_usd,
      poolCount: row.pool_count,
      liquidityScore: row.liquidity_score,
      durabilityScore: row.durability_score,
      coverageClass: row.coverage_class,
      updatedAt: row.updated_at,
    })),
  };

  const jsonText = JSON.stringify(envelope);
  const jsonBytes = new TextEncoder().encode(jsonText);
  const byteSize = jsonBytes.byteLength;

  let contentHash: string;
  let payloadGz: Uint8Array;
  try {
    [contentHash, payloadGz] = await Promise.all([sha256Hex(jsonBytes), gzipBytes(jsonBytes)]);
    throwIfAborted(signal);
  } catch (err) {
    rethrowIfAborted(err, signal);
    recordCronFailure("snapshot-public-dataset", err, { metadata: { stage: "compress" } });
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "compress_failed", error: String(err).slice(0, 200) }),
    };
  }

  try {
    throwIfAborted(signal);
    await db
      .prepare(
        `INSERT OR REPLACE INTO public_snapshots
         (snapshot_date, payload_gz, methodology_versions, content_hash, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        snapshotDate,
        payloadGz,
        JSON.stringify(methodologyVersions),
        contentHash,
        byteSize,
        nowSec,
      )
      .run();
  } catch (err) {
    rethrowIfAborted(err, signal);
    recordCronFailure("snapshot-public-dataset", err, { metadata: { stage: "insert" } });
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "db_write_failed", error: String(err).slice(0, 200) }),
    };
  }

  return {
    itemCount: 1,
    metadata: JSON.stringify({
      snapshotDate,
      contentHash,
      byteSize,
      compressedSize: payloadGz.byteLength,
      stablecoinCount: stablecoinsCache.payload.peggedAssets.length,
      psiPresent: psiRow !== null,
      dewsCount: stressRows.length,
      liquidityCount: dexRows.length,
    }),
  };
}
