import { setCache } from "../db-cache";
import { createCronResult } from "../cron-result";
import { logWorkerEvent } from "../structured-log";
import type { CronResult } from "../cron-logger";
import { materializeV9AcceptedPublication, type V9AcceptedPublicMaterializationSource, type V9PublicMaterializationResult, type V9PublicMaterializationTiming } from "../report-cards-v9-materialization";
import { V9_PUBLIC_MATERIALIZATION_CACHE_KEY, V9_PUBLIC_REPRESENTATION_VERSION } from "@shared/types/report-cards-v9-materialization";
import { throwIfAborted } from "../abort";
import { loadSafetyScoreV9PublicationStoredRow } from "./publication-chunks";
import { parseSafetyScoreV9Publication } from "./publication-codec";
import { loadSafetyScoreV9PublicationHealth, resolveSafetyScoreV9EffectivePublicationHealth, SAFETY_SCORE_V9_CACHE_KEYS } from "./publication-health";
import { safeFailure, SAFETY_SCORE_V9_PUBLICATION_DIAGNOSTIC_BUDGET_MS } from "./publication-failure";

export type SafetyScoreV9PublicMaterializationRunResult =
  | V9PublicMaterializationResult
  | { status: "failed"; publicationGenerationId: string; attempts: number; code: string; message: string }
  | { status: "skipped"; reason: "post-commit-interrupted" };

/**
 * Best-effort post-acceptance materialization. Acceptance is already durable;
 * a failure leaves readers on the previously selected generation and is retried
 * once in-run, then in the :52 second-chance slot without another compute.
 */
export async function materializeAcceptedPublication(
  db: D1Database,
  source: V9AcceptedPublicMaterializationSource,
  signal: AbortSignal,
  timing: V9PublicMaterializationTiming,
): Promise<SafetyScoreV9PublicMaterializationRunResult> {
  const maxAttempts = 2;
  for (let attempt = 1; ; attempt++) {
    try {
      return await materializeV9AcceptedPublication(db, source, signal, timing);
    } catch (error) {
      if (attempt < maxAttempts && !signal.aborted) continue;
      const failure = safeFailure(error, "publication-write");
      logWorkerEvent({
        scope: "lib", level: "warn", event: "safety_score_v9_public_materialization_failed",
        job: "compute-safety-score-v9", message: "Accepted publication retained; public representations not yet materialized",
        metadata: { publicationGenerationId: source.publication.publicationGenerationId, attempts: attempt, ...failure },
      });
      return {
        status: "failed", publicationGenerationId: source.publication.publicationGenerationId,
        attempts: attempt, code: failure.code.replace("publication-write", "public-materialization"), message: failure.message,
      };
    }
  }
}

