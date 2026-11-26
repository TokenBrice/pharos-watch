import { z } from "zod";
import { logWorkerEvent, logWorkerEventArgs } from "./structured-log";
import { MAX_OPEN_DEPEG_EVENTS } from "./depeg-threshold-policy";
import { DEX_FRESHNESS_SEC, DEX_PROTOCOL_SOURCE_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { readDexPriceLineage, type DexPriceLineage } from "../cron/dex-liquidity/price-lineage";
export { readDexPriceLineage, type DexPriceLineage } from "../cron/dex-liquidity/price-lineage";
import { PegReferenceHoldSchema, type PegScoreEvent } from "@shared/lib/peg-utils";
import { DepegAuditVerdictSchema } from "@shared/types/depeg-audit";
import { DEPEG_EVENT_CLOSE_REASON_VALUES, DepegPriceCoverageSchema, DepegEventQuoteDomainSchema, DepegEventDispositionSchema, DepegAdmittedCoverageSchema } from "@shared/types/peg";
import type { DepegEvent, DepegEventCloseReason } from "@shared/types/peg";
import {
  loadPublishedDexPoolChallengers,
  type DexPriceChallengerLoadRow,
} from "../cron/dex-liquidity/challenger-load";
import { decodeJsonString } from "./cache-json";
import {
  deriveDepegSignal,
  signalCrossesThreshold,
  signalIsWithinThreshold,
  type DepegDirection,
  type DepegSignal,
} from "@shared/lib/depeg-signals";
import { isMissingTableError } from "./db";
import { logMalformedJsonPath } from "./json-decode-observability";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  assessClockedCurveNavPayload,
  getDexAggregateObservedAt,
  getDexPriceSourceEntries,
  isClockedCurveNavPayload,
  type DexAggregateClock,
} from "./depeg-trust-policy";

/** D1 row shape for the depeg_events table (snake_case columns) */
export interface DepegRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
  start_price: number;
  peak_price: number | null;
  recovery_price: number | null;
  peg_reference: number;
  source: string;
  close_reason?: string | null;
  recovery_first_seen_at?: number | null;
  confirmation_sources: string | null;
  pending_reason: string | null;
  peak_peg_reference?: number | null;
  peak_quote_domain?: DepegEvent["peakQuoteDomain"] | null;
  recovery_peg_reference?: number | null;
  reference_hold_json?: string | null;
  admitted_coverage_json?: string | null;
  disposition?: string | null;
  peer_basis_json?: string | null;
  provenance_json?: string | null;
  price_coverage_json?: string | null;
  last_trusted_price_at?: number | null;
  price_coverage_gap_started_at?: number | null;
  provenance_confidence_tier?: string | null;
  provenance_audit_verdict?: string | null;
  provenance_replay_run_id?: string | null;
  provenance_replay_version?: string | null;
}

/** Column list for the detector's depeg_events SELECT shape. */
export const DEPEG_EVENTS_DEPEGROW_COLUMNS =
  "id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source, recovery_first_seen_at, price_coverage_json, last_trusted_price_at, price_coverage_gap_started_at, peak_peg_reference, peak_quote_domain, recovery_peg_reference, admitted_coverage_json, disposition";

const OPEN_DEPEG_LIMIT_MESSAGES = {
  detection: "Skipped depeg detection because the open-event query reached its limit",
  confirmation: "Skipped pending depeg confirmation because the open-event query reached its limit",
  "orphan-cleanup": "Skipped depeg orphan cleanup because the open-event query reached its limit",
} as const;

export function logOpenDepegEventLimitReached(pass: keyof typeof OPEN_DEPEG_LIMIT_MESSAGES): void {
  logWorkerEvent({
    scope: "handler",
    level: "warn",
    event: "depeg_open_event_limit_reached",
    message: OPEN_DEPEG_LIMIT_MESSAGES[pass],
    status: "degraded",
    metadata: { pass, maxOpenDepegEvents: MAX_OPEN_DEPEG_EVENTS },
  });
}

