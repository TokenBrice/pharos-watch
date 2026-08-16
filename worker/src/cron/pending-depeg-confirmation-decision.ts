import { logWorkerEventArgs } from "../lib/structured-log";
import type { DepegEvent } from "@shared/types/market";
import { DEPEG_PENDING_EXPIRY_SEC } from "../lib/constants";
import {
  buildInsertDepegEventStmt,
  isExtremeMovePending,
  isNativeOriginPending,
  parsePendingReason,
} from "../lib/depeg-helpers";
import {
  classifyDirectionalSignal,
  deriveDepegSignal,
} from "../lib/depeg-signals";
import {
  buildDeletePendingStmt,
  buildOutcomeAndDeleteStmts,
  buildPendingOutcomeStmt,
  buildPoolConfirmationKey,
  confirmationSourceList,
  getPendingExpiryLimitSec,
  isOpposingConfirmationStatus,
  pickPeakCandidate,
  type PromotionDecisionInput,
} from "./pending-depeg-confirmation";

export function evaluatePromotionDecision(args: PromotionDecisionInput): D1PreparedStatement[] {
  const { db, plan, evidence, now } = args;
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
  const hasSourceConfirmation =
    primaryConfirmationSources.length >= (isNativeOrigin ? 1 : 2) ||
    hasHardConfirmation ||
    (evidence.offchainStatus === "confirm" && !parsePendingReason(pendingState.reason).has("low-confidence"));
  if (temporalSameDirectionConfirmed && hasSourceConfirmation) {
    const currentSignal =
      authoritativePrice != null
        ? deriveDepegSignal(authoritativePrice, pegReference)
        : null;
    const currentDirectionalSignal =
      classifyDirectionalSignal(currentSignal, threshold, pendingState.direction) === "confirm"
        ? currentSignal
        : null;
    const peak = pickPeakCandidate(
      [
        { bps: pendingState.peakSeenBps, price: pendingState.peakPrice },
        { bps: currentDirectionalSignal?.bps, price: authoritativePrice },
        ...(evidence.offchainPeakCandidate ? [evidence.offchainPeakCandidate] : []),
        ...(evidence.cexPeakCandidate ? [evidence.cexPeakCandidate] : []),
        ...evidence.dexPeakCandidates,
        ...evidence.poolConfirmations.map((confirmation) => ({
          bps: confirmation.signal.bps,
          price: confirmation.pool.price,
        })),
      ],
      { bps: pendingState.peakSeenBps, price: pendingState.peakPrice },
    );
    const confirmedBy = confirmationSourceList(
      "temporal:15m",
      primaryConfirmationSources,
      evidence.offchainStatus === "confirm" ? evidence.offchainSourceKey : null,
      evidence.dexStatus === "confirm" ? evidence.dexConfirmationKeys : [],
      evidence.cexStatus === "confirm" ? "cex:binance" : null,
      evidence.poolStatus === "confirm"
        ? evidence.poolConfirmations.map((confirmation) => buildPoolConfirmationKey(confirmation.pool))
        : [],
    );
    const event: DepegEvent = {
      id: 0,
      stablecoinId: row.stablecoin_id,
      symbol: row.symbol,
      pegType: row.peg_type,
      direction: pendingState.direction,
      peakDeviationBps: peak.bps,
      startedAt: pendingState.firstSeenAt,
      endedAt: null,
      startPrice: pendingState.firstPrice,
      peakPrice: peak.price,
      recoveryPrice: null,
      pegReference,
      source: "live",
      confirmationSources: confirmedBy || null,
      pendingReason: pendingState.reason,
      closeReason: null,
      provenance: null,
    };

    logWorkerEventArgs("handler", "info",
      `[depeg-confirm] PROMOTED ${row.symbol}: ${pendingState.firstSeenBps}bps confirmed by ${confirmedBy || "(none)"}${pendingState.reason ? ` (${pendingState.reason})` : ""}`
    );
    return [
      buildInsertDepegEventStmt(db, event),
      buildPendingOutcomeStmt(
        db,
        row,
        outcomeState,
        "promoted",
        now,
        evidence,
        `confirmed-by:${confirmedBy || "unknown"}`,
      ),
      buildDeletePendingStmt(db, row),
    ];
  }

  const statuses = [evidence.offchainStatus, evidence.dexStatus, evidence.cexStatus, evidence.poolStatus];
  const hasSameDirectionConfirmation = statuses.includes("confirm");
  const hasOpposingEvidence =
    statuses.some(isOpposingConfirmationStatus) ||
    (isNativeOrigin && isOpposingConfirmationStatus(primaryStatus));
  const canRejectOpposingEvidence =
    hasOpposingEvidence &&
    !hasSameDirectionConfirmation &&
    (!primarySameDirectionDepegged || evidence.hardOpposingSources.length >= 2);
  const isExpired = age > DEPEG_PENDING_EXPIRY_SEC;
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
