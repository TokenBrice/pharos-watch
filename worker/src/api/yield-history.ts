import { buildMethodologyEnvelope } from "../lib/api-methodology";
import { parseStablecoinHistoryQuery } from "../lib/api-history";
import { jsonFreshResponse, errorResponse } from "../lib/api-response";
import { getLatestSuccessfulCronTimestampResult } from "../lib/api-freshness";
import { CACHE_PROFILES } from "../lib/constants";
import { getCache } from "../lib/db-cache";
import { buildOnChainSourceKey, isOnChainBootstrapYieldSeed, parseYieldWarningSignals } from "../lib/yield-utils";
import { resolveYieldSourceUrl } from "../lib/yield-source-links";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import { logWorkerEventArgs } from "../lib/structured-log";
import { parseJson } from "../lib/json-parse";
import { parseYieldRankingsPublishedCutoff } from "../lib/yield-rankings-cache";
import { isSuppressedYieldHistoryRow } from "../lib/yield-history-ownership-handoffs";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { isRecord } from "@shared/lib/type-guards";
import { YIELD_HISTORY_RAW_DAYS } from "@shared/lib/yield-history-policy";
import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "@shared/lib/api-query-history";
import {
  YIELD_BENCHMARK_KEY_CURRENCY,
  normalizeYieldSourceRisk,
  YieldPysInputsAtPublishSchema,
  type YieldPysInputsAtPublish,
  type YieldPublicationMetadata,
  type YieldSourceRisk,
} from "@shared/types/yield";
import { computePYS } from "@shared/lib/yield-scoring";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/yield-methodology";

interface YieldHistoryRow {
  recorded_at: number;
  apy: number;
  apy_base: number | null;
  apy_reward: number | null;
  exchange_rate: number | null;
  source_tvl_usd: number | null;
  warning_signals: string | null;
  source_key: string | null;
  yield_source: string | null;
  yield_type: string | null;
  data_source: string | null;
  is_best: number | null;
  publication_generation_id?: string | null;
  pys_at_publish?: number | null;
  safety_at_publish?: number | null;
  variance_at_publish?: number | null;
  pys_inputs_at_publish?: string | null;
}

const LEGACY_LUSD_BPROTOCOL_SOURCE_KEY = "bprotocol-lqty-only";

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function buildSourceRiskLookupKey(generationId: string, stablecoinId: string, sourceKey: string): string {
  return `${generationId}\u0000${stablecoinId}\u0000${sourceKey}`;
}

function buildYieldHistorySourceRiskLookup(cached: { value: string } | null): Map<string, YieldSourceRisk | null> {
  const lookup = new Map<string, YieldSourceRisk | null>();
  if (!cached) return lookup;

  try {
    const parsed = parseJson(cached.value);
    if (!parsed.ok) return lookup;
    const payload = parsed.value;
    if (!isRecord(payload) || !Array.isArray(payload.rankings)) return lookup;
    const rootPublication = isRecord(payload.publication) ? payload.publication : null;
    const rootGenerationId = typeof rootPublication?.generationId === "string" ? rootPublication.generationId : null;

    for (const row of payload.rankings) {
      if (!isRecord(row)) continue;
      const stablecoinId = typeof row.id === "string" ? row.id : null;
      const generationId =
        typeof row.publicationGenerationId === "string" ? row.publicationGenerationId : rootGenerationId;
      const provenance = isRecord(row.provenance) ? row.provenance : null;
      const sourceKey = typeof provenance?.sourceKey === "string" ? provenance.sourceKey : null;
      if (stablecoinId && generationId && sourceKey && hasOwn(row, "sourceRisk")) {
        lookup.set(
          buildSourceRiskLookupKey(generationId, stablecoinId, sourceKey),
          normalizeYieldSourceRisk(row.sourceRisk),
        );
      }

      if (!stablecoinId || !generationId || !Array.isArray(row.altSources)) continue;
      for (const alt of row.altSources) {
        if (!isRecord(alt) || typeof alt.sourceKey !== "string" || !hasOwn(alt, "sourceRisk")) continue;
        lookup.set(
          buildSourceRiskLookupKey(generationId, stablecoinId, alt.sourceKey),
          normalizeYieldSourceRisk(alt.sourceRisk),
        );
      }
    }
  } catch {
    return lookup;
  }

  return lookup;
}