export interface DexPriceRow extends DexPriceLineage {
  stablecoin_id: string;
  dex_price_usd: number;
  deviation_from_primary_bps: number | null;
  source_pool_count: number;
  source_total_tvl: number;
  updated_at: number;
  aggregateObservedAt?: number | null;
  aggregateClockReason?: DexAggregateClock["aggregateClockReason"];
  /** Preserved parsed `price_sources_json` payload when clocked Curve NAV policy checks apply. */
  pricePayload?: unknown;
}

export type PendingDepegReasonFlag = "confirmation-window" | "large-cap" | "low-confidence" | "extreme-move" | "peer-relative";
export const NATIVE_ORIGIN_PENDING_REASON_FLAG = "native-origin";
/**
 * Stored reason is a "+"-joined list of flags in canonical order:
 * confirmation-window > extreme-move > large-cap > low-confidence > peer-relative.
 */
export type PendingDepegReason = string;

const REASON_ORDER: PendingDepegReasonFlag[] = ["confirmation-window", "extreme-move", "large-cap", "low-confidence", "peer-relative"];

export function buildPendingReason(flags: Iterable<PendingDepegReasonFlag>): PendingDepegReason {
  const set = new Set(flags);
  return REASON_ORDER.filter((f) => set.has(f)).join("+");
}

export function parsePendingReason(reason: PendingDepegReason | null | undefined): Set<PendingDepegReasonFlag> {
  const result = new Set<PendingDepegReasonFlag>();
  if (!reason) return result;
  for (const part of reason.split("+")) {
    if (part === "confirmation-window" || part === "large-cap" || part === "low-confidence" || part === "extreme-move" || part === "peer-relative") {
      result.add(part);
    }
  }
  return result;
}

export function isExtremeMovePending(reason: PendingDepegReason | null | undefined): boolean {
  return parsePendingReason(reason).has("extreme-move");
}

export function markNativeOriginPending(reason: PendingDepegReason): PendingDepegReason {
  return reason.split("+").includes(NATIVE_ORIGIN_PENDING_REASON_FLAG)
    ? reason
    : `${reason}+${NATIVE_ORIGIN_PENDING_REASON_FLAG}`;
}

export function isNativeOriginPending(reason: PendingDepegReason | null | undefined): boolean {
  return reason?.split("+").includes(NATIVE_ORIGIN_PENDING_REASON_FLAG) ?? false;
}

/** Per-protocol price source stored in dex_prices.price_sources_json */
export interface DexPoolSource extends DexPriceLineage {
  protocol: string;
  chain: string;
  price: number;
  tvl: number;
  updatedAt: number;
  observedAt?: number;
  aggregateObservedAt?: number;
  sourceFamily?: string;
}

type DexJsonDecodeReason = "missing" | "json-parse-failed" | "invalid-shape";

export interface DexPriceSourceLoadTelemetry {
  staleRows: Array<{
    stablecoinId: string;
    updatedAt: number;
    ageSec: number;
    maxAgeSec: number;
  }>;
  malformedRows: Array<{
    stablecoinId: string;
    updatedAt: number;
    reason: DexJsonDecodeReason;
  }>;
}

export function createDexPriceSourceLoadTelemetry(): DexPriceSourceLoadTelemetry {
  return {
    staleRows: [],
    malformedRows: [],
  };
}

/**
 * Load all qualifying individual pool prices per asset from the published challenger snapshot,
 * with safe legacy fallback when the challenger tables are absent.
 * Used as "pool challengers" - if ANY large pool diverges from consensus,
 * it signals that aggregators may be picking up small misleading pools
 * while ignoring large pools showing depeg.
 */
