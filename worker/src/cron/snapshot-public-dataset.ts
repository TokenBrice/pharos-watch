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
 * Idempotent: keyed on the UTC ISO date, rows are write-once so dated public
 * snapshot URLs can be cached immutably without later same-day mutation.
 */
import { rethrowIfAborted, sleepWithSignal, throwIfAborted } from "../lib/abort";
import {
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_ATTEMPTS,
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_DELAY_MS,
} from "../lib/public-dataset-snapshot-budget";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadReportCardCache, REPORT_CARD_CACHE_MAX_AGE_MS } from "../lib/report-card-cache";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../lib/dex-liquidity";
import { sha256Hex } from "../lib/hash";
import { toErrorMessage } from "../lib/error-utils";
import { CHAIN_HEALTH_METHODOLOGY_VERSION } from "@shared/lib/chain-health-version";
import { DEPEG_DEWS_METHODOLOGY_VERSION } from "@shared/lib/depeg-dews-version";
import { LIQUIDITY_METHODOLOGY_VERSION } from "@shared/lib/liquidity-score-version";
import { PRICING_PIPELINE_METHODOLOGY_VERSION } from "@shared/lib/pricing-pipeline-version";
import { PSI_METHODOLOGY_VERSION } from "@shared/lib/stability-index-version";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION } from "@shared/lib/redemption-backstop-version";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/yield-methodology-version";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { safeJsonParse } from "../lib/api-cache-read";
import { loadPublishedStressSignalGeneration } from "../lib/stress-signals-current-rows";
import { isCurrentSafetyScoreV8Identity } from "../lib/safety-score-current-identity";

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

interface ExistingSnapshotRow {
  content_hash: string;
  byte_size: number;
  created_at: number;
}

interface SnapshotSectionReadFailure {
  section: "dews" | "liquidity";
  error: string;
}

interface SnapshotPublicDatasetOptions {
  minStablecoinsCacheUpdatedAtSec?: number | null;
  freshnessGateLabel?: string;
  stablecoinsCacheRetryAttempts?: number;
  stablecoinsCacheRetryDelayMs?: number;
}

const DEFAULT_STABLECOINS_CACHE_RETRY_ATTEMPTS = 0;
const DEFAULT_STABLECOINS_CACHE_RETRY_DELAY_MS = PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_DELAY_MS;
const MAX_STABLECOINS_CACHE_RETRY_ATTEMPTS = PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_ATTEMPTS;

function isoDateUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}


async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(Uint8Array.from(input)).body!.pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function buildMethodologyVersions(): StableMethodologyVersions {
  return {
    pegScore: SAFETY_SCORE_METHODOLOGY_VERSION,
    dews: DEPEG_DEWS_METHODOLOGY_VERSION,
    liquidityScore: LIQUIDITY_METHODOLOGY_VERSION,
    psi: PSI_METHODOLOGY_VERSION,
    reportCard: SAFETY_SCORE_METHODOLOGY_VERSION,
    chainHealth: CHAIN_HEALTH_METHODOLOGY_VERSION,
    redemptionBackstop: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
    pricingPipeline: PRICING_PIPELINE_METHODOLOGY_VERSION,
    yieldMethodology: YIELD_METHODOLOGY_VERSION,
  };
}

function utcDayStartSec(nowSec: number): number {
  return nowSec - (nowSec % DAY_SECONDS);
}

async function loadExistingSnapshot(db: D1Database, snapshotDate: string): Promise<ExistingSnapshotRow | null> {
  return db
    .prepare("SELECT content_hash, byte_size, created_at FROM public_snapshots WHERE snapshot_date = ?")
    .bind(snapshotDate)
    .first<ExistingSnapshotRow>();
}

function buildStablecoinsCacheBeforeSlotResult(
  cacheUpdatedAt: number,
  requiredUpdatedAt: number,
  freshnessGateLabel?: string,
  retry?: { attempts: number; firstCacheUpdatedAt: number },
): CronResult {
  return {
    status: "degraded",
    itemCount: 0,
    metadata: JSON.stringify({
      reason: "stablecoins_cache_before_slot",
      cacheUpdatedAt,
      requiredUpdatedAt,
      freshnessGateLabel,
      ...(retry && retry.attempts > 0
        ? { retryAttempts: retry.attempts, firstCacheUpdatedAt: retry.firstCacheUpdatedAt }
        : {}),
    }),
  };
}

