import { deriveDepegSignal, signalCrossesThreshold } from "@shared/lib/depeg-signals";
import { getDepegThresholdBps } from "./depeg-threshold-policy";
import { readAdmittedPeerObservation, readAdmittedPeerOnset, readAdmittedPeerPeak, readPendingObservationReceipt } from "./depeg-pending";

type EventWithPeak = Parameters<typeof readAdmittedPeerPeak>[0];
type EventWithOnset = Parameters<typeof readAdmittedPeerOnset>[0];

export function hasPeerDeviationReceipt(row: { peer_basis_json?: string | null; pending_reason?: string | null }): boolean {
  if (row.peer_basis_json == null) return false;
  const receipt = readPendingObservationReceipt(row.peer_basis_json);
  const observations = [receipt?.onset, receipt?.latest, receipt?.peak];
  if (observations.some((observation) => observation != null)) {
    return observations.some((observation) => observation?.basis === "peer-relative");
  }
  return row.pending_reason?.split("+").includes("peer-relative") === true;
}

/** Match a benchmark receipt to the actual opening, independently of the later confirmation basis. */
export function readBenchmarkOnset(row: EventWithOnset) {
  const onset = readPendingObservationReceipt(row.peer_basis_json)?.onset;
  if (onset?.basis !== "benchmark" || onset.observedAt !== row.started_at ||
      onset.price !== row.start_price || onset.pegReference !== row.peg_reference) return null;
  const signal = deriveDepegSignal(onset.price, onset.pegReference);
  if (!signal || !signalCrossesThreshold(signal, getDepegThresholdBps(row.peg_type)) ||
      (row.direction != null && row.direction !== signal.direction) || Math.abs(signal.rawBps - onset.bps) > 0.5) return null;
  const admission = onset.referenceAdmission;
  if (admission && (admission.status !== "admitted" || admission.quoteObservedAtSec > row.started_at)) return null;
  return { signal, admission };
}

/** Decision time limits availability. The underlying quote clock orders the admitted observations. */
export function readPeerDeviationMarks(row: EventWithPeak) {
  const receipt = readPendingObservationReceipt(row.peer_basis_json);
  const latest = receipt?.latest;
  const marks = [
    { observedAt: row.started_at, observation: readAdmittedPeerOnset(row) },
    { observedAt: receipt?.peak?.observedAt ?? row.started_at, observation: readAdmittedPeerPeak(row) },
  ];
  if (latest && latest.observedAt >= row.started_at && (row.ended_at == null || latest.observedAt <= row.ended_at)) {
    marks.push({ observedAt: latest.observedAt, observation: readAdmittedPeerObservation({
      ...row, started_at: latest.observedAt, start_price: latest.price, peg_reference: latest.pegReference,
    }, latest) });
  }
  return marks.flatMap(({ observedAt, observation }) => observation
    ? [{ observedAt, availableAt: observation.availableAt, quoteObservedAt: observation.quoteObservedAt, rawBps: observation.rawBps }] : [])
    .sort((a, b) => b.quoteObservedAt - a.quoteObservedAt || b.availableAt - a.availableAt);
}
