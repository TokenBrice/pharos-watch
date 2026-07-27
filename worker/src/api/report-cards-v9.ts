import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { errorResponse, jsonFreshResponse, withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import {
  loadActiveSafetyScoreSource,
  REPORT_CARDS_V9_ACTIVATION_CACHE_KEY,
  ReportCardsV9ActivationMarkerSchema,
  type ReportCardsV9ActivationMarker,
} from "../lib/safety-score-active-source";
import {
  loadPublishedReportCardsV9Snapshot,
  ReportCardsV9SnapshotUnavailableError,
} from "../lib/report-cards-v9-cache";

export {
  REPORT_CARDS_V9_ACTIVATION_CACHE_KEY,
  ReportCardsV9ActivationMarkerSchema as ActivationMarkerSchema,
  type ReportCardsV9ActivationMarker,
};

function snapshotResponse(
  snapshot: ReportCardsV9Response,
  lifecycle: ReportCardsV9Response["lifecycle"],
  cacheControl: string = CACHE_PROFILES.standard,
): Response {
  const held = snapshot.publicationHealth.status === "held";
  return jsonFreshResponse(
    { ...snapshot, lifecycle },
    {
      cacheControl: held ? CACHE_PROFILES.noStore : cacheControl,
      updatedAt: snapshot.updatedAt,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
      headers: {
        "X-Safety-Score-Status": held ? "held" : "current",
      },
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
  const active = await loadActiveSafetyScoreSource(db);
  if (active.kind === "v8") {
    return errorResponse(
      404,
      "Safety Score v9 is not activated; this endpoint is dark until the owner-gated activation step.",
    );
  }
  if (active.kind === "error") {
    if (active.reason === "v9-snapshot-unavailable") {
      return errorResponse(503, active.detail);
    }
    const reason = active.reason === "activation-marker-invalid"
      ? "Safety Score v9 activation marker is not a valid identity binding"
      : "Safety Score v9 activation identity does not match the canonical snapshot";
    return errorResponse(404, `${reason}; the endpoint remains dark (fail-closed).`);
  }
  return snapshotResponse(active.snapshot, "active");
});

/**
 * Owner-approved, read-only feedback surface for the current V9 shadow snapshot.
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
