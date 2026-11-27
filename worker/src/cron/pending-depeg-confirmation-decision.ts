import { DEPEG_PENDING_EXPIRY_SEC, DEPEG_PENDING_MIN_AGE_SEC } from "@shared/lib/depeg-config";
import { logWorkerEventArgs } from "../lib/structured-log";
import type { DepegEvent } from "@shared/types/peg";

import {
  buildInsertDepegEventStmt,
  isExtremeMovePending,
  isNativeOriginPending,
  parsePendingReason,
} from "../lib/depeg-helpers";
import {
  classifyDirectionalSignal,
  deriveDepegSignal,
} from "@shared/lib/depeg-signals";
import {
  buildDeletePendingStmt,
  buildOutcomeAndDeleteStmts,
  buildPendingOutcomeStmt,
  buildPoolConfirmationKey,
  confirmationSourceList,
  isOpposingConfirmationStatus,
  pendingPeakQuoteDomain,
  pickPeakCandidate,
  type PromotionDecisionInput,
} from "./pending-depeg-confirmation";
import { getPendingExpiryLimitSec, readPendingObservationReceipt, type DepegObservationReceipt } from "../lib/depeg-pending";
import {
  resolvePromotionEscalationCarryForward,
  type ReopenEscalationCandidate,
} from "./depeg-detection/escalation";

const TEMPORAL_CONFIRMATION_LABEL = `temporal:${Math.round(DEPEG_PENDING_MIN_AGE_SEC / 60)}m`;