function parseYieldPublicationMetadata(
  cached: { value: string; updatedAt: number } | null,
): YieldPublicationMetadata | null {
  if (!cached) return null;
  try {
    const parsed = parseJson(cached.value);
    if (!parsed.ok) return null;
    const payload = parsed.value;
    if (!isRecord(payload) || !isRecord(payload.publication)) return null;
    const publication = payload.publication;
    const generationId = typeof publication.generationId === "string" ? publication.generationId : null;
    const status = publication.status === "published" ? "published" : null;
    if (!generationId || !status) return null;
    const updatedAt =
      typeof publication.updatedAt === "number" && Number.isFinite(publication.updatedAt)
        ? publication.updatedAt
        : cached.updatedAt;
    const cutoffAt =
      typeof publication.cutoffAt === "number" && Number.isFinite(publication.cutoffAt)
        ? publication.cutoffAt
        : updatedAt;
    const schemaVersion =
      typeof publication.schemaVersion === "number" && Number.isFinite(publication.schemaVersion)
        ? Math.floor(publication.schemaVersion)
        : 1;
    return {
      generationId,
      updatedAt,
      cutoffAt,
      schemaVersion,
      status,
    };
  } catch {
    return null;
  }
}

function normalizeHistorySourceKey(stablecoinId: string, row: YieldHistoryRow, mode: "best" | "source"): string {
  const sourceKey = row.source_key ?? "legacy-best";
  if (
    mode === "best" &&
    stablecoinId === "lusd-liquity" &&
    row.data_source === "onchain" &&
    sourceKey === LEGACY_LUSD_BPROTOCOL_SOURCE_KEY
  ) {
    return buildOnChainSourceKey(stablecoinId);
  }
  return sourceKey;
}

/**
 * Replay `computePYS` from a stored publish-time snapshot and report whether it
 * reproduces `pysAtPublish` (B4). A row the publisher left NR carries no number
 * to reproduce; a v8.42 snapshot predates the USD hurdle re-base, so a non-USD
 * row legitimately cannot be reproduced from it; anything else that fails to
 * reproduce is a current producer defect.
 */
function classifyPysReproducibility(
  inputs: YieldPysInputsAtPublish,
  pysAtPublish: number | null,
): "exact" | "not-scored" | "legacy-partial" | "invalid" {
  // NR rows are gated on evidence the snapshot does not carry (freshness), so
  // their snapshot is unverifiable rather than non-reproducible.
  if (pysAtPublish == null) return "not-scored";
  const benchmarkCurrency = YIELD_BENCHMARK_KEY_CURRENCY[inputs.benchmarkKey];
  const replayed = computePYS({
    apy30d: inputs.apy30d,
    safetyScore: inputs.safetyScore,
    apyVarianceScore: inputs.varianceScore,
    scalingFactor: inputs.scalingFactor,
    benchmarkRate: inputs.benchmarkRate,
    benchmarkCurrency,
    usdBenchmarkRate: inputs.usdBenchmarkRate ?? null,
    sourceRiskPenalty: inputs.sourceRiskPenalty,
  });
  if (replayed === pysAtPublish) return "exact";
  if (inputs.usdBenchmarkRate == null && benchmarkCurrency !== "USD") return "legacy-partial";
  return "invalid";
}

/**
 * GET /api/yield-history?stablecoin=<id>&days=<n>&mode=best&sourceKey=<key>
 * Returns historical yield data points for a given stablecoin.
 *
 * - default mode (`best`) returns the historically selected best source rows
 * - `sourceKey=<key>` returns source-specific history for that key
 */
