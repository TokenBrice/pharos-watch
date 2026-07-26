import type { ReportCardsResponse } from "@shared/types/report-cards";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type {
  SafetyScoreV8PublicationIdentity,
  SafetyScoreV9PublicationIdentity,
} from "@shared/types/safety-score-publication";
import { toErrorMessage } from "./error-utils";
import {
  loadActiveSafetyScoreSource,
  type ActiveSafetyScoreSource,
} from "./safety-score-active-source";
import { loadActiveV8SafetyScoreHistorySource } from "./safety-score-history-v2";

export type IdentifiedActiveSafetyScoreSource =
  | {
      kind: "v8";
      expectedModel: "v8";
      identity: SafetyScoreV8PublicationIdentity;
      publishedAtSec: number;
      activationUpdatedAt: null;
      snapshot: ReportCardsResponse;
    }
  | {
      kind: "v9";
      expectedModel: "v9";
      identity: SafetyScoreV9PublicationIdentity;
      publishedAtSec: number;
      activationUpdatedAt: number;
      snapshot: ReportCardsV9Response;
    }
  | {
      kind: "error";
      expectedModel: "v8" | "v9";
      reason: string;
      detail: string;
      activationUpdatedAt: number | null;
    };

function fromActiveV9(
  source: Extract<ActiveSafetyScoreSource, { kind: "v9" }>,
): Extract<IdentifiedActiveSafetyScoreSource, { kind: "v9" }> {
  return {
    kind: "v9",
    expectedModel: "v9",
    identity: source.snapshot.safetyScoreIdentity,
    publishedAtSec: source.snapshot.updatedAt,
    activationUpdatedAt: source.activationUpdatedAt,
    snapshot: source.snapshot,
  };
}

function fromActiveError(
  source: Extract<ActiveSafetyScoreSource, { kind: "error" }>,
): Extract<IdentifiedActiveSafetyScoreSource, { kind: "error" }> {
  return {
    kind: "error",
    expectedModel: source.expectedModel,
    reason: source.reason,
    detail: source.detail,
    activationUpdatedAt: source.activationUpdatedAt,
  };
}

/**
 * Resolves one complete active Safety Score source. A present but unsatisfied
 * V9 activation marker never reaches the V8 loader.
 */
export async function loadIdentifiedActiveSafetyScoreSource(
  db: D1Database,
  signal?: AbortSignal,
): Promise<IdentifiedActiveSafetyScoreSource> {
  const active = await loadActiveSafetyScoreSource(db, signal);
  if (active.kind === "v9") {
    if (active.snapshot.publicationHealth.status === "held") {
      return {
        kind: "error",
        expectedModel: "v9",
        reason: "v9-publication-held",
        detail: "Canonical Safety Score V9 ratings are held at the last verified snapshot",
        activationUpdatedAt: active.activationUpdatedAt,
      };
    }
    return fromActiveV9(active);
  }
  if (active.kind === "error") return fromActiveError(active);

  try {
    const source = await loadActiveV8SafetyScoreHistorySource(db, signal);
    return {
      kind: "v8",
      expectedModel: "v8",
      identity: source.identity,
      publishedAtSec: source.publishedAtSec,
      activationUpdatedAt: null,
      snapshot: source.snapshot,
    };
  } catch (error) {
    // Re-resolve once so an activation that raced the V8 artifact reads is
    // represented as V9, never mislabeled as a V8 cache failure.
    const rechecked = await loadActiveSafetyScoreSource(db, signal);
    if (rechecked.kind === "v9") {
      if (rechecked.snapshot.publicationHealth.status === "held") {
        return {
          kind: "error",
          expectedModel: "v9",
          reason: "v9-publication-held",
          detail: "Canonical Safety Score V9 ratings are held at the last verified snapshot",
          activationUpdatedAt: rechecked.activationUpdatedAt,
        };
      }
      return fromActiveV9(rechecked);
    }
    if (rechecked.kind === "error") return fromActiveError(rechecked);
    return {
      kind: "error",
      expectedModel: "v8",
      reason: "v8-snapshot-unavailable",
      detail: toErrorMessage(error),
      activationUpdatedAt: null,
    };
  }
}