export async function loadDexPoolChallengers(
  db: D1Database,
  minPoolTvlUsd: number,
  maxAgeSec: number,
  nowSec: number,
): Promise<Map<string, Array<DexPriceLineage & {
  price: number; tvlUsd: number; protocol: string; chain: string; observedAt?: number; sourceFamily?: string;
  legacyAggregateObservedAt?: number | null;
}>>> {
  let loaded;
  try {
    loaded = await loadPublishedDexPoolChallengers(db, minPoolTvlUsd, maxAgeSec, nowSec);
  } catch (err) {
    // Pool challengers are optional corroboration for depeg confirmation and
    // price hardening; exactly a missing challenger/dex table yields no
    // challengers, while every other D1 failure propagates.
    if (isMissingTableError(err)) {
      return new Map();
    }
    logWorkerEventArgs("lib", "error", "[depeg-helpers] Unexpected error loading pool challengers:", toErrorMessage(err));
    throw err;
  }
  const { challengersByStablecoin, diagnostics } = loaded;

  if (diagnostics.mode !== "absent") {
    if (diagnostics.incompletePublishedCoins.length > 0) {
      logWorkerEventArgs("lib", "warn",
        `[depeg-helpers] Incomplete challenger snapshots fell back for: ${diagnostics.incompletePublishedCoins.join(", ")}`,
      );
    }
    if (diagnostics.emptyPublishedCoins.length > 0) {
      logWorkerEventArgs("lib", "info",
        `[depeg-helpers] Published empty challenger snapshots for: ${diagnostics.emptyPublishedCoins.join(", ")}`,
      );
    }
    if (diagnostics.legacyFallbackCoins.length > 0 && diagnostics.mode !== "legacy") {
      logWorkerEventArgs("lib", "info",
        `[depeg-helpers] Legacy challenger fallback used for: ${diagnostics.legacyFallbackCoins.join(", ")}`,
      );
    }
  }

  return new Map(
    [...challengersByStablecoin.entries()].map(([stablecoinId, rows]) => [
      stablecoinId,
      rows.map((row: DexPriceChallengerLoadRow) => ({
        price: row.priceUsd,
        tvlUsd: row.tvlUsd,
        protocol: row.protocol,
        chain: row.chain,
        observedAt: row.priceObservedAt ?? undefined,
        sourceFamily: row.sourceFamily,
        ...(row.legacyAggregateObservedAt !== undefined && { legacyAggregateObservedAt: row.legacyAggregateObservedAt }),
        ...readDexPriceLineage(row),
      })),
    ]),
  );
}

function normalizeDexGroupPart(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized.length > 0 ? normalized : fallback;
}

export function dexProtocolGroupKey(source: Pick<DexPoolSource, "protocol" | "chain" | "sourceFamily">): string {
  return normalizeDexGroupPart(source.sourceFamily, "unknown");
}

export function dexPoolIndependentGroupKey(
  source: Pick<{ protocol: string; sourceFamily?: string }, "protocol" | "sourceFamily">,
): string {
  return `${normalizeDexGroupPart(source.protocol, "unknown")}:${normalizeDexGroupPart(source.sourceFamily, "unknown")}`;
}

export interface DexProtocolCorroboration {
  key: string;
  source: DexPoolSource;
  signal: DepegSignal;
}

export function collectDexProtocolCorroborations(
  protocolSources: DexPoolSource[] | undefined,
  pegRef: number,
  threshold: number,
  direction: DepegDirection,
  mode: "confirm" | "recover" | "contradict",
): DexProtocolCorroboration[] {
  if (!protocolSources || protocolSources.length === 0) return [];
  const groups: Array<{ identities: Set<string>; best: DexProtocolCorroboration }> = [];
  for (const source of protocolSources) {
    const signal = deriveDepegSignal(source.price, pegRef);
    if (signal == null || source.pricePoolKeys?.length === 0 || source.upstreamKeys?.length === 0) continue;
    const matches = mode === "recover"
      ? signalIsWithinThreshold(signal, threshold)
      : signalCrossesThreshold(signal, threshold) &&
        (mode === "confirm" ? signal.direction === direction : signal.direction !== direction);
    if (!matches) continue;

    const key = dexProtocolGroupKey(source);
    const identities = new Set([`family:${key}`, `protocol:${normalizeDexGroupPart(source.protocol, "unknown")}`,
      ...(source.pricePoolKeys ?? []), ...(source.upstreamKeys ?? [])]);
    let best = { key, source, signal };
    // A conversion pool can link several apparently distinct source families.
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      if (![...identities].some((id) => group.identities.has(id))) continue;
      for (const id of group.identities) identities.add(id);
      if (mode === "recover" ? group.best.signal.absRawBps < best.signal.absRawBps
        : group.best.signal.absRawBps > best.signal.absRawBps) best = group.best;
      groups.splice(i, 1);
    }
    groups.push({ identities, best });
  }
  return groups.map((group) => group.best);
}