export function evaluatePromotionDecision(
  args: PromotionDecisionInput & { reopenEscalationCandidate?: ReopenEscalationCandidate | null },
): D1PreparedStatement[] {
  const { db, plan, evidence, now, reopenEscalationCandidate } = args;
  const {
    row,
    pendingState,
    outcomeState,
    pegReference,
    authoritativePrice,
    threshold,
    age,
    primaryStatus,
    primarySameDirectionDepegged,
    primaryConfirmationSources,
    temporalSameDirectionConfirmed,
  } = plan;
  const hasHardConfirmation =
    evidence.dexStatus === "confirm" ||
    evidence.cexStatus === "confirm" ||
    evidence.poolStatus === "confirm";
  const isNativeOrigin = isNativeOriginPending(pendingState.reason);
  // A native-origin candidate's event prices are native samples; a withheld
  // sample cannot be promoted from any other family.
  const nativeOriginSampleWithheld = isNativeOrigin && plan.nativeQuoteImplausibility != null;
  const hasSourceConfirmation =
    !nativeOriginSampleWithheld &&
    (plan.independentConfirmation != null || primaryConfirmationSources.length >= (isNativeOrigin ? 1 : 2) ||
      hasHardConfirmation ||
      (evidence.offchainStatus === "confirm" && !parsePendingReason(pendingState.reason).has("low-confidence")));
  if (temporalSameDirectionConfirmed && hasSourceConfirmation) {
    const startedAt = plan.eventStartedAt ?? pendingState.firstSeenAt;
    const currentSignal =
      authoritativePrice != null
        ? deriveDepegSignal(authoritativePrice, pegReference)
        : null;
    const currentDirectionalSignal =
      classifyDirectionalSignal(currentSignal, threshold, pendingState.direction, plan.recoveryThreshold) === "confirm"
        ? currentSignal
        : null;
    const pendingReceipt = readPendingObservationReceipt(row.peer_basis_json);
    const trustedObservationAt = plan.trustedObservationAt != null &&
      plan.trustedObservationAt >= startedAt && plan.trustedObservationAt <= now
      ? plan.trustedObservationAt : pendingState.lastSeenAt;
    const currentCorroboration = plan.independentConfirmation?.peerReceipt
      ? JSON.parse(plan.independentConfirmation.peerReceipt) as unknown : undefined;
    const currentReceipt: DepegObservationReceipt | null = currentDirectionalSignal && authoritativePrice != null
      ? {
          basis: isNativeOrigin ? "native-peg" : currentCorroboration ? "peer-relative" : "benchmark",
          observedAt: trustedObservationAt,
          price: authoritativePrice,
          pegReference,
          bps: currentDirectionalSignal.rawBps,
          venue: isNativeOrigin ? plan.nativePegQuote?.derivation?.lineage.venue : undefined,
          corroboration: currentCorroboration,
        }
      : null;
    const quoteDomain = pendingPeakQuoteDomain(row, pendingState);
    const rawPendingPeak = pendingState.peakPegReference != null
      ? deriveDepegSignal(pendingState.peakPrice, pendingState.peakPegReference)?.rawBps : undefined;
    const pendingPeak = { bps: rawPendingPeak ?? pendingState.peakSeenBps, price: pendingState.peakPrice, quoteDomain,
      pegReference: pendingState.peakPegReference ?? (isNativeOrigin || row.peg_type === "peggedUSD" ? 1 : null),
      receipt: pendingState.peakPegReference != null ? pendingReceipt?.peak : null };
    const peak = pickPeakCandidate(
      [
        pendingPeak,
        { bps: currentDirectionalSignal?.rawBps, price: authoritativePrice, quoteDomain, pegReference, receipt: currentReceipt },
        ...(evidence.offchainPeakCandidate ? [evidence.offchainPeakCandidate] : []),
        ...(evidence.cexPeakCandidate ? [evidence.cexPeakCandidate] : []),
        ...evidence.dexPeakCandidates,
        ...(evidence.poolStatus === "confirm" ? evidence.poolConfirmations.map((confirmation) => ({
          bps: confirmation.signal.rawBps,
          pegReference,
          price: confirmation.pool.price,
          quoteDomain: "usd" as const,
        })) : []),
      ],
      pendingPeak,
    );
    const confirmedBy = confirmationSourceList(
      TEMPORAL_CONFIRMATION_LABEL,
      plan.independentConfirmation?.source,
      primaryConfirmationSources,
      evidence.offchainStatus === "confirm" ? evidence.offchainSourceKey : null,
      evidence.dexStatus === "confirm" ? evidence.dexConfirmationKeys : [],
      evidence.cexStatus === "confirm" ? "cex:binance" : null,
      evidence.poolStatus === "confirm"
        ? evidence.poolConfirmations.map((confirmation) => buildPoolConfirmationKey(confirmation.pool))
        : [],
    );
    // The outcome ledger records the same agreeing families as the event and
    // its decision reason, including the primary families that admitted it.
    const outcomeEvidence = { ...evidence, confirmingSources: [...evidence.confirmingSources, ...primaryConfirmationSources,
      ...(plan.independentConfirmation ? [plan.independentConfirmation.source] : [])] };
    const event: DepegEvent = {
      id: 0,
      stablecoinId: row.stablecoin_id,
      symbol: row.symbol,
      pegType: row.peg_type,
      direction: pendingState.direction,
      peakDeviationBps: Math.round(peak.bps),
      startedAt,
      endedAt: null,
      startPrice: pendingState.firstPrice,
      peakPrice: peak.price,
      peakPegReference: peak.pegReference ?? undefined,
      peakQuoteDomain: peak.quoteDomain === "usd" ? "usd" : "native-peg",
      recoveryPrice: null,
      pegReference: pendingState.pegReference,
      source: "live",
      confirmationSources: confirmedBy || null,
      pendingReason: pendingState.reason,
      closeReason: null,
      provenance: null,
      ...(pendingReceipt?.onset && (pendingReceipt.onset.basis === "native-peg" || pendingReceipt.onset.basis === "peer-relative") &&
        pendingReceipt.onset.observedAt === startedAt ? {
          admittedCoverage: trustedObservationAt > startedAt + 1
            ? [{ fromSec: startedAt, toSec: startedAt + 1 },
              { fromSec: trustedObservationAt, toSec: trustedObservationAt + 1 }]
            : [{ fromSec: startedAt, toSec: Math.max(trustedObservationAt, startedAt) + 1 }],
        } : {}),
      priceCoverage: {
        intervals: [[trustedObservationAt, trustedObservationAt]], lastTrustedObservationAt: trustedObservationAt, gapStartedAt: null,
      },
    };

    logWorkerEventArgs("handler", "info",
      `[depeg-confirm] PROMOTED ${row.symbol}: ${pendingState.firstSeenBps}bps confirmed by ${confirmedBy || "(none)"}${pendingState.reason ? ` (${pendingState.reason})` : ""}`
    );
    const eventReceipt = pendingReceipt || plan.independentConfirmation?.nativeReceipt || currentCorroboration || peak.receipt
      ? JSON.stringify({ onset: pendingReceipt?.onset, latest: pendingReceipt?.latest, peak: peak.receipt ?? null, confirmation: plan.independentConfirmation?.nativeReceipt ?? currentCorroboration })
      : null;
    const escalationCarryForward = resolvePromotionEscalationCarryForward(
      event.peakDeviationBps,
      reopenEscalationCandidate,
      event.pegType,
    );
    return [
      buildInsertDepegEventStmt(db, event, eventReceipt, escalationCarryForward),
      buildPendingOutcomeStmt(
        db,
        row,
        outcomeState,
        "promoted",
        now,
        outcomeEvidence,
        `confirmed-by:${confirmedBy || "unknown"}`,
      ),
      buildDeletePendingStmt(db, row),
    ];
  }

  const statuses = [evidence.offchainStatus, evidence.dexStatus, evidence.cexStatus, evidence.poolStatus];
  const hasSameDirectionConfirmation = statuses.includes("confirm") || evidence.dexConfirmationVeto === true;
  const hasOpposingEvidence =
    statuses.some(isOpposingConfirmationStatus) ||
    ((isNativeOrigin || plan.independentBasis) && isOpposingConfirmationStatus(primaryStatus));
  const canRejectOpposingEvidence =
    hasOpposingEvidence &&
    !hasSameDirectionConfirmation &&
    (!primarySameDirectionDepegged || evidence.hardOpposingSources.length >= 2);
  const isExpired = age > DEPEG_PENDING_EXPIRY_SEC && !plan.preserveUntilReopen;
  const expiryLimitSec = getPendingExpiryLimitSec({
    primarySameDirectionDepegged,
    isExtremeMove: isExtremeMovePending(pendingState.reason),
    unavailableSources: evidence.unavailableSources,
    circuitOpenSources: evidence.circuitOpenSources,
  });
  const finalExpiryExceeded = age > expiryLimitSec;

  if (canRejectOpposingEvidence) {
    const reason = primarySameDirectionDepegged
      ? `two-hard-opposing-sources:${confirmationSourceList(evidence.hardOpposingSources)}`
      : "secondary-evidence-opposes";
    logWorkerEventArgs("handler", "info",
      `[depeg-confirm] Rejected ${row.symbol}: secondary evidence opposes pending direction ` +
      `(offchain=${evidence.offchainStatus}, dex=${evidence.dexStatus}, cex=${evidence.cexStatus}, pool=${evidence.poolStatus})`,
    );
    return buildOutcomeAndDeleteStmts(
      db,
      row,
      outcomeState,
      "rejected",
      now,
      evidence,
      reason,
    );
  }

  if (isExpired && finalExpiryExceeded) {
    const severe = isExtremeMovePending(pendingState.reason);
    logWorkerEventArgs("handler", "info",
      `[depeg-confirm] Expired pending for ${row.symbol}: ${Math.round(age / 60)}min without confirmation ` +
      `(limit ${Math.round(expiryLimitSec / 60)}min)`,
    );
    return buildOutcomeAndDeleteStmts(
      db,
      row,
      outcomeState,
      severe ? "unconfirmed-severe" : "expired",
      now,
      evidence,
      `expired-after:${age}s;limit:${expiryLimitSec}s`,
    );
  }

  if (isExpired) {
    logWorkerEventArgs("handler", "info",
      `[depeg-confirm] Kept pending for ${row.symbol} past base expiry: ` +
      `age=${Math.round(age / 60)}min, limit=${Math.round(expiryLimitSec / 60)}min, ` +
      `primarySameDirection=${primarySameDirectionDepegged}, unavailable=${confirmationSourceList(evidence.unavailableSources) || "none"}, ` +
      `circuitOpen=${confirmationSourceList(evidence.circuitOpenSources) || "none"}`,
    );
  }

  return [];
}
