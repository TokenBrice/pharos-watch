import {
  ReportCardsV9TransitionResponseSchema,
  type ReportCardsV9TransitionResponse,
} from "@shared/types/report-cards-v9";
import { SafetyScoreV9PublicationIdentitySchema } from "@shared/types/safety-score-publication";
import { getCache } from "./db-cache";
import { tryParseJson } from "./json-parse";
import {
  loadPublishedReportCardsV9Snapshot,
  ReportCardsV9SnapshotUnavailableError,
} from "./report-cards-v9-cache";

/**
 * Owner-gated activation marker. Its absence is the explicit rollback
 * expectation: V8 remains active until an identity-bound V9 marker exists.
 */
export const REPORT_CARDS_V9_ACTIVATION_CACHE_KEY = "safety-score-v9:public-activation";

export const ReportCardsV9ActivationMarkerSchema = SafetyScoreV9PublicationIdentitySchema.pick({
  policyId: true,
  policyDigest: true,
  evaluationBuildDigest: true,
  methodologyVersion: true,
});

export type ReportCardsV9ActivationMarker = {
  policyId: string;
  policyDigest: string;
  evaluationBuildDigest: string;
  methodologyVersion: string;
};

export type ActiveSafetyScoreSource =
  | {
      kind: "v8";
      expectedModel: "v8";
      reason: "activation-marker-missing";
      activationUpdatedAt: null;
    }
  | {
      kind: "v9";
      expectedModel: "v9";
      marker: ReportCardsV9ActivationMarker;
      activationUpdatedAt: number;
      snapshot: ReportCardsV9TransitionResponse;
    }
  | {
      kind: "error";
      expectedModel: "v9";
      reason:
        | "activation-marker-invalid"
        | "v9-snapshot-unavailable"
        | "v9-identity-mismatch";
      activationUpdatedAt: number;
      marker: ReportCardsV9ActivationMarker | null;
      snapshot: ReportCardsV9TransitionResponse | null;
      detail: string;
    };

export function parseReportCardsV9ActivationMarker(value: string): ReportCardsV9ActivationMarker | null {
  const parsed = tryParseJson(value, { onFailure: () => undefined });
  return ReportCardsV9ActivationMarkerSchema.safeParse(parsed).data ?? null;
}

export function reportCardsV9IdentityMatchesActivationMarker(
  snapshot: Pick<ReportCardsV9TransitionResponse, "safetyScoreIdentity">,
  marker: ReportCardsV9ActivationMarker,
): boolean {
  const identity = snapshot.safetyScoreIdentity;
  return (
    identity.policyId === marker.policyId &&
    identity.policyDigest === marker.policyDigest &&
    identity.evaluationBuildDigest === marker.evaluationBuildDigest &&
    identity.methodologyVersion === marker.methodologyVersion
  );
}

/**
 * Resolves the expected active Safety Score model without silently falling
 * back across an invalid activation state. Missing marker means V8; any
 * present but invalid or unsatisfied marker is a fail-closed V9 error.
 */
export async function loadActiveSafetyScoreSource(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ActiveSafetyScoreSource> {
  const activation = await getCache(db, REPORT_CARDS_V9_ACTIVATION_CACHE_KEY);
  if (activation === null) {
    return {
      kind: "v8",
      expectedModel: "v8",
      reason: "activation-marker-missing",
      activationUpdatedAt: null,
    };
  }

  const marker = parseReportCardsV9ActivationMarker(activation.value);
  if (marker === null) {
    return {
      kind: "error",
      expectedModel: "v9",
      reason: "activation-marker-invalid",
      activationUpdatedAt: activation.updatedAt,
      marker: null,
      snapshot: null,
      detail: "Safety Score V9 activation marker is not a valid identity binding",
    };
  }

  let snapshot: ReportCardsV9TransitionResponse;
  try {
    snapshot = await loadPublishedReportCardsV9Snapshot(db, signal);
  } catch (error) {
    if (!(error instanceof ReportCardsV9SnapshotUnavailableError)) throw error;
    return {
      kind: "error",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
      activationUpdatedAt: activation.updatedAt,
      marker,
      snapshot: null,
      detail: error.message,
    };
  }
  const transitionSnapshot = ReportCardsV9TransitionResponseSchema.safeParse(snapshot);
  if (!transitionSnapshot.success) {
    return {
      kind: "error",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
      activationUpdatedAt: activation.updatedAt,
      marker,
      snapshot,
      detail: "Canonical Safety Score V9 snapshot does not satisfy the live transition report contract",
    };
  }
  snapshot = transitionSnapshot.data;

  if (!reportCardsV9IdentityMatchesActivationMarker(snapshot, marker)) {
    return {
      kind: "error",
      expectedModel: "v9",
      reason: "v9-identity-mismatch",
      activationUpdatedAt: activation.updatedAt,
      marker,
      snapshot,
      detail: "Safety Score V9 activation identity does not match the canonical snapshot",
    };
  }

  return {
    kind: "v9",
    expectedModel: "v9",
    marker,
    activationUpdatedAt: activation.updatedAt,
    snapshot,
  };
}
