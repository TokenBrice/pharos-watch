import {
  addFreshnessHeaders,
  errorResponse,
  jsonResponse,
  buildMethodologyEnvelope,
} from "../lib/api-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { CACHE_PROFILES } from "../lib/constants";
import { decodeJsonString } from "../lib/cache-json";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import { getConditionBand } from "../lib/stability-index";
import {
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION,
  PSI_METHODOLOGY_VERSION_LABEL,
  getPsiMethodologyVersionAt,
} from "@shared/lib/methodology-versions/stability-index";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import { upsertPsiHistoryPoint } from "@shared/lib/psi-view-model";
import { round1 } from "@shared/lib/math";
import { CORE_STABLECOIN_AGGREGATE_UNIVERSE } from "@shared/lib/stablecoins/aggregate-universe";

import { isRecord } from "@shared/lib/type-guards";

type PsiJsonDecodeReason = "missing" | "json-parse-failed" | "invalid-shape";

interface PsiInputDegradation {
  dewsUnavailable: boolean;
  dewsFailureReason: string | null;
  depegEventsUnavailable: boolean;
  depegEventsFailureReason: string | null;
}

function readPsiInputDegradation(snapshot: Record<string, unknown>): PsiInputDegradation | undefined {
  const degradation: PsiInputDegradation = {
    dewsUnavailable: snapshot.dewsUnavailable === true,
    dewsFailureReason: typeof snapshot.dewsFailureReason === "string" ? snapshot.dewsFailureReason : null,
    depegEventsUnavailable: snapshot.depegEventsUnavailable === true,
    depegEventsFailureReason:
      typeof snapshot.depegEventsFailureReason === "string" ? snapshot.depegEventsFailureReason : null,
  };

  return (
    degradation.dewsUnavailable
    || degradation.dewsFailureReason != null
    || degradation.depegEventsUnavailable
    || degradation.depegEventsFailureReason != null
  )
    ? degradation
    : undefined;
}

function decodePsiObjectField(
  value: string | null,
  updatedAt: number,
  context: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: PsiJsonDecodeReason } {
  const decoded = decodeJsonString<Record<string, unknown>, PsiJsonDecodeReason>(value, {
    updatedAt,
    missingReason: "missing",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      if (!isRecord(parsed)) {
        return { ok: false, reason: "invalid-shape" };
      }
      return { ok: true, payload: parsed };
    },
  });

  if (!decoded.ok) {
    logMalformedJsonPath({
      scope: "api",
      owner: "stability-index",
      context,
      reason: decoded.reason,
      source: "stability_index",
      updatedAt,
    });
    return { ok: false, reason: decoded.reason };
  }

  return { ok: true, value: decoded.payload };
}

