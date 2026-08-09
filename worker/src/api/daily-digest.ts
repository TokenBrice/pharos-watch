import { addFreshnessHeaders, jsonResponse, safeJsonParse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { NON_BLOCKED_DIGEST_SQL_FILTER, NON_INTERNAL_DIGEST_SQL_FILTER, NON_WEEKLY_DIGEST_SQL_FILTER } from "../cron/daily-digest/shared";
import { selectDigestRiskSignal } from "./digest-risk-summary";
import { selectDigestIntelligence } from "./digest-intelligence-summary";

export const handleDailyDigest = async (db: D1Database): Promise<Response> => {
  const [digestResult, countResult] = await db.batch([
    db.prepare(
      `SELECT digest_text, digest_title, generated_at, digest_extended, input_data FROM daily_digest WHERE (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_INTERNAL_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER}) ORDER BY generated_at DESC LIMIT 1`
    ),
    db.prepare(
      // Edition numbering intentionally counts internal rows so published (#N)
      // suffixes stay stable when a sentinel row is hidden from output.
      `SELECT COUNT(*) as cnt FROM daily_digest WHERE (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})`
    ),
  ]);

  const row = digestResult.results?.[0] as { digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null; input_data: string | null } | undefined;

  if (!row) {
    return jsonResponse({ digest: null }, { "Cache-Control": CACHE_PROFILES.standard });
  }

  const editionNumber = (countResult.results?.[0] as { cnt: number } | undefined)?.cnt ?? null;
  const inputData = safeJsonParse(row.input_data, null, `daily-digest:${row.generated_at}:input_data`);
  const intelligence = selectDigestIntelligence(inputData);

  return jsonResponse({
    digest: row.digest_text,
    digestTitle: row.digest_title ?? null,
    digestExtended: row.digest_extended ?? null,
    generatedAt: row.generated_at,
    editionNumber,
    riskSignal: selectDigestRiskSignal(inputData),
    ...intelligence,
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.standard,
  }, row.generated_at, API_FRESHNESS_MAX_AGE_SEC.dailyDigest));
};