export function countDexProtocolCorroborations(
  protocolSources: DexPoolSource[] | undefined,
  pegRef: number,
  threshold: number,
  direction: DepegDirection,
  mode: "confirm" | "recover" | "contradict",
): number {
  return collectDexProtocolCorroborations(protocolSources, pegRef, threshold, direction, mode).length;
}

export interface LoadedDexPrices {
  dexPriceRows: Map<string, DexPriceRow>;
  dexPriceSources: Map<string, DexPoolSource[]>;
}

/**
 * Read aggregate prices and protocol sources from one dex_prices observation.
 * nowSec is the caller's plan/run clock, not the wall clock after D1 resolves.
 * Aggregate rows remain unfiltered for downstream policies. Affirmative sources
 * need original family and aggregate clocks; publication cannot renew either.
 */
export async function loadDexPrices(
  db: D1Database,
  nowSec: number,
  maxAgeSec = DEX_PROTOCOL_SOURCE_FRESHNESS_SEC,
  telemetry?: DexPriceSourceLoadTelemetry,
): Promise<LoadedDexPrices> {
  try {
    const rows = await db
      .prepare("SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at, price_sources_json FROM dex_prices")
      .all<DexPriceRow & { price_sources_json: string | null }>();

    const dexPriceRows = new Map<string, DexPriceRow>();
    const dexPriceSources = new Map<string, DexPoolSource[]>();
    for (const row of rows.results ?? []) {
      dexPriceRows.set(row.stablecoin_id, {
        stablecoin_id: row.stablecoin_id,
        dex_price_usd: row.dex_price_usd,
        deviation_from_primary_bps: row.deviation_from_primary_bps,
        source_pool_count: row.source_pool_count,
        source_total_tvl: row.source_total_tvl,
        updated_at: row.updated_at,
        aggregateObservedAt: null,
      });
      // Match the old source SELECT: NULL is absent, not malformed or stale.
      if (row.price_sources_json == null) continue;
      const ageSec = nowSec - row.updated_at;
      // Run-start age remains telemetry, not a veto on later original observations.
      if (ageSec > maxAgeSec) {
        telemetry?.staleRows.push({
          stablecoinId: row.stablecoin_id,
          updatedAt: row.updated_at,
          ageSec,
          maxAgeSec,
        });
      }
      const priceRow = dexPriceRows.get(row.stablecoin_id)!;
      const decoded = decodeJsonString<
        { sources: DexPoolSource[]; rawPayload: unknown } & DexAggregateClock & DexPriceLineage,
        DexJsonDecodeReason
      >(row.price_sources_json, {
        updatedAt: row.updated_at,
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: (parsed) => {
          if (isClockedCurveNavPayload(parsed)) {
            priceRow.pricePayload = parsed;
          }
          const sources = getDexPriceSourceEntries(parsed);
          // A null/primitive element is not a DexPoolSource and would throw in
          // the per-source clock filter; quarantine the row instead (R8).
          return sources != null && sources.every((source) => source != null && typeof source === "object" && !Array.isArray(source))
            ? {
                ok: true,
                payload: {
                  sources: sources as DexPoolSource[],
                  rawPayload: parsed,
                  ...readDexPriceLineage(parsed),
                  ...getDexAggregateObservedAt(parsed, nowSec),
                },
              }
            : { ok: false, reason: "invalid-shape" };
        },
      });
      if (!decoded.ok) {
        telemetry?.malformedRows.push({
          stablecoinId: row.stablecoin_id,
          updatedAt: row.updated_at,
          reason: decoded.reason,
        });
        logMalformedJsonPath({
          scope: "lib",
          owner: "depeg-helpers",
          context: "dex_prices.price_sources_json",
          reason: decoded.reason,
          source: "dex_prices",
          updatedAt: row.updated_at,
          extra: { stablecoinId: row.stablecoin_id },
        });
        continue;
      }
      Object.assign(priceRow, readDexPriceLineage(decoded.payload));
      priceRow.aggregateObservedAt = decoded.payload.aggregateObservedAt;
      if (decoded.payload.aggregateClockReason) priceRow.aggregateClockReason = decoded.payload.aggregateClockReason;
      if (
        isClockedCurveNavPayload(decoded.payload.rawPayload) &&
        assessClockedCurveNavPayload(decoded.payload.rawPayload, {
          nowSec,
          publicationUpdatedAt: row.updated_at,
          aggregateObservedAt: decoded.payload.aggregateObservedAt,
        }).reason != null
      ) {
        continue;
      }
      const sources = decoded.payload.sources
        .filter((source) => {
          if (typeof source.observedAt !== "number" || !Number.isFinite(source.observedAt) || source.observedAt <= 0 ||
            typeof source.aggregateObservedAt !== "number" || !Number.isFinite(source.aggregateObservedAt) || source.aggregateObservedAt <= 0) return false;
          const sourceAgeSec = nowSec - source.observedAt;
          const aggregateAgeSec = nowSec - source.aggregateObservedAt;
          return sourceAgeSec >= 0 && sourceAgeSec <= maxAgeSec &&
            aggregateAgeSec >= 0 && aggregateAgeSec <= DEX_FRESHNESS_SEC;
        })
        .map((source) => ({ ...source, ...readDexPriceLineage(source), updatedAt: source.observedAt! }));
      if (sources.length > 0) {
        dexPriceSources.set(row.stablecoin_id, sources);
      }
    }
    return { dexPriceRows, dexPriceSources };
  } catch (err) {
    if (isMissingTableError(err)) {
      return { dexPriceRows: new Map(), dexPriceSources: new Map() };
    }
    logWorkerEventArgs("lib", "error", "[depeg-helpers] Unexpected error loading dex_prices:", toErrorMessage(err));
    throw err;
  }
}

