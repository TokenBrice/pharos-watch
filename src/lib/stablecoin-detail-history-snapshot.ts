import type { StablecoinMeta } from "@shared/types";
import type { DepegEventEntry } from "@shared/types/market";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { classifyDepegClosure, type DepegClosureClassification } from "@shared/lib/depeg-closure";
import { isDisputedAuditVerdict } from "@shared/lib/depeg-audit";
import { DEPEG_EVENT_DATA_DIR, readDepegEventSnapshot } from "@/lib/depeg-event-snapshot";
import {
  readDepegLedgerCapture,
  type DepegLedgerCapture,
} from "../../scripts/lib/depeg-ledger-capture";

/**
 * Server-only projection for the History panel's dated depeg facts.
 *
 * The public depeg-history dataset is a windowed mirror, so it cannot stand in
 * for the profile's recorded events. This module reads the hash-bound retained
 * ledger once per build and projects a bounded, display-only slice for the
 * five-profile pilot. It never runs in the browser: `page.tsx` renders the
 * preview to a React node and only that bounded markup crosses the RSC
 * boundary.
 */

/** PT1's five-profile cohort. A profile outside it keeps its live-only History. */
export const STABLECOIN_DETAIL_HISTORY_PILOT_IDS: ReadonlySet<string> = new Set([
  "usdt-tether",
  "usdc-circle",
  "tusd-trueusd",
  "dai-makerdao",
  "fdusd-first-digital",
]);

/** The newest recorded incidents the compact preview shows. */
const HISTORY_SNAPSHOT_EVENT_LIMIT = 6;

const HISTORY_SNAPSHOT_COVERAGE = "retained-ledger";

export interface DepegHistorySnapshotEventProvenance {
  sourceKind: string | null;
  auditVerdict: string | null;
}

export interface DepegHistorySnapshotEventCoverage {
  lastObservationKind: string | null;
  intervalCount: number;
}

export interface DepegHistorySnapshotEvent {
  id: number;
  startedAt: number;
  endedAt: number | null;
  peakDeviationBps: number;
  pegType: string;
  pegReference: number;
  closure: DepegClosureClassification;
  /** Closed duration in seconds; null while the record is open at capture. */
  durationSeconds: number | null;
  source: DepegEventEntry["source"];
  /** Present only when the event owns a permanent `/depeg/[slug]/` route. */
  href: string | null;
  provenance: DepegHistorySnapshotEventProvenance | null;
  coverage: DepegHistorySnapshotEventCoverage | null;
}

export interface StablecoinDetailHistorySnapshot {
  stablecoinId: string;
  symbol: string;
  /** The admitted ledger capture's content hash. */
  sourceGeneration: string;
  /** Capture observation interval, epoch seconds. */
  capturedFrom: number;
  capturedAt: number;
  methodologyVersion: string;
  /** Full per-coin retained event count excluding reviewed disputes, before the display slice. */
  recordedCount: number;
  earliestStartedAt: number;
  latestStartedAt: number;
  coverage: typeof HISTORY_SNAPSHOT_COVERAGE;
  events: DepegHistorySnapshotEvent[];
}

export interface AdmittedDepegLedger {
  entries: readonly DepegEventEntry[];
  capture: DepegLedgerCapture;
  observationStartedAt: number;
  observedAt: number;
}

type HistorySnapshotCoin = Pick<StablecoinMeta, "id" | "symbol" | "status" | "flags">;