/** The :52 recovery path owns this invocation; candidate inputs are never loaded. */
export async function retryPendingSafetyScoreV9PublicMaterialization(
  db: D1Database, signal: AbortSignal | undefined, deadlineMs: number,
): Promise<{
  status: SafetyScoreV9PublicMaterializationRunResult["status"]; publishedAtSec: number | null;
  publicationGenerationId: string | null; reason: string; budgetMs: number;
} | null> {
  // Use the remaining slot, retaining 5s for commit confirmation and cron settlement.
  const budgetMs = Math.max(0, deadlineMs - Date.now() - SAFETY_SCORE_V9_PUBLICATION_DIAGNOSTIC_BUDGET_MS);
  if (budgetMs === 0) return { status: "skipped", publishedAtSec: null, publicationGenerationId: null,
    reason: "v9-public-materialization-retry-insufficient-budget", budgetMs };
  const retryDeadlineMs = Date.now() + budgetMs;
  const retrySignal = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(signal ? [signal] : [])]);
  const checkBudget = () => {
    if (Date.now() >= retryDeadlineMs) throw new DOMException("Materialization retry budget exhausted", "TimeoutError");
    throwIfAborted(retrySignal);
  };
  checkBudget();
  const row = await db.prepare(`SELECT p.updated_at AS published_at,
    json_extract(p.value, '$.identity.publicationGenerationId') AS generation_id,
    json_extract(p.value, '$.payloadSha256') AS payload_sha256,
    CASE WHEN json_extract(m.value, '$.publicationGenerationId') = json_extract(p.value, '$.identity.publicationGenerationId')
      AND json_extract(m.value, '$.payloadSha256') = json_extract(p.value, '$.payloadSha256')
      AND json_extract(m.value, '$.projectionVersion') = ? THEN 1 ELSE 0 END AS materialized
    FROM cache p LEFT JOIN cache m ON m.key = ? WHERE p.key = ?`)
    .bind(V9_PUBLIC_REPRESENTATION_VERSION, V9_PUBLIC_MATERIALIZATION_CACHE_KEY, SAFETY_SCORE_V9_CACHE_KEYS.publication)
    .first<{ published_at: number; generation_id: string; payload_sha256: string; materialized: number }>();
  if (!row) {
    checkBudget();
    return { status: "skipped", publishedAtSec: null, publicationGenerationId: null,
      reason: "v9-public-materialization-retry-source-unavailable", budgetMs };
  }
  if (row.materialized === 1) return null;
  try {
    checkBudget();
    let source = await loadSafetyScoreV9PublicationStoredRow(db, retrySignal);
    checkBudget();
    if (!source || source.updatedAt !== row.published_at || (JSON.parse(source.value) as { payloadSha256?: unknown }).payloadSha256 !== row.payload_sha256) {
      throw new Error("v9-public-materialization-retry-source-changed");
    }
    const publication = await parseSafetyScoreV9Publication(source.value, retrySignal);
    // Recovery owns this row; release its stored text before staging wire fragments.
    source = null;
    checkBudget();
    const health = await loadSafetyScoreV9PublicationHealth(db, retrySignal);
    checkBudget();
    if (!health || publication.publicationGenerationId !== row.generation_id || publication.publishedAtSec !== row.published_at) {
      throw new Error("v9-public-materialization-retry-source-unavailable");
    }
    const result = await materializeV9AcceptedPublication(db, {
      publication, health: resolveSafetyScoreV9EffectivePublicationHealth(publication, health), payloadSha256: row.payload_sha256,
    }, retrySignal);
    // The materializer confirms its committed marker even if the retry signal expired.
    return { status: result.status, publishedAtSec: row.published_at, publicationGenerationId: row.generation_id, budgetMs,
      reason: `v9-public-materialization-retry-${result.status}` };
  } catch (error) {
    const reason = (error instanceof Error || error instanceof DOMException) && error.name === "TimeoutError"
      ? "v9-public-materialization-retry-timeout" : retrySignal.aborted
        ? `v9-public-materialization-retry-${signal?.aborted ? "aborted" : "timeout"}` : "v9-public-materialization-retry-failed";
    // Persist independently of the expired retry signal so later holding hours can compute.
    await setCache(db, SAFETY_SCORE_V9_CACHE_KEYS.publicMaterializationFailure,
      JSON.stringify({ publicationGenerationId: row.generation_id, reason }));
    logWorkerEvent({
      scope: "lib", level: "warn", event: "safety_score_v9_public_materialization_retry_failed",
      job: "compute-safety-score-v9", message: "Accepted publication retained; second-chance materialization failed", error,
      metadata: { reason, publicationGenerationId: row.generation_id },
    });
    return { status: "failed", publishedAtSec: row.published_at, publicationGenerationId: row.generation_id, reason, budgetMs };
  }
}

export async function recoverSafetyScoreV9PublicMaterialization(
  db: D1Database, signal: AbortSignal, deadlineMs: number,
): Promise<CronResult> {
  try {
    const retry = await retryPendingSafetyScoreV9PublicMaterialization(db, signal, deadlineMs);
    const reason = retry?.reason ?? "v9-public-materialization-already-selected";
    return createCronResult({
      status: retry === null || retry.status === "superseded" ? "skipped_neutral" : retry.status === "materialized" ? "ok" : "degraded",
      itemCount: retry?.status === "materialized" ? 1 : 0,
      metadata: { reason, publicMaterialization: retry },
      productivity: { productive: retry?.status === "materialized", reason },
    });
  } catch (error) {
    const reason = (error instanceof Error || error instanceof DOMException) && error.name === "TimeoutError"
      ? "v9-public-materialization-retry-timeout" : signal.aborted
        ? "v9-public-materialization-retry-aborted" : "v9-public-materialization-retry-failed";
    logWorkerEvent({
      scope: "lib", level: "warn", event: "safety_score_v9_public_materialization_retry_failed",
      job: "compute-safety-score-v9", message: "Accepted publication retained; second-chance materialization did not complete", error,
      metadata: { reason },
    });
    return createCronResult({ status: "degraded", itemCount: 0, metadata: { reason },
      productivity: { productive: false, reason } });
  }
}