export function buildInsertDepegEventStmt(
  db: D1Database,
  event: DepegEvent,
  peerBasis?: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source, confirmation_sources, pending_reason, price_coverage_json, last_trusted_price_at, price_coverage_gap_started_at,
        peak_peg_reference, peak_quote_domain, peer_basis_json, admitted_coverage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.stablecoinId,
      event.symbol,
      event.pegType,
      event.direction,
      event.peakDeviationBps,
      event.startedAt,
      event.startPrice,
      event.peakPrice ?? event.startPrice,
      event.pegReference,
      event.confirmationSources ?? null,
      event.pendingReason ?? null,
      event.priceCoverage ? serializeDepegPriceCoverage(event.priceCoverage) : null,
      event.priceCoverage?.lastTrustedObservationAt ?? null,
      event.priceCoverage?.gapStartedAt ?? null,
      event.peakPegReference ?? null,
      event.peakQuoteDomain ?? null,
      peerBasis ?? null,
      event.admittedCoverage === undefined ? null : JSON.stringify(DepegAdmittedCoverageSchema.parse(event.admittedCoverage)),
    );
}

function parseDepegDirection(row: DepegRow): DepegEvent["direction"] {
  if (row.direction === "above" || row.direction === "below") return row.direction;
  throw new Error(`[depeg-helpers] Invalid direction "${row.direction}" for event ${row.id}`);
}

function parseDepegSource(row: DepegRow): DepegEvent["source"] {
  if (row.source === "live" || row.source === "backfill") return row.source;
  throw new Error(`[depeg-helpers] Invalid source "${row.source}" for event ${row.id}`);
}

function parseDepegCloseReason(row: DepegRow): DepegEventCloseReason | null {
  if (row.close_reason == null) return null;
  const reasons = DEPEG_EVENT_CLOSE_REASON_VALUES as readonly string[];
  if (reasons.includes(row.close_reason)) return row.close_reason as DepegEventCloseReason;
  throw new Error(`[depeg-helpers] Invalid close_reason "${row.close_reason}" for event ${row.id}`);
}