export const handleStabilityIndex = async (db: D1Database, url: URL): Promise<Response> => {
  const detail = url.searchParams.get("detail") === "true";
  const now = Math.floor(Date.now() / 1000);
  const todayMidnight = now - (now % DAY_SECONDS);

  // Daily history from stability_index. The detail query is intentionally unbounded so
  // historical event annotations (events go back to 2018) stay within the chart's range.
  // input_snapshot is deliberately NOT selected here — it is a large per-row blob that is
  // only needed for the latest row when no live sample exists. Fetch it lazily below in
  // that fallback. Do not re-add a LIMIT to bound this query.
  const historyQuery = detail
    ? "SELECT computed_at, score, band, components, methodology_version FROM stability_index ORDER BY computed_at DESC"
    : "SELECT computed_at, score, band, components, methodology_version FROM stability_index ORDER BY computed_at DESC LIMIT 91";

  // Latest valid sample (live score). If a compute cycle was skipped (insufficient inputs),
  // the previous sample remains the source of truth.
  const [latestSample, avg24hRow, todayAvgRow, rows] = await Promise.all([
    db
      .prepare("SELECT stored_at, score, band, components, input_snapshot, methodology_version FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ stored_at: number; score: number; band: string; components: string; input_snapshot: string | null; methodology_version: string | null }>(),
    db
      .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?")
      .bind(now - DAY_SECONDS)
      .first<{ avg: number | null }>(),
    db
      .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at >= ?")
      .bind(todayMidnight)
      .first<{ avg: number | null }>(),
    db
      .prepare(historyQuery)
      .all<{ computed_at: number; score: number; band: string; components: string; methodology_version: string | null }>(),
  ]);
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
    }, { headers: { "Cache-Control": CACHE_PROFILES.standard } });
  }

  // Build current from latest sample, falling back to latest history row
  const currentSource = latestSample ?? results[0];
  const computedAt = latestSample ? latestSample.stored_at : (results[0]?.computed_at ?? now);
  const currentComponents = decodePsiObjectField(
    currentSource.components,
    computedAt,
    "current.components",
  );
  if (!currentComponents.ok) {
    return errorResponse(503, "PSI current components payload is malformed");
  }
  // Snapshot for `current` comes from the live sample when present, else the latest
  // daily row (fetched separately so the history query stays free of the heavy blob).
  let currentSnapshotRaw: string | null;
  if (latestSample) {
    currentSnapshotRaw = latestSample.input_snapshot;
  } else {
    const latestHistorySnapshot = await db
      .prepare("SELECT input_snapshot FROM stability_index ORDER BY computed_at DESC LIMIT 1")
      .first<{ input_snapshot: string | null }>();
    currentSnapshotRaw = latestHistorySnapshot?.input_snapshot ?? null;
  }
  const snapshot = decodePsiObjectField(
    currentSnapshotRaw,
    computedAt,
    "current.input_snapshot",
  );
  if (!snapshot.ok) {
    return errorResponse(503, "PSI current input snapshot payload is malformed");
  }
  const contributors = Array.isArray(snapshot.value.contributors) ? snapshot.value.contributors : [];
  const inputDegradation = readPsiInputDegradation(snapshot.value);

  const avg24h = avg24hRow?.avg != null ? round1(avg24hRow.avg) : undefined;
  const avg24hBand = avg24h != null ? getConditionBand(avg24h) : undefined;
  const resolveMethodologyVersion = (version: string | null | undefined, ts: number) =>
    version ?? getPsiMethodologyVersionAt(ts);

  // Build history array (newest-first from stability_index)
  let malformedRows = 0;
  const history = results.map((r) => {
    if (!detail) {
      return {
        date: r.computed_at,
        score: r.score,
        band: r.band,
        methodologyVersion: resolveMethodologyVersion(r.methodology_version, r.computed_at),
      };
    }

    const decodedHistoryComponents = decodePsiObjectField(
      r.components,
      r.computed_at,
      "history.components",
    );
    if (!decodedHistoryComponents.ok) {
      malformedRows++;
      return null;
    }

    return {
      date: r.computed_at,
      score: r.score,
      band: r.band,
      components: decodedHistoryComponents.value,
      methodologyVersion: resolveMethodologyVersion(r.methodology_version, r.computed_at),
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null);

  // Append today's running average as the last point if we have samples today
  if (todayAvgRow?.avg != null) {
    const todayScore = round1(todayAvgRow.avg);
    const todayBand = getConditionBand(todayScore);
    const latestSampleTs = latestSample?.stored_at ?? todayMidnight;
    const todayMethodologyVersion =
      latestSample
        ? resolveMethodologyVersion(latestSample.methodology_version, latestSampleTs)
        : results[0]
          ? resolveMethodologyVersion(results[0].methodology_version, results[0].computed_at)
          : getPsiMethodologyVersionAt(todayMidnight);
    const todayPoint = {
      date: todayMidnight,
      score: todayScore,
      band: todayBand,
      methodologyVersion: todayMethodologyVersion,
    } as typeof history[number];
    const normalizedHistory = upsertPsiHistoryPoint(history, todayPoint);
    history.splice(0, history.length, ...normalizedHistory);
  }

  const currentMethodologyTs = latestSample ? latestSample.stored_at : (results[0]?.computed_at ?? computedAt);
  const methodologyVersion =
    resolveMethodologyVersion(currentSource.methodology_version, currentMethodologyTs);

  return jsonResponse({
    current: {
      score: currentSource.score,
      band: currentSource.band,
      avg24h,
      avg24hBand,
      components: currentComponents.value,
      contributors,
      ...(inputDegradation ? { inputDegradation } : {}),
      ...(snapshot.value.aggregateUniverse === CORE_STABLECOIN_AGGREGATE_UNIVERSE
        ? { aggregateUniverse: CORE_STABLECOIN_AGGREGATE_UNIVERSE }
        : {}),
      totalMcapUsd: typeof snapshot.value.totalMcapUsd === "number" ? snapshot.value.totalMcapUsd : 0,
      computedAt,
      methodologyVersion,
    },
    history,
    malformedRows,
    methodology: buildMethodologyEnvelope({
      version: methodologyVersion,
      versionLabel: toMethodologyVersionLabel(methodologyVersion),
      currentVersion: PSI_METHODOLOGY_VERSION,
      currentVersionLabel: PSI_METHODOLOGY_VERSION_LABEL,
      changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
      asOf: computedAt,
    }),
  }, {
    headers: addFreshnessHeaders({ "Cache-Control": CACHE_PROFILES.standard }, computedAt, DAY_SECONDS),
  });
};
