import { deriveDisposition, isCarryEligible } from "@shared/lib/evidence-loss";
import { EvidenceLossOutcomeSchema, type EvidenceLossLeg, type EvidenceLossOutcome } from "@shared/types/evidence-loss";
import { ReserveLossLineageSchema, type ReserveAttemptLeg, type ReserveLossLineage } from "@shared/types/live-reserves";
import type { ReserveSyncStateRecord } from "./store-shared";

/** A timeout after collector entry cannot prove that no adverse payload was already read. */
export function unknownReserveLeg(key: string, sourceId: string, reason = "collector-result-unverified"): EvidenceLossLeg {
  return { key, sourceId, disposition: "unknown", reason, proof: null };
}
/** A healthy replacement is not a revocation of still-valid consumed evidence. */
export function reserveRedemptionParentLoss(lineage: ReserveLossLineage | undefined, nowSec: number): EvidenceLossOutcome | null {
  if (!lineage) return null;
  return lineage.invalidations.redemption ?? lineage.invalidations.composition
    ?? ((lineage.latest?.scope.key === "composition" || lineage.latest?.scope.key === "redemption")
      && !isCarryEligible(lineage.latest, nowSec) ? lineage.latest : null);
}


export function reserveLossOutcome(input: {
  assetId: string; sourceId: string; attemptId: string | null; runId?: string | null;
  observedAtSec: number; reason: string; legs: readonly ReserveAttemptLeg[];
  rejection?: EvidenceLossLeg; priorEvidence?: EvidenceLossOutcome["priorEvidence"];
  scopeKey?: string;
  legacy?: boolean;
}): EvidenceLossOutcome {
  const legs = input.legs.flatMap((leg) => leg.loss ? [leg.loss] : []);
  if (input.rejection) legs.push(input.rejection);
  if (legs.length === 0) legs.push(unknownReserveLeg("collector", input.sourceId));
  const disposition = deriveDisposition(legs);
  const reason = disposition === "operational" ? legs[0].reason : input.reason;
  return EvidenceLossOutcomeSchema.parse({
    scope: { assetId: input.assetId, kind: "datum", key: input.scopeKey ?? "composition" },
    disposition, reason, attemptId: input.attemptId, runId: input.runId ?? input.attemptId,
    generationId: null, sourceId: input.sourceId, observedAtSec: input.observedAtSec,
    legs, proof: disposition === "operational" ? `reserve-attempt:${input.attemptId}:complete-chain` : null,
    priorEvidence: input.priorEvidence ?? null, legacy: input.legacy ?? input.attemptId === null,
  });
}

/** Recovery without a collector-stage packet is unknown, even when the platform error sounds operational. */
export function failureStateWithLoss(state: ReserveSyncStateRecord): ReserveSyncStateRecord {
  const parsed = EvidenceLossOutcomeSchema.safeParse(state.metadata.reserveLoss);
  const outcome = parsed.success && parsed.data.scope.assetId === state.stablecoinId
    && parsed.data.attemptId === (state.lastAttemptId ?? null)
    && parsed.data.sourceId === (state.configFingerprint ?? state.adapterKey)
    ? parsed.data : reserveLossOutcome({
    assetId: state.stablecoinId, sourceId: state.configFingerprint ?? state.adapterKey,
    attemptId: state.lastAttemptId ?? null, observedAtSec: state.lastAttemptedAt ?? 0,
    reason: "attempt-proof-missing", legs: [],
  });
  const invalidations = isCarryEligible(outcome, state.lastAttemptedAt ?? 0)
    ? {} : { [outcome.scope.key]: outcome };
  return { ...state, metadata: { ...state.metadata, reserveLoss: outcome,
    reserveInvalidations: { ...(state.metadata.reserveInvalidations ?? {}), ...invalidations } } };
}

export function reserveLossLineage(state: Pick<ReserveSyncStateRecord, "metadata">
  & Partial<Pick<ReserveSyncStateRecord, "stablecoinId" | "lastAttemptedAt" | "lastSuccessAt" | "lastSuccessAttemptId" | "lastAttemptId" | "pendingAttemptId" | "lastStatus" | "configFingerprint" | "adapterKey">>
  | null | undefined): ReserveLossLineage {
  const authority = state?.lastSuccessAt != null && state.lastSuccessAt > 0 && state.configFingerprint
    ? { attemptId: state.lastSuccessAttemptId ?? null, observedAtSec: state.lastSuccessAt, sourceId: state.configFingerprint }
    : undefined;
  const parsed = ReserveLossLineageSchema.safeParse(state?.metadata.reserveLossLineage ?? {
    latest: state?.metadata.reserveLoss ?? null,
    attemptLegs: state?.metadata.reserveAttemptLegs,
    invalidations: state?.metadata.reserveInvalidations ?? {},
  });
  if (parsed.success) {
    const lineage = authority ? { ...parsed.data, authority } : parsed.data;
    const latest = lineage.latest;
    const pending = state?.pendingAttemptId != null;
    const mismatchedAttempt = !pending && latest != null
      && ((state?.lastAttemptedAt !== undefined && latest.observedAtSec !== state.lastAttemptedAt)
        || (state?.lastAttemptId !== undefined && latest.attemptId !== state.lastAttemptId));
    const newerAttempt = !pending && state?.lastAttemptedAt != null && state.lastSuccessAt != null
      && (state.lastAttemptedAt > state.lastSuccessAt
        || (state.lastAttemptId != null && state.lastAttemptId !== state.lastSuccessAttemptId));
    const recordedFailure = state?.lastStatus === "error" || state?.lastStatus === "skipped"
      || state?.metadata.failureCategory != null || state?.metadata.withheldFallback != null
      || state?.metadata.reason === "fallback-withheld-score-grade-retained";
    // Starting an attempt changes only its pointer and clock, not the prior finalized result.
    if (!mismatchedAttempt && (latest != null || (!newerAttempt && !recordedFailure))) return lineage;
    const unknown = reserveLossOutcome({ assetId: state?.stablecoinId ?? "unattributed",
      sourceId: state?.configFingerprint || state?.adapterKey || "reserve-state",
      attemptId: pending ? null : state?.lastAttemptId ?? null,
      observedAtSec: pending ? 0 : state?.lastAttemptedAt ?? 0,
      reason: mismatchedAttempt ? "current-attempt-proof-mismatched" : "legacy-refresh-loss-unproved",
      legs: [], priorEvidence: latest?.priorEvidence ?? null,
      legacy: !mismatchedAttempt });
    return { ...lineage, latest: unknown, invalidations: {
      ...lineage.invalidations, composition: lineage.invalidations.composition ?? unknown,
    } };
  }
  // Malformed proof must not silently become a healthy lineage.
  const unknown = reserveLossOutcome({ assetId: state?.stablecoinId ?? "unattributed",
    sourceId: "reserve-state", attemptId: null, observedAtSec: 0, reason: "invalid-loss-lineage", legs: [] });
  return { latest: unknown, invalidations: { composition: unknown }, ...(authority ? { authority } : {}) };
}
