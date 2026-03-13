import {
  withErrorHandler,
  resolveOrReject,
  addFreshnessHeaders,
  errorResponse,
  parseIntParam,
  jsonResponse,
  safeParse,
  buildMethodologyEnvelope,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  getDepegDewsMethodologyVersionAt,
} from "@shared/lib/depeg-dews-version";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-version";
import { TRACKED_IDS } from "@shared/lib/stablecoins";

export const handleStressSignals = withErrorHandler(
  "stress-signals",
  async (db: D1Database, url: URL): Promise<Response> => {
    const stablecoinId = url.searchParams.get("stablecoin");
    const days = parseIntParam(url.searchParams.get("days"), 30, 1, 365, "days");
    if (days instanceof Response) {
      return days;
    }

    if (stablecoinId) {
      const resolved = resolveOrReject(stablecoinId);
      if (resolved instanceof Response) {
        return resolved;
      }
      const canonicalId = resolved.canonicalId;

      if (!TRACKED_IDS.has(canonicalId)) {
        return errorResponse(404, "Stablecoin not tracked");
      }
      // Single coin: latest valid row + daily history.
      // computeDEWS() can return null for insufficient data; those runs skip writes,
      // so this query naturally serves the last valid cached value.
      const latest = await db
        .prepare(
          `SELECT score, band, signals_json, computed_at
           FROM stress_signals
           WHERE stablecoin_id = ?
           ORDER BY computed_at DESC LIMIT 1`,
        )
        .bind(canonicalId)
        .first<{
          score: number;
          band: string;
          signals_json: string;
          computed_at: number;
        }>();

      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const history = await db
        .prepare(
          `SELECT snapshot_date, score, band, signals_json
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

      const computedAt = latest?.computed_at ?? Math.floor(Date.now() / 1000);
      const methodologyVersion = getDepegDewsMethodologyVersionAt(computedAt);
      let malformedRows = 0;
      const currentSignals = latest
        ? safeParse<Record<string, unknown> | null>(latest.signals_json, null)
        : null;
      if (latest && currentSignals == null) malformedRows++;

      const historyRows = history.results.map((r) => {
        const parsedSignals = safeParse<Record<string, unknown> | null>(r.signals_json, null);
        if (parsedSignals == null) {
          malformedRows++;
          return null;
        }
        return {
          date: r.snapshot_date,
          score: r.score,
          band: r.band,
          signals: parsedSignals,
          methodologyVersion: getDepegDewsMethodologyVersionAt(r.snapshot_date),
        };
      }).filter((row): row is NonNullable<typeof row> => row !== null);

      return jsonResponse({
        current: latest && currentSignals
          ? {
              score: latest.score,
              band: latest.band,
              signals: currentSignals,
              computedAt: latest.computed_at,
              methodologyVersion: getDepegDewsMethodologyVersionAt(latest.computed_at),
            }
          : null,
        history: historyRows,
        malformedRows,
        methodology: buildMethodologyEnvelope({
          version: methodologyVersion,
          versionLabel: toMethodologyVersionLabel(methodologyVersion),
          currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
          currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
          changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
          asOf: computedAt,
        }),
      }, addFreshnessHeaders({
        "Cache-Control": CACHE_PROFILES.standard,
      }, computedAt, 900));
    }

    // All coins: latest valid row per coin.
    const rows = await db
      .prepare(
        `SELECT s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{
        stablecoin_id: string;
        score: number;
        band: string;
        signals_json: string;
        computed_at: number;
      }>();

    const signals: Record<string, object> = {};
    let updatedAt = 0;
    let malformedRows = 0;
    for (const row of rows.results) {
      if (!TRACKED_IDS.has(row.stablecoin_id)) {
        continue;
      }
      const parsedSignals = safeParse<Record<string, unknown> | null>(row.signals_json, null);
      if (parsedSignals == null) {
        malformedRows++;
        continue;
      }
      const methodologyVersion = getDepegDewsMethodologyVersionAt(row.computed_at);
      signals[row.stablecoin_id] = {
        score: row.score,
        band: row.band,
        signals: parsedSignals,
        computedAt: row.computed_at,
        methodologyVersion,
      };
      updatedAt = Math.max(updatedAt, row.computed_at);
    }

    const asOf = updatedAt > 0 ? updatedAt : Math.floor(Date.now() / 1000);
    const methodologyVersion = getDepegDewsMethodologyVersionAt(asOf);

    return jsonResponse({ signals, updatedAt, malformedRows, methodology: buildMethodologyEnvelope({
      version: methodologyVersion,
      versionLabel: toMethodologyVersionLabel(methodologyVersion),
      currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
      currentVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
      changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
      asOf,
    }) }, addFreshnessHeaders({
      "Cache-Control": CACHE_PROFILES.standard,
    }, asOf, 900));
  },
);