export function serializeDepegPriceCoverage(coverage: NonNullable<DepegEvent["priceCoverage"]>): string {
  const parsed = DepegPriceCoverageSchema.parse(coverage);
  return JSON.stringify({
    intervals: parsed.intervals,
    atParIntervals: parsed.atParIntervals,
    lastObservationKind: parsed.lastObservationKind,
  });
}

function invalidRowPriceCoverage(row: Pick<DepegRow, "id">, reason: string): null {
  logWorkerEvent({
    scope: "handler",
    level: "warn",
    event: "depeg_price_coverage_invalid",
    message: `Discarded invalid price coverage for depeg event ${row.id}`,
    metadata: { eventId: row.id, reason },
  });
  return null;
}

export function rowPriceCoverage(row: DepegRow): DepegEvent["priceCoverage"] {
  if (row.price_coverage_json == null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.price_coverage_json);
  } catch {
    return invalidRowPriceCoverage(row, "invalid-json");
  }
  if (decoded == null || typeof decoded !== "object") {
    return invalidRowPriceCoverage(row, "invalid-schema");
  }
  const parsed = DepegPriceCoverageSchema.safeParse({
    ...decoded,
    lastTrustedObservationAt: row.last_trusted_price_at ?? null,
    gapStartedAt: row.price_coverage_gap_started_at ?? null,
  });
  return parsed.success ? parsed.data : invalidRowPriceCoverage(row, "invalid-schema");
}
/** Stored coverage exists but no longer decodes: instrumented, and entirely unknown. */
function unreadablePriceCoverage(): NonNullable<DepegEvent["priceCoverage"]> {
  return { intervals: [], atParIntervals: [], lastTrustedObservationAt: null, gapStartedAt: null };
}

/** Withhold metadata when the stored observation no longer reproduces its deviation. */
export function isPairedDepegPeak(price: number | null | undefined, reference: number | null | undefined, bps: number): reference is number {
  if (price == null || reference == null) return false;
  const signal = deriveDepegSignal(price, reference);
  return signal != null && (signal.bps === bps || Math.abs(signal.rawBps - bps) <= 1e-8);
}

export function readDepegPeakQuote(
  row: Pick<DepegRow, "peak_price" | "peak_peg_reference" | "peak_quote_domain" | "peak_deviation_bps">,
): Pick<DepegEvent, "peakPegReference" | "peakQuoteDomain"> {
  const peakPegReference = row.peak_peg_reference;
  const peakQuoteDomain = DepegEventQuoteDomainSchema.safeParse(row.peak_quote_domain).data;
  return (peakQuoteDomain === "usd" || (peakQuoteDomain === "native-peg" && peakPegReference === 1)) &&
    isPairedDepegPeak(row.peak_price, peakPegReference, row.peak_deviation_bps)
    ? { peakPegReference, peakQuoteDomain } : {};
}

type DepegCoverageRow = Pick<DepegRow, "id" | "admitted_coverage_json" | "disposition"> & Partial<Pick<DepegRow, "started_at" | "ended_at">>;

/** Undefined allows legacy coverage. Null identifies unreadable evidence. */
export function readDepegCoverageLedger(row: DepegCoverageRow): DepegEvent["admittedCoverage"] | null {
  if (row.disposition != null && !DepegEventDispositionSchema.safeParse(row.disposition).success) return null;
  // A reviewed interval ledger with missing samples has no admitted duration.
  if (row.admitted_coverage_json == null) return row.disposition === "admitted-coverage" ? [] : undefined;
  try {
    const intervals = DepegAdmittedCoverageSchema.parse(JSON.parse(row.admitted_coverage_json));
    return intervals.some((span) => (row.started_at != null && span.fromSec < row.started_at) ||
      (row.ended_at != null && span.toSec > row.ended_at)) ? null : intervals;
  } catch {
    return invalidRowPriceCoverage(row, "invalid-admitted-coverage");
  }
}

export function readDepegAdmittedCoverage(row: DepegCoverageRow): DepegEvent["admittedCoverage"] {
  const ledger = readDepegCoverageLedger(row);
  return ledger === null ? [] : ledger;
}

