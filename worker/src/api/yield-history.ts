import {
  buildMethodologyEnvelope,
  parseStablecoinHistoryQuery,
  jsonFreshResponse,
  getLatestSuccessfulCronTimestampResult,
  errorResponse,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getCache } from "../lib/db-cache";
import { isMissingColumnError } from "../lib/db";
import { buildOnChainSourceKey, isOnChainBootstrapYieldSeed, parseYieldWarningSignals } from "../lib/yield-utils";
import { resolveYieldSourceUrl } from "../lib/yield-source-links";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import { parseJson } from "../lib/json-parse";
import { parseYieldRankingsPublishedCutoff } from "../cron/yield-sync/cache";
import { isSuppressedYieldHistoryRow } from "../cron/yield-sync/history";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { isRecord } from "@shared/lib/type-guards";
import { YIELD_HISTORY_MAX_DAYS } from "@shared/lib/yield-history-policy";
import {
  normalizeYieldSourceRisk,
  YieldPysInputsAtPublishSchema,
  type YieldPublicationMetadata,
  type YieldSourceRisk,
} from "@shared/types/yield";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";

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
 * GET /api/yield-history?stablecoin=<id>&days=<n>&mode=best&sourceKey=<key>
 * Returns historical yield data points for a given stablecoin.
 *
 * - default mode (`best`) returns the historically selected best source rows
 * - `sourceKey=<key>` returns source-specific history for that key
 */
export const handleYieldHistory = async (db: D1Database, url: URL): Promise<Response> => {
    const parsed = parseStablecoinHistoryQuery(url, {
      defaultDays: 90,
      minDays: 1,
      maxDays: YIELD_HISTORY_MAX_DAYS,
      rangePolicy: "reject",
    });
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
    const freshnessWarning =
      publishedCutoffLookup.status === "lookup_failed"
        ? "Yield history freshness lookup failed; falling back to cache metadata."
        : null;

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

    const sql =
      mode === "source"
        ? `SELECT /* pharos:yield-history:source-window */
         recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, warning_signals, source_key, yield_source, yield_type, data_source, is_best, publication_generation_id, pys_at_publish, safety_at_publish, variance_at_publish, pys_inputs_at_publish
       FROM yield_history
       WHERE stablecoin_id = ? AND recorded_at >= ? AND recorded_at <= ? AND source_key = ?
       ${publicationFilter}
       ORDER BY recorded_at ASC`
        : `SELECT /* pharos:yield-history:best-window */
         recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, warning_signals, source_key, yield_source, yield_type, data_source, is_best, publication_generation_id, pys_at_publish, safety_at_publish, variance_at_publish, pys_inputs_at_publish
       FROM yield_history
       WHERE stablecoin_id = ? AND recorded_at >= ? AND recorded_at <= ? AND is_best = 1
       ${publicationFilter}
       ORDER BY recorded_at ASC`;

    let result: D1Result<YieldHistoryRow>;
    try {
      result =
        mode === "source"
          ? await db
              .prepare(sql)
              .bind(parsed.stablecoinId, parsed.cutoff, publishedCutoff, sourceKey)
              .all<YieldHistoryRow>()
          : await db.prepare(sql).bind(parsed.stablecoinId, parsed.cutoff, publishedCutoff).all<YieldHistoryRow>();
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      const legacySql =
        mode === "source"
          ? `SELECT /* pharos:yield-history:source-window:legacy-schema */
         recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, warning_signals, source_key, yield_source, yield_type, data_source, is_best, publication_generation_id, NULL AS pys_at_publish, NULL AS safety_at_publish, NULL AS variance_at_publish, NULL AS pys_inputs_at_publish
       FROM yield_history
       WHERE stablecoin_id = ? AND recorded_at >= ? AND recorded_at <= ? AND source_key = ?
       ${publicationFilter}
       ORDER BY recorded_at ASC`
          : `SELECT /* pharos:yield-history:best-window:legacy-schema */
         recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, warning_signals, source_key, yield_source, yield_type, data_source, is_best, publication_generation_id, NULL AS pys_at_publish, NULL AS safety_at_publish, NULL AS variance_at_publish, NULL AS pys_inputs_at_publish
       FROM yield_history
       WHERE stablecoin_id = ? AND recorded_at >= ? AND recorded_at <= ? AND is_best = 1
       ${publicationFilter}
       ORDER BY recorded_at ASC`;
      result =
        mode === "source"
          ? await db
              .prepare(legacySql)
              .bind(parsed.stablecoinId, parsed.cutoff, publishedCutoff, sourceKey)
              .all<YieldHistoryRow>()
          : await db
              .prepare(legacySql)
              .bind(parsed.stablecoinId, parsed.cutoff, publishedCutoff)
              .all<YieldHistoryRow>();
    }

    let previousSourceKey: string | null = null;
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
          pysReproducibility: pysInputsAtPublish ? ("exact" as const) : ("legacy-partial" as const),
        };
      });

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