function stablecoinsCachePredatesGate(
  updatedAt: number,
  options: SnapshotPublicDatasetOptions,
): options is SnapshotPublicDatasetOptions & { minStablecoinsCacheUpdatedAtSec: number } {
  return options.minStablecoinsCacheUpdatedAtSec != null && updatedAt < options.minStablecoinsCacheUpdatedAtSec;
}

function getStablecoinsCacheRetryAttempts(options: SnapshotPublicDatasetOptions): number {
  const rawAttempts = options.stablecoinsCacheRetryAttempts ?? DEFAULT_STABLECOINS_CACHE_RETRY_ATTEMPTS;
  if (!Number.isFinite(rawAttempts) || rawAttempts <= 0) return 0;
  return Math.min(MAX_STABLECOINS_CACHE_RETRY_ATTEMPTS, Math.floor(rawAttempts));
}

function getStablecoinsCacheRetryDelayMs(options: SnapshotPublicDatasetOptions): number {
  const rawDelayMs = options.stablecoinsCacheRetryDelayMs ?? DEFAULT_STABLECOINS_CACHE_RETRY_DELAY_MS;
  return Number.isFinite(rawDelayMs) && rawDelayMs > 0 ? Math.floor(rawDelayMs) : 0;
}

export async function snapshotPublicDataset(
  db: D1Database,
  signal?: AbortSignal,
  options: SnapshotPublicDatasetOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotDate = isoDateUtc(new Date(nowSec * 1000));
  const expectedPsiComputedAt = utcDayStartSec(nowSec) - DAY_SECONDS;

  const existingSnapshot = await loadExistingSnapshot(db, snapshotDate);
  throwIfAborted(signal);
  if (existingSnapshot) {
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        snapshotDate,
        skipped: "already_exists",
        contentHash: existingSnapshot.content_hash,
        byteSize: existingSnapshot.byte_size,
        createdAt: existingSnapshot.created_at,
      }),
    };
  }

  // --- 1. Stablecoins (canonical market cache; required) ---
  let stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
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
  const firstStablecoinsCacheUpdatedAt = stablecoinsCache.updatedAt;
  let stablecoinsCacheRetryAttempts = 0;
  const maxStablecoinsCacheRetryAttempts = getStablecoinsCacheRetryAttempts(options);
  const stablecoinsCacheRetryDelayMs = getStablecoinsCacheRetryDelayMs(options);
  while (
    stablecoinsCachePredatesGate(stablecoinsCache.updatedAt, options)
    && stablecoinsCacheRetryAttempts < maxStablecoinsCacheRetryAttempts
  ) {
    stablecoinsCacheRetryAttempts += 1;
    await sleepWithSignal(stablecoinsCacheRetryDelayMs, signal);
    stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
    throwIfAborted(signal);
    if (stablecoinsCache.kind !== "ok") {
      return {
        status: "degraded",
        itemCount: 0,
        metadata: JSON.stringify({
          reason: "stablecoins_cache_unavailable",
          cacheKind: stablecoinsCache.kind,
          retryAttempts: stablecoinsCacheRetryAttempts,
          firstCacheUpdatedAt: firstStablecoinsCacheUpdatedAt,
        }),
      };
    }
  }
  if (stablecoinsCachePredatesGate(stablecoinsCache.updatedAt, options)) {
    return buildStablecoinsCacheBeforeSlotResult(
      stablecoinsCache.updatedAt,
      options.minStablecoinsCacheUpdatedAtSec,
      options.freshnessGateLabel,
      { attempts: stablecoinsCacheRetryAttempts, firstCacheUpdatedAt: firstStablecoinsCacheUpdatedAt },
    );
  }

  // --- 2. Report-card cache (required and freshness-gated) ---
  const reportCardCache = await loadReportCardCache(db, {
    maxAgeMs: REPORT_CARD_CACHE_MAX_AGE_MS,
    requireCompleteness: true,
  });
  throwIfAborted(signal);
  if (reportCardCache.kind !== "ok" || !isCurrentSafetyScoreV8Identity(reportCardCache.payload.safetyScoreIdentity)) {
    const cacheReason = reportCardCache.kind === "ok" ? "identity-mismatch" : reportCardCache.reason;
    const cacheUpdatedAt = reportCardCache.updatedAt;
    console.warn(`[snapshot-public-dataset] Report-card cache unavailable: ${cacheReason}`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "report_card_cache_unavailable",
        cacheReason,
        updatedAt: cacheUpdatedAt,
      }),
    };
  }
  const reportCards = reportCardCache.payload;
  const safetyScoreIdentity = reportCards.safetyScoreIdentity;

  // --- 3. Latest PSI row (required to be the completed prior UTC day) ---
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
  if (!psiRow) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "psi_snapshot_missing", expectedComputedAt: expectedPsiComputedAt }),
    };
  }
  if (psiRow.computed_at !== expectedPsiComputedAt) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "psi_snapshot_stale",
        expectedComputedAt: expectedPsiComputedAt,
        actualComputedAt: psiRow.computed_at,
      }),
    };
  }

  // --- 4. DEWS stress signals (one completed publication generation) ---
  const sectionReadFailures: SnapshotSectionReadFailure[] = [];
  let stressRows: StressSignalRow[] = [];
  const publishedDews = await loadPublishedStressSignalGeneration(db, nowSec);
  throwIfAborted(signal);
  if (publishedDews.status === "ok") {
    stressRows = publishedDews.rows;
  } else {
    recordCronFailure("snapshot-public-dataset", publishedDews.reason, { metadata: { stage: "read-dews" } });
    sectionReadFailures.push({ section: "dews", error: publishedDews.reason.slice(0, 200) });
  }

  // --- 5. DEX liquidity (latest per coin) ---
  let dexRows: DexLiquidityRow[] = [];
  try {
    const result = await db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd, total_volume_24h_usd, pool_count, liquidity_score,
                durability_score, coverage_class, updated_at
         FROM dex_liquidity
         WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}
         ORDER BY liquidity_score DESC`,
      )
      .all<DexLiquidityRow>();
    throwIfAborted(signal);
    dexRows = result.results ?? [];
  } catch (err) {
    rethrowIfAborted(err, signal);
    recordCronFailure("snapshot-public-dataset", err, { metadata: { stage: "read-liquidity" } });
    sectionReadFailures.push({ section: "liquidity", error: toErrorMessage(err).slice(0, 200) });
  }

  if (sectionReadFailures.length > 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "public_snapshot_section_read_failed",
        snapshotDate,
        missingSections: sectionReadFailures.map((failure) => failure.section),
        failedSections: sectionReadFailures,
      }),
    };
  }

  const methodologyVersions = buildMethodologyVersions();
  const snapshotMetadata = {
    ...methodologyVersions,
    safetyScoreIdentity,
  };

  const envelope = {
    snapshotDate,
    generatedAt: nowSec,
    methodologyVersions,
    safetyScoreIdentity,
    stablecoins: stablecoinsCache.payload.peggedAssets,
    fxFallbackRates: stablecoinsCache.payload.fxFallbackRates ?? null,
    reportCards,
    psi: {
      computedAt: psiRow.computed_at,
      score: psiRow.score,
      band: psiRow.band,
      components: safeJsonParse<Record<string, unknown> | null>(
        psiRow.components,
        null,
        `snapshot-public-dataset:psi:${snapshotDate}:components`,
      ),
      methodologyVersion: psiRow.methodology_version ?? methodologyVersions.psi,
    },
    dews: stressRows.map((row) => ({
      stablecoinId: row.stablecoin_id,
      computedAt: row.computed_at,
      score: row.score,
      band: row.band,
      signals: safeJsonParse<Record<string, unknown> | null>(
        row.signals_json,
        null,
        `snapshot-public-dataset:dews:${row.stablecoin_id}:${row.computed_at}:signals_json`,
      ),
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
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO public_snapshots
         (snapshot_date, payload_gz, methodology_versions, content_hash, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        snapshotDate,
        payloadGz,
        JSON.stringify(snapshotMetadata),
        contentHash,
        byteSize,
        nowSec,
      )
      .run();
    if (result.meta.changes === 0) {
      return {
        itemCount: 0,
        metadata: JSON.stringify({
          snapshotDate,
          skipped: "already_exists",
          contentHash,
          byteSize,
          compressedSize: payloadGz.byteLength,
        }),
      };
    }
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
      ...(stablecoinsCacheRetryAttempts > 0
        ? {
          stablecoinsCacheRetryAttempts,
          firstStablecoinsCacheUpdatedAt,
          finalStablecoinsCacheUpdatedAt: stablecoinsCache.updatedAt,
        }
        : {}),
      dewsCount: stressRows.length,
      liquidityCount: dexRows.length,
    }),
  };
}
