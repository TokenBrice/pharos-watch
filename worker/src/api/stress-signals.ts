import { resolveOrReject, parseQueryParams } from "../lib/api-params";
import { addFreshnessHeaders } from "../lib/api-freshness";
import { errorResponse, jsonResponse } from "../lib/api-response";
import { safeJsonParse } from "../lib/api-cache-read";
import { buildMethodologyEnvelope } from "../lib/api-methodology";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CACHE_PROFILES } from "../lib/constants";
import {
  loadStressSignalCurrentRowForCoin,
  loadStressSignalCurrentRows,
} from "../lib/stress-signals-current-rows";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  getDepegDewsMethodologyVersionAt,
} from "@shared/lib/methodology-versions/depeg-dews";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import { ACTIVE_IDS, READABLE_IDS } from "@shared/lib/stablecoins/registry";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";

type StressSignalAgeClassification = "fresh" | "lagging" | "stale" | "retainedLastValid";
type StressSignalDataStatus = "ok" | "degraded" | "unavailable";
type StressSignalDataReason =
  | "no-current-rows"
  | "no-readable-current-rows"
  | "all-current-rows-malformed"
  | "single-coin-current-row-missing"
  | "current-row-malformed"
  | "computed-count-zero"
  | "partial-coverage";

interface AggregateCoverage {
  status: StressSignalDataStatus;
  reasons: StressSignalDataReason[];
}

const STRESS_SIGNALS_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.stressSignals;
const STRESS_SIGNALS_LATEST_FALLBACK_AGE_SEC = STRESS_SIGNALS_MAX_AGE_SEC * 8;

function classifyStressSignalAge(
  computedAt: number,
  nowSec: number,
  newestReturnedComputedAt?: number | null,
): StressSignalAgeClassification {
  // The current table stores only the last valid row for each coin. It does not
  // retain a per-cycle "skipped due insufficient data" marker, so aggregate rows
  // older than the newest returned row are the best available retained-last-valid
  // signal. Single-coin mode can only classify by wall-clock age.
  if (newestReturnedComputedAt != null && computedAt < newestReturnedComputedAt) {
    return "retainedLastValid";
  }

  const ageSec = Math.max(0, nowSec - computedAt);
  if (ageSec <= STRESS_SIGNALS_MAX_AGE_SEC) return "fresh";
  if (ageSec <= STRESS_SIGNALS_MAX_AGE_SEC * 8) return "lagging";
  return "stale";
}

function buildUnavailableHeaders(warning: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    Warning: `199 - "${warning}"`,
  };
}

function buildAggregateCoverage(input: {
  rawRows: number;
  readableRows: number;
  computedCount: number;
  missingCount: number;
  malformedRows: number;
}): AggregateCoverage {
  const reasons: StressSignalDataReason[] = [];

  if (input.rawRows === 0) {
    reasons.push("no-current-rows");
  } else if (input.readableRows === 0) {
    reasons.push("no-readable-current-rows");
  } else if (input.computedCount === 0 && input.malformedRows > 0) {
    reasons.push("all-current-rows-malformed");
  }

  if (input.computedCount === 0) {
    reasons.push("computed-count-zero");
  } else if (input.missingCount > 0 || input.malformedRows > 0) {
    reasons.push("partial-coverage");
  }

  if (input.computedCount === 0) {
    return { status: "unavailable", reasons };
  }
  if (reasons.length > 0) {
    return { status: "degraded", reasons };
  }
  return { status: "ok", reasons };
}