const storedReferenceHoldSchema = z.object({
  hold: PegReferenceHoldSchema,
  source: z.string().min(1),
  referenceAt: z.number().int().positive(),
  reopenAt: z.number().int().positive(),
});
export type StoredReferenceHold = z.output<typeof storedReferenceHoldSchema>;

export function matchesDepegReferenceHoldRow(row: DepegRow, hold: StoredReferenceHold["hold"]): boolean {
  return row.ended_at === null && hold.lastTrustedAtSec === row.last_trusted_price_at &&
    hold.lastTrustedPeakBps === row.peak_deviation_bps && row.price_coverage_gap_started_at != null &&
    hold.declaredAtSec >= row.price_coverage_gap_started_at;
}

export function readDepegReferenceHold(row: DepegRow): StoredReferenceHold | undefined {
  if (!row.reference_hold_json) return undefined;
  try {
    const hold = storedReferenceHoldSchema.safeParse(JSON.parse(row.reference_hold_json));
    if (hold.success && matchesDepegReferenceHoldRow(row, hold.data.hold)) return hold.data;
  } catch { /* Malformed hold evidence supplies no active penalty. */ }
  return undefined;
}

export function readDepegProvenanceJson(encoded: DepegRow["provenance_json"]): DepegEvent["provenance"] {
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(encoded) as DepegEvent["provenance"];
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Convert a snake_case D1 row to a camelCase DepegEvent */
export function rowToDepegEvent(row: DepegRow): PegScoreEvent {
  const direction = parseDepegDirection(row);
  const source = parseDepegSource(row);
  const closeReason = parseDepegCloseReason(row);
  let provenance = readDepegProvenanceJson(row.provenance_json);
  // Validate outside the JSON-syntax catch: unknown archived evidence must not
  // become a null verdict and silently regain score eligibility.
  if (provenance?.auditVerdict != null) {
    DepegAuditVerdictSchema.parse(provenance.auditVerdict);
  }
  if (row.provenance_audit_verdict != null) {
    DepegAuditVerdictSchema.parse(row.provenance_audit_verdict);
  }
  if (
    provenance == null &&
    (row.provenance_confidence_tier || row.provenance_audit_verdict || row.provenance_replay_run_id || row.provenance_replay_version)
  ) {
    provenance = {
      confidenceTier: row.provenance_confidence_tier ?? null,
      auditVerdict: DepegAuditVerdictSchema.nullable().parse(row.provenance_audit_verdict ?? null),
      replayRunId: row.provenance_replay_run_id ?? null,
      replayVersion: row.provenance_replay_version ?? null,
    };
  }
  const admittedCoverage = readDepegAdmittedCoverage(row);
  const disposition = DepegEventDispositionSchema.safeParse(row.disposition);
  const recoveryRef = row.recovery_peg_reference;
  const hold = row.ended_at == null ? readDepegReferenceHold(row)?.hold : undefined;
  return {
    id: row.id,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    pegType: row.peg_type,
    direction,
    peakDeviationBps: row.peak_deviation_bps,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startPrice: row.start_price,
    peakPrice: row.peak_price,
    ...readDepegPeakQuote(row),
    ...(row.recovery_price != null && Number.isFinite(row.recovery_price) && row.recovery_price > 0 &&
      typeof recoveryRef === "number" && Number.isFinite(recoveryRef) && recoveryRef > 0
      ? { recoveryPegReference: recoveryRef } : {}),
    ...(admittedCoverage !== undefined ? { admittedCoverage } : {}),
    ...(hold ? { referenceHold: hold } : {}),
    ...(disposition.success ? { disposition: disposition.data } : {}),
    recoveryPrice: row.recovery_price,
    pegReference: row.peg_reference,
    source,
    confirmationSources: row.confirmation_sources ?? null,
    pendingReason: row.pending_reason ?? null,
    closeReason,
    // A row that carries a coverage column but whose stored intervals no longer
    // decode is instrumented and unread: an explicit empty coverage keeps it
    // from falling back to its recorded episode duration as observed off-peg time.
    priceCoverage: rowPriceCoverage(row)
      ?? (row.price_coverage_json != null ? unreadablePriceCoverage() : null),
    provenance,
  };
}
