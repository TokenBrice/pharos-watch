import {
  withErrorHandler,
  addFreshnessHeaders,
  safeParse,
  jsonResponse,
  buildMethodologyEnvelope,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getConditionBand } from "../lib/stability-index";
import {
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION,
  PSI_METHODOLOGY_VERSION_LABEL,
  getPsiMethodologyVersionAt,
} from "@shared/lib/stability-index-version";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-version";

export const handleStabilityIndex = withErrorHandler("stability-index", async (db: D1Database, url: URL): Promise<Response> => {
  const detail = url.searchParams.get("detail") === "true";
  const now = Math.floor(Date.now() / 1000);
  const todayMidnight = now - (now % 86400);

  // Latest valid sample (live score). If a compute cycle was skipped (insufficient inputs),
  // the previous sample remains the source of truth.
  const latestSample = await db
    .prepare("SELECT stored_at, score, band, components, input_snapshot, methodology_version FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
    .first<{ stored_at: number; score: number; band: string; components: string; input_snapshot: string | null; methodology_version: string | null }>();

  // 24h rolling average
  const avg24hRow = await db
    .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?")
    .bind(now - 86400)
    .first<{ avg: number | null }>();

  // Today's running average (for appending to history)
  const todayAvgRow = await db
    .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at >= ?")
    .bind(todayMidnight)
    .first<{ avg: number | null }>();

  // Daily history from stability_index
  const historyQuery = detail
    ? "SELECT computed_at, score, band, components, input_snapshot, methodology_version FROM stability_index ORDER BY computed_at DESC LIMIT 730"
    : "SELECT computed_at, score, band, components, input_snapshot, methodology_version FROM stability_index ORDER BY computed_at DESC LIMIT 91";

  const rows = await db
    .prepare(historyQuery)
    .all<{ computed_at: number; score: number; band: string; components: string; input_snapshot: string | null; methodology_version: string | null }>();
  const results = rows.results ?? [];

  // If no sample and no history, return empty
  if (!latestSample && results.length === 0) {
    return jsonResponse({
      current: null,
      history: [],
      methodology: buildMethodologyEnvelope({
        version: PSI_METHODOLOGY_VERSION,
        versionLabel: PSI_METHODOLOGY_VERSION_LABEL,
        currentVersion: PSI_METHODOLOGY_VERSION,
        currentVersionLabel: PSI_METHODOLOGY_VERSION_LABEL,
        changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
        asOf: now,
      }),
    }, { "Cache-Control": CACHE_PROFILES.standard });
  }

  // Build current from latest sample, falling back to latest history row
  const currentSource = latestSample ?? results[0];
  const snapshot = safeParse(currentSource.input_snapshot, {} as Record<string, unknown>);
  const contributors = Array.isArray(snapshot.contributors) ? snapshot.contributors : [];

  const avg24h = avg24hRow?.avg != null ? Math.round(avg24hRow.avg * 10) / 10 : undefined;
  const avg24hBand = avg24h != null ? getConditionBand(avg24h) : undefined;
  const resolveMethodologyVersion = (version: string | null | undefined, ts: number) =>
    version ?? getPsiMethodologyVersionAt(ts);

  // Build history array (newest-first from stability_index)
  const history = results.map((r) => detail
    ? {
      date: r.computed_at,
      score: r.score,
      band: r.band,
      components: safeParse(r.components, {}),
      methodologyVersion: resolveMethodologyVersion(r.methodology_version, r.computed_at),
    }
    : {
      date: r.computed_at,
      score: r.score,
      band: r.band,
      methodologyVersion: resolveMethodologyVersion(r.methodology_version, r.computed_at),
    }
  );

  // Append today's running average as the last point if we have samples today
  if (todayAvgRow?.avg != null) {
    const todayScore = Math.round(todayAvgRow.avg * 10) / 10;
    const todayBand = getConditionBand(todayScore);
    const latestSampleTs = latestSample?.stored_at ?? todayMidnight;
    const todayMethodologyVersion =
      latestSample
        ? resolveMethodologyVersion(latestSample.methodology_version, latestSampleTs)
        : results[0]
          ? resolveMethodologyVersion(results[0].methodology_version, results[0].computed_at)
          : getPsiMethodologyVersionAt(todayMidnight);
    // Prepend to newest-first array (today is the newest)
    history.unshift({
      date: todayMidnight,
      score: todayScore,
      band: todayBand,
      methodologyVersion: todayMethodologyVersion,
    } as typeof history[number]);
  }

  const computedAt = latestSample ? latestSample.stored_at : (results[0]?.computed_at ?? now);
  const currentMethodologyTs = latestSample ? latestSample.stored_at : (results[0]?.computed_at ?? computedAt);
  const methodologyVersion =
    resolveMethodologyVersion(currentSource.methodology_version, currentMethodologyTs);

  return jsonResponse({
    current: {
      score: currentSource.score,
      band: currentSource.band,
      avg24h,
      avg24hBand,
      components: safeParse(currentSource.components, {}),
      contributors,
      totalMcapUsd: snapshot.totalMcapUsd ?? 0,
      computedAt,
      methodologyVersion,
    },
    history,
    methodology: buildMethodologyEnvelope({
      version: methodologyVersion,
      versionLabel: toMethodologyVersionLabel(methodologyVersion),
      currentVersion: PSI_METHODOLOGY_VERSION,
      currentVersionLabel: PSI_METHODOLOGY_VERSION_LABEL,
      changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
      asOf: computedAt,
    }),
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.standard,
  }, computedAt, 86400));
});