function captureEpochSeconds(iso: string, label: string): number {
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Depeg ledger capture has an invalid ${label}: ${iso}`);
  }
  return Math.floor(milliseconds / 1000);
}

/**
 * Admission gates shared by the production read and test fixtures. A failed
 * admission is a build error, never an empty history: the caller only gets a
 * `null` projection for a successfully admitted empty per-coin set.
 */
export function admitDepegLedger({
  entries,
  capture,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  entries: readonly DepegEventEntry[];
  capture: DepegLedgerCapture;
  nowSeconds?: number;
}): AdmittedDepegLedger {
  if (!Number.isFinite(nowSeconds)) {
    throw new Error("Depeg ledger admission needs a finite build clock");
  }
  if (capture.eventCount !== entries.length) {
    throw new Error(
      `Depeg ledger capture declares ${capture.eventCount} records but ${entries.length} shard records were parsed`,
    );
  }
  const observationStartedAt = captureEpochSeconds(capture.observationStartedAtISO, "observation start");
  const observedAt = captureEpochSeconds(capture.observedAtISO, "observation end");
  if (observationStartedAt > observedAt) {
    throw new Error("Depeg ledger capture observation interval is reversed");
  }
  if (observedAt > nowSeconds) {
    throw new Error("Depeg ledger capture clock is in the future");
  }

  const incidentIds = new Set<number>();
  for (const entry of entries) {
    if (incidentIds.has(entry.id)) {
      throw new Error(`Depeg ledger contains duplicate incident id ${entry.id}`);
    }
    incidentIds.add(entry.id);
    if (entry.startedAt > observedAt) {
      throw new Error(`Depeg incident ${entry.id} starts after the capture clock`);
    }
  }

  return { entries, capture, observationStartedAt, observedAt };
}

let admittedLedgerCache: AdmittedDepegLedger | null = null;

/**
 * Read the retained ledger and its capture identity once per build module.
 * `readDepegLedgerCapture` re-hashes the exact shard bytes, so a stale or
 * hand-edited ledger fails admission instead of publishing a silently stale
 * preview.
 */
export function readAdmittedDepegLedger({
  dataDir = DEPEG_EVENT_DATA_DIR,
  entries,
  nowSeconds,
}: {
  dataDir?: string;
  entries?: readonly DepegEventEntry[];
  nowSeconds?: number;
} = {}): AdmittedDepegLedger {
  const isProductionLedger = dataDir === DEPEG_EVENT_DATA_DIR && entries === undefined;
  if (isProductionLedger && admittedLedgerCache) return admittedLedgerCache;
  const admitted = admitDepegLedger({
    entries: entries ?? readDepegEventSnapshot({ missing: "throw" }),
    capture: readDepegLedgerCapture(dataDir),
    nowSeconds,
  });
  if (isProductionLedger) admittedLedgerCache = admitted;
  return admitted;
}

function projectEvent(
  entry: DepegEventEntry,
  permanentPageSlugs: ReadonlySet<string>,
): DepegHistorySnapshotEvent {
  return {
    id: entry.id,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    peakDeviationBps: entry.peakDeviationBps,
    pegType: entry.pegType,
    pegReference: entry.pegReference,
    closure: classifyDepegClosure({
      endedAt: entry.endedAt,
      closeReason: entry.closeReason,
      recoveryPrice: entry.recoveryPrice,
    }),
    durationSeconds: entry.endedAt == null ? null : entry.endedAt - entry.startedAt,
    source: entry.source,
    href: permanentPageSlugs.has(entry.slug) ? `/depeg/${entry.slug}/` : null,
    provenance: entry.provenance
      ? {
        sourceKind: entry.provenance.sourceKind ?? null,
        auditVerdict: entry.provenance.auditVerdict ?? null,
      }
      : null,
    coverage: entry.priceCoverage
      ? {
        lastObservationKind: entry.priceCoverage.lastObservationKind ?? null,
        intervalCount: entry.priceCoverage.intervals.length,
      }
      : null,
  };
}

/**
 * Build the bounded display projection. Returns null outside the pilot, for
 * NAV or non-active lifecycles, and for a successfully admitted empty coin
 * set. `recordedCount` always comes from the full per-coin ledger, never from
 * the six-row display slice.
 */
export function buildStablecoinDetailHistorySnapshot({
  coin,
  permanentPageSlugs,
  ledger,
}: {
  coin: HistorySnapshotCoin;
  permanentPageSlugs: ReadonlySet<string>;
  ledger?: AdmittedDepegLedger;
}): StablecoinDetailHistorySnapshot | null {
  if (!STABLECOIN_DETAIL_HISTORY_PILOT_IDS.has(coin.id)) return null;
  if (coin.flags.navToken === true) return null;
  if (!isActiveStablecoinMeta({ status: coin.status })) return null;

  const admittedLedger = ledger ?? readAdmittedDepegLedger();
  const coinEntries = admittedLedger.entries.filter((entry) => entry.stablecoinId === coin.id);
  if (coinEntries.length === 0) return null;

  const ordered = [...coinEntries].sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return b.id - a.id;
  });
  const newest = ordered.slice(0, HISTORY_SNAPSHOT_EVENT_LIMIT);

  return {
    stablecoinId: coin.id,
    symbol: coin.symbol,
    sourceGeneration: admittedLedger.capture.captureId,
    capturedFrom: admittedLedger.observationStartedAt,
    capturedAt: admittedLedger.observedAt,
    methodologyVersion: admittedLedger.capture.methodologyVersionLabel,
    recordedCount: coinEntries.filter((entry) => !isDisputedAuditVerdict(entry.provenance?.auditVerdict)).length,
    earliestStartedAt: ordered[ordered.length - 1].startedAt,
    latestStartedAt: ordered[0].startedAt,
    coverage: HISTORY_SNAPSHOT_COVERAGE,
    events: newest.map((entry) => projectEvent(entry, permanentPageSlugs)),
  };
}
