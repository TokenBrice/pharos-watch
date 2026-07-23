import { z } from "zod";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { errorResponse, jsonFreshResponse, withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getCache } from "../lib/db-cache";
import { tryParseJson } from "../lib/json-parse";
import {
  loadPublishedReportCardsV9Snapshot,
  ReportCardsV9SnapshotUnavailableError,
} from "../lib/report-cards-v9-cache";

/**
 * Owner-gated activation marker: the versioned V9 endpoint stays DARK until
 * the activation runbook writes this cache key. Without it the shadow cron's
 * cache would be served to any API caller pre-activation.
 */
export const REPORT_CARDS_V9_ACTIVATION_CACHE_KEY = "safety-score-v9:public-activation";

/**
 * The marker value is identity-bound (owner decision 2026-07-15): it must be
 * JSON carrying the exact approved scoring identity, and the endpoint serves
 * only while the canonical snapshot matches every bound field. A missing,
 * malformed, or mismatched marker keeps the endpoint dark — fail closed. The
 * rotating per-publication fields (base-input / publication generation IDs)
 * are deliberately NOT bound so routine shadow refreshes of the approved
 * identity keep serving.
 */
export const ActivationMarkerSchema = z.object({
  policyId: z.string().trim().min(1),
  policyDigest: z.string().trim().min(1),
  evaluationBuildDigest: z.string().trim().min(1),
  methodologyVersion: z.string().trim().min(1),
});

export type ReportCardsV9ActivationMarker = z.infer<typeof ActivationMarkerSchema>;

function parseActivationMarker(value: string): ReportCardsV9ActivationMarker | null {
  const parsed = tryParseJson(value, { onFailure: () => undefined });
  return ActivationMarkerSchema.safeParse(parsed).data ?? null;
}

function snapshotResponse(
  snapshot: ReportCardsV9Response,
  lifecycle: ReportCardsV9Response["lifecycle"],
  cacheControl: string = CACHE_PROFILES.standard,
): Response {
  return jsonFreshResponse(
    { ...snapshot, lifecycle },
    {
      cacheControl,
      updatedAt: snapshot.updatedAt,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
    },
  );
}

/**
 * Versioned V9 public contract. It is shadow-only until a separately approved
 * activation writes the identity-bound marker; this route never reads or
 * recomputes the V8 report-card product. Once served through the activation
 * gate the response lifecycle is "active" (owner decision 2026-07-15).
 */
export const handleReportCardsV9 = withErrorHandler("report-cards-v9", async (db: D1Database): Promise<Response> => {
  try {
    const activation = await getCache(db, REPORT_CARDS_V9_ACTIVATION_CACHE_KEY);
    if (!activation) {
      return errorResponse(
        404,
        "Safety Score v9 is not activated; this endpoint is dark until the owner-gated activation step.",
      );
    }
    const approved = parseActivationMarker(activation.value);
    if (approved === null) {
      return errorResponse(
        404,
        "Safety Score v9 activation marker is not a valid identity binding; the endpoint remains dark (fail-closed).",
      );
    }
    const snapshot = await loadPublishedReportCardsV9Snapshot(db);
    const identity = snapshot.safetyScoreIdentity;
    const identityMatches =
      identity.policyId === approved.policyId &&
      identity.policyDigest === approved.policyDigest &&
      identity.evaluationBuildDigest === approved.evaluationBuildDigest &&
      identity.methodologyVersion === approved.methodologyVersion;
    if (!identityMatches) {
      return errorResponse(
        404,
        "Safety Score v9 activation identity does not match the canonical snapshot; the endpoint remains dark (fail-closed).",
      );
    }
    return snapshotResponse(snapshot, "active");
  } catch (error) {
    if (error instanceof ReportCardsV9SnapshotUnavailableError) {
      return errorResponse(503, error.message);
    }
    throw error;
  }
});

/**
 * Owner-approved, read-only feedback surface for the current shadow candidate.
 * It deliberately bypasses activation while preserving the shadow lifecycle
 * and strict public projection. The opaque route is discoverability control,
 * not authentication.
 */
export const handleReportCardsV9Preview = withErrorHandler(
  "report-cards-v9-preview",
  async (db: D1Database): Promise<Response> => {
    try {
      return snapshotResponse(await loadPublishedReportCardsV9Snapshot(db), "shadow", CACHE_PROFILES.noStore);
    } catch (error) {
      if (error instanceof ReportCardsV9SnapshotUnavailableError) {
        return errorResponse(503, error.message);
      }
      throw error;
    }
  },
);