export const handleStressSignals = async (db: D1Database, url: URL): Promise<Response> => {
    const nowSec = Math.floor(Date.now() / 1000);
    const stablecoinId = url.searchParams.get("stablecoin");
    const parsedParams = parseQueryParams(url.searchParams, {
      days: { type: "int", default: 30, min: 1, max: 365, rangePolicy: "reject" },
    });
    if (parsedParams instanceof Response) return parsedParams;
    const { days } = parsedParams;

    if (stablecoinId) {
      const resolved = resolveOrReject(stablecoinId);
      if (resolved instanceof Response) {
        return resolved;
      }
      const canonicalId = resolved.canonicalId;

      if (!READABLE_IDS.has(canonicalId)) {
        return errorResponse(404, "Stablecoin not tracked");
      }
      // Single coin: latest valid row + daily history. computeDEWS() can return
      // null for insufficient data; those runs skip writes, so this naturally
      // serves the last valid cached value.
      const latest = await loadStressSignalCurrentRowForCoin(db, canonicalId, nowSec, {
        staleAfterSec: STRESS_SIGNALS_LATEST_FALLBACK_AGE_SEC,
      });

      const cutoff = nowSec - days * DAY_SECONDS;
      const history = await db
        .prepare(
          `SELECT /* pharos:stress-signals:history-one */
             snapshot_date, score, band, signals_json
           FROM stress_signal_history
           WHERE stablecoin_id = ? AND snapshot_date >= ?
           ORDER BY snapshot_date ASC`,
        )
        .bind(canonicalId, cutoff)
        .all<{
          snapshot_date: number;
          score: number;
          band: string;
          signals_json: string;
        }>();

      let malformedRows = 0;
      const currentParsed = latest
        ? safeJsonParse<Record<string, unknown> | null>(
            latest.signals_json,
            null,
            `stress-signals:${canonicalId}:current:signals_json`,
          )
        : null;
      const currentUnwrapped = unwrapStressSignalsEnvelope(currentParsed);
      if (latest && currentUnwrapped == null) malformedRows++;
      const currentReasons: StressSignalDataReason[] = [];
      if (!latest) {
        currentReasons.push("single-coin-current-row-missing", "computed-count-zero");
      } else if (currentUnwrapped == null) {
        currentReasons.push("current-row-malformed", "computed-count-zero");
      }
      const currentStatus: StressSignalDataStatus = currentUnwrapped == null ? "unavailable" : "ok";

      const historyRows = history.results.map((r) => {
        const parsed = safeJsonParse<Record<string, unknown> | null>(
          r.signals_json,
          null,
          `stress-signals:${canonicalId}:${r.snapshot_date}:signals_json`,
        );
        const unwrapped = unwrapStressSignalsEnvelope(parsed);
        if (unwrapped == null) {
          malformedRows++;
          return null;
        }
        return {
          date: r.snapshot_date,
          score: r.score,
          band: r.band,
          signals: unwrapped.signals,
          amplifiers: unwrapped.amplifiers,
          methodologyVersion: getDepegDewsMethodologyVersionAt(r.snapshot_date),
        };
      }).filter((row): row is NonNullable<typeof row> => row !== null);

      const currentComputedAt = latest && currentUnwrapped ? latest.computed_at : null;
      const latestHistoryRow = historyRows.length > 0 ? historyRows[historyRows.length - 1] : null;
      const methodologyAsOf = currentComputedAt ?? latestHistoryRow?.date ?? 0;
      const methodologyVersion = methodologyAsOf > 0
        ? getDepegDewsMethodologyVersionAt(methodologyAsOf)
        : DEPEG_DEWS_METHODOLOGY_VERSION;
      const responseHeaders = currentComputedAt != null
        ? addFreshnessHeaders({
            "Cache-Control": CACHE_PROFILES.standard,
          }, currentComputedAt, STRESS_SIGNALS_MAX_AGE_SEC)
        : buildUnavailableHeaders("DEWS current row unavailable");

      return jsonResponse({
        current: latest && currentUnwrapped
          ? {
              score: latest.score,
              band: latest.band,
              signals: currentUnwrapped.signals,
              amplifiers: currentUnwrapped.amplifiers,
              computedAt: latest.computed_at,
              methodologyVersion: getDepegDewsMethodologyVersionAt(latest.computed_at),
              ageClassification: classifyStressSignalAge(latest.computed_at, nowSec),
            }
          : null,
        history: historyRows,
        malformedRows,
        currentStatus,
        currentReasons,
        methodology: buildMethodologyEnvelope({
          version: methodologyVersion,
          versionLabel: toMethodologyVersionLabel(methodologyVersion),
          currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
          currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
          changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
          asOf: methodologyAsOf,
        }),
      }, { headers: responseHeaders });
    }

    // All coins: latest valid row per coin.
    const rows = await loadStressSignalCurrentRows(db, nowSec, {
      staleAfterSec: STRESS_SIGNALS_LATEST_FALLBACK_AGE_SEC,
    });

    const signals: Record<string, object> = {};
    let updatedAt = 0;
    let oldestComputedAt: number | null = null;
    let malformedRows = 0;
    const readableRows = new Set<string>();
    const validRows: Array<{
      stablecoinId: string;
      score: number;
      band: string;
      signals: Record<string, unknown>;
      amplifiers: { psi: number; contagion: number };
      computedAt: number;
      methodologyVersion: string;
    }> = [];
    for (const row of rows.results) {
      if (!ACTIVE_IDS.has(row.stablecoin_id)) {
        continue;
      }
      readableRows.add(row.stablecoin_id);
      const parsed = safeJsonParse<Record<string, unknown> | null>(
        row.signals_json,
        null,
        `stress-signals:${row.stablecoin_id}:${row.computed_at}:signals_json`,
      );
      const unwrapped = unwrapStressSignalsEnvelope(parsed);
      if (unwrapped == null) {
        malformedRows++;
        continue;
      }
      const methodologyVersion = getDepegDewsMethodologyVersionAt(row.computed_at);
      validRows.push({
        stablecoinId: row.stablecoin_id,
        score: row.score,
        band: row.band,
        signals: unwrapped.signals,
        amplifiers: unwrapped.amplifiers,
        computedAt: row.computed_at,
        methodologyVersion,
      });
      updatedAt = Math.max(updatedAt, row.computed_at);
      oldestComputedAt = oldestComputedAt == null
        ? row.computed_at
        : Math.min(oldestComputedAt, row.computed_at);
    }

    for (const row of validRows) {
      signals[row.stablecoinId] = {
        score: row.score,
        band: row.band,
        signals: row.signals,
        amplifiers: row.amplifiers,
        computedAt: row.computedAt,
        methodologyVersion: row.methodologyVersion,
        ageClassification: classifyStressSignalAge(row.computedAt, nowSec, updatedAt),
      };
    }

    const eligibleCount = ACTIVE_IDS.size;
    const computedCount = validRows.length;
    const missingCount = Math.max(0, eligibleCount - readableRows.size);
    const coverageRatio = eligibleCount > 0 ? Number((computedCount / eligibleCount).toFixed(4)) : 0;
    const coverage = buildAggregateCoverage({
      rawRows: rows.results.length,
      readableRows: readableRows.size,
      computedCount,
      missingCount,
      malformedRows,
    });

    const asOf = updatedAt > 0 ? updatedAt : 0;
    const methodologyVersion = updatedAt > 0
      ? getDepegDewsMethodologyVersionAt(updatedAt)
      : DEPEG_DEWS_METHODOLOGY_VERSION;
    const responseHeaders = updatedAt > 0
      ? addFreshnessHeaders({
          "Cache-Control": CACHE_PROFILES.standard,
        }, updatedAt, STRESS_SIGNALS_MAX_AGE_SEC)
      : buildUnavailableHeaders("DEWS current rows unavailable");

    return jsonResponse({ signals, updatedAt, oldestComputedAt: oldestComputedAt ?? undefined, eligibleCount, computedCount, missingCount, malformedRows, coverageRatio, coverageStatus: coverage.status, coverageReasons: coverage.reasons, methodology: buildMethodologyEnvelope({
      version: methodologyVersion,
      versionLabel: toMethodologyVersionLabel(methodologyVersion),
      currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
      currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
      changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
      asOf,
    }) }, { headers: responseHeaders });
  };