export const handleYieldHistory = async (db: D1Database, url: URL): Promise<Response> => {
    const parsed = parseStablecoinHistoryQuery(url, STABLECOIN_HISTORY_QUERY_CONTRACTS.yield);
    if (parsed instanceof Response) {
      return parsed;
    }

    const requestedMode = url.searchParams.get("mode")?.trim() ?? "best";
    const sourceKey = url.searchParams.get("sourceKey")?.trim() ?? null;
    const mode = sourceKey ? "source" : requestedMode;
    if (mode !== "best" && mode !== "source") {
      return errorResponse(400, "Invalid mode: expected 'best' or 'source'");
    }
    if (mode === "source" && !sourceKey) {
      return errorResponse(400, "Missing ?sourceKey= parameter for source history mode");
    }

    const rankingsCache = await getCache(db, "yield-rankings");
    const publication = parseYieldPublicationMetadata(rankingsCache);
    const sourceRiskByHistoryKey = buildYieldHistorySourceRiskLookup(rankingsCache);
    const publishedCutoffResult = parseYieldRankingsPublishedCutoff(rankingsCache);
    const publishedCutoffLookup =
      publishedCutoffResult.status === "ok"
        ? { timestamp: publishedCutoffResult.updatedAt, status: "ok" as const }
        : await getLatestSuccessfulCronTimestampResult(db, "sync-yield-data");
    const fallbackPublishedCutoff = rankingsCache?.updatedAt ?? 0;
    const publishedCutoff =
      publishedCutoffResult.status === "ok"
        ? (publication?.cutoffAt ?? publishedCutoffResult.updatedAt)
        : (publishedCutoffLookup.timestamp ?? fallbackPublishedCutoff);
    // The published cutoff bounds both history windows, so a 0 (neither the
    // cached payload nor the cron timestamp was readable) would silently serve an
    // empty history with HTTP 200. Skip the cap and say so instead (C19).
    const publishedCutoffCap =
      publishedCutoff > 0 ? publishedCutoff : Number.MAX_SAFE_INTEGER;
    const freshnessWarning =
      publishedCutoffLookup.status === "lookup_failed"
        ? "Yield history freshness lookup failed; falling back to cache metadata."
        : publishedCutoff > 0
          ? null
          : "Yield history published cutoff unavailable; serving history without the published cutoff cap.";

    if (publishedCutoffResult.status !== "ok") {
      logMalformedJsonPath({
        scope: "api",
        owner: "yield-history",
        context: "yield-rankings.updatedAt",
        reason: publishedCutoffResult.status,
        source: "cache:yield-rankings",
        updatedAt: rankingsCache?.updatedAt ?? null,
        extra: {
          fallbackCutoff: publishedCutoff,
          lookupStatus: publishedCutoffLookup.status,
        },
      });
    }

    const publicationFilter = "AND (publication_generation_id IS NULL OR publication_state = 'published')";
    const rawCutoff = Math.max(parsed.cutoff, publishedCutoffCap - YIELD_HISTORY_RAW_DAYS * 24 * 60 * 60);
    const historyColumns =
      "recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, warning_signals, source_key, yield_source, yield_type, data_source, is_best, publication_generation_id, pys_at_publish, safety_at_publish, variance_at_publish, pys_inputs_at_publish";

    const sql =
      mode === "source"
        ? `SELECT /* pharos:yield-history:source-window-tiered */ * FROM (
             SELECT ${historyColumns}
               FROM yield_history_daily
              WHERE stablecoin_id = ? AND recorded_at >= ? AND recorded_at < ? AND source_key = ?
                ${publicationFilter}
             UNION ALL
             SELECT ${historyColumns}
               FROM yield_history h
              WHERE stablecoin_id = ? AND recorded_at >= ? AND recorded_at <= ? AND source_key = ?
                ${publicationFilter}
                AND (
                  recorded_at >= ?
                  OR NOT EXISTS (
                    SELECT 1 FROM yield_history_daily d
                     WHERE d.stablecoin_id = h.stablecoin_id
                       AND d.source_key = h.source_key
                       AND d.snapshot_date = CAST(h.recorded_at / 86400 AS INTEGER) * 86400
                  )
                )
           ) ORDER BY recorded_at ASC`
        : `SELECT /* pharos:yield-history:best-window-tiered */ * FROM (
             SELECT ${historyColumns}
               FROM yield_history_daily
              WHERE stablecoin_id = ? AND recorded_at >= ? AND recorded_at < ? AND is_best = 1
                ${publicationFilter}
             UNION ALL
             SELECT ${historyColumns}
               FROM yield_history h
              WHERE stablecoin_id = ? AND recorded_at >= ? AND recorded_at <= ? AND is_best = 1
                ${publicationFilter}
                AND (
                  recorded_at >= ?
                  OR NOT EXISTS (
                    SELECT 1 FROM yield_history_daily d
                     WHERE d.stablecoin_id = h.stablecoin_id
                       AND d.source_key = h.source_key
                       AND d.snapshot_date = CAST(h.recorded_at / 86400 AS INTEGER) * 86400
                  )
                )
           ) ORDER BY recorded_at ASC`;

    const result =
      mode === "source"
        ? await db
            .prepare(sql)
            .bind(
              parsed.stablecoinId,
              parsed.cutoff,
              rawCutoff,
              sourceKey,
              parsed.stablecoinId,
              parsed.cutoff,
              publishedCutoffCap,
              sourceKey,
              rawCutoff,
            )
            .all<YieldHistoryRow>()
        : await db
            .prepare(sql)
            .bind(
              parsed.stablecoinId,
              parsed.cutoff,
              rawCutoff,
              parsed.stablecoinId,
              parsed.cutoff,
              publishedCutoffCap,
              rawCutoff,
            )
            .all<YieldHistoryRow>();

    let previousSourceKey: string | null = null;
    let invalidPysSnapshotCount = 0;
    const invalidPysSnapshotSamples: string[] = [];
    const history = (result.results ?? [])
      .filter(
        (row) => !isSuppressedYieldHistoryRow(parsed.stablecoinId, row.source_key) && !isOnChainBootstrapYieldSeed(row),
      )
      .map((row) => {
        const normalizedSourceKey = normalizeHistorySourceKey(parsed.stablecoinId, row, mode);
        const sourceRiskKey = row.publication_generation_id
          ? buildSourceRiskLookupKey(row.publication_generation_id, parsed.stablecoinId, normalizedSourceKey)
          : null;
        const hasSourceRisk = sourceRiskKey != null && sourceRiskByHistoryKey.has(sourceRiskKey);
        const sourceRisk = sourceRiskKey != null ? sourceRiskByHistoryKey.get(sourceRiskKey) : undefined;
        const sourceSwitch = mode === "best" && previousSourceKey != null && previousSourceKey !== normalizedSourceKey;
        previousSourceKey = normalizedSourceKey;

        const pysAtPublish =
          typeof row.pys_at_publish === "number" && Number.isFinite(row.pys_at_publish)
            ? row.pys_at_publish
            : row.pys_at_publish === null
              ? null
              : undefined;
        const safetyAtPublish =
          typeof row.safety_at_publish === "number" && Number.isFinite(row.safety_at_publish)
            ? row.safety_at_publish
            : row.safety_at_publish === null
              ? null
              : undefined;
        const varianceAtPublish =
          typeof row.variance_at_publish === "number" && Number.isFinite(row.variance_at_publish)
            ? row.variance_at_publish
            : row.variance_at_publish === null
              ? null
              : undefined;
        let pysInputsAtPublish = null;
        if (row.pys_inputs_at_publish) {
          const parsedJson = parseJson(row.pys_inputs_at_publish);
          const parsedInputs = parsedJson.ok
            ? YieldPysInputsAtPublishSchema.safeParse(parsedJson.value)
            : null;
          pysInputsAtPublish = parsedInputs?.success ? parsedInputs.data : null;
        }
        const pysReproducibility =
          pysInputsAtPublish == null
            ? ("legacy-partial" as const)
            : classifyPysReproducibility(pysInputsAtPublish, pysAtPublish ?? null);
        if (pysReproducibility === "invalid") {
          invalidPysSnapshotCount += 1;
          if (invalidPysSnapshotSamples.length < 5) {
            invalidPysSnapshotSamples.push(
              `${row.source_key ?? normalizedSourceKey}@${row.recorded_at}`,
            );
          }
        }

        return {
          date: row.recorded_at,
          apy: row.apy,
          apyBase: row.apy_base,
          apyReward: row.apy_reward,
          exchangeRate: row.exchange_rate,
          sourceTvlUsd: row.source_tvl_usd,
          warningSignals: parseYieldWarningSignals(row.warning_signals),
          sourceKey: normalizedSourceKey,
          yieldSource: row.yield_source,
          yieldSourceUrl: resolveYieldSourceUrl({
            stablecoinId: parsed.stablecoinId,
            sourceKey: normalizedSourceKey,
            yieldSource: row.yield_source,
          }),
          yieldType: row.yield_type,
          dataSource: row.data_source,
          isBest: row.is_best === 1,
          publicationGenerationId: row.publication_generation_id ?? null,
          ...(hasSourceRisk ? { sourceRisk: sourceRisk ?? null } : {}),
          sourceSwitch,
          ...(pysAtPublish !== undefined ? { pysAtPublish } : {}),
          ...(safetyAtPublish !== undefined ? { safetyAtPublish } : {}),
          ...(varianceAtPublish !== undefined ? { varianceAtPublish } : {}),
          pysInputsAtPublish,
          pysReproducibility,
        };
      });

    if (invalidPysSnapshotCount > 0) {
      logWorkerEventArgs(
        "api",
        "warn",
        `[yield-history] ${invalidPysSnapshotCount} published snapshot(s) do not replay to pys_at_publish`
          + ` stablecoin=${parsed.stablecoinId}`
          + ` samples=${invalidPysSnapshotSamples.join(",")}`,
      );
    }

    const latestHistoryTimestamp =
      history.length > 0
        ? Math.max(...history.map((row) => (typeof row.date === "number" ? row.date : 0)))
        : publishedCutoff;

    const current = history.length > 0 ? (history[history.length - 1] ?? null) : null;

    return jsonFreshResponse(
      {
        current,
        history,
        ...(freshnessWarning ? { warning: freshnessWarning } : {}),
        ...(publication ? { publication } : {}),
        methodology: buildMethodologyEnvelope({
          version: YIELD_METHODOLOGY_VERSION,
          versionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
          currentVersion: YIELD_METHODOLOGY_VERSION,
          currentVersionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
          changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
          asOf: latestHistoryTimestamp,
        }),
      },
      {
        cacheControl: CACHE_PROFILES.slow,
        updatedAt: latestHistoryTimestamp,
        maxAgeSec: CRON_INTERVALS["sync-yield-data"],
      },
    );
  };
