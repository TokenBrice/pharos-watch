import {
  DEPEG_EVENT_CLOSE_REASON_VALUES,
  type DepegEvent,
  type DepegEventCloseReason,
} from "@shared/types/market";
import {
  loadPublishedDexPoolChallengers,
  type DexPriceChallengerLoadRow,
} from "../cron/dex-liquidity/challenger-persistence";
import { decodeJsonString } from "./cache-json";
import {
  deriveDepegSignal,
  signalCrossesThreshold,
  type DepegDirection,
  type DepegSignal,
} from "./depeg-signals";
import { isMissingTableError } from "./db";
import { logMalformedJsonPath } from "./json-decode-observability";
import { toErrorMessage } from "./error-utils";

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
  provenance_json?: string | null;
  provenance_confidence_tier?: string | null;
  provenance_audit_verdict?: string | null;
  provenance_replay_run_id?: string | null;
  provenance_replay_version?: string | null;
}

/** Column list for the detector's depeg_events SELECT shape. */
export const DEPEG_EVENTS_DEPEGROW_COLUMNS =
  "id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source, recovery_first_seen_at";

export interface DexPriceRow {
  stablecoin_id: string;
  dex_price_usd: number;
  deviation_from_primary_bps: number | null;
  source_pool_count: number;
  source_total_tvl: number;
  updated_at: number;
}

export type PendingDepegReasonFlag = "confirmation-window" | "large-cap" | "low-confidence" | "extreme-move";
export const NATIVE_ORIGIN_PENDING_REASON_FLAG = "native-origin";
/**
 * Stored reason is a "+"-joined list of flags in canonical order:
 * confirmation-window > extreme-move > large-cap > low-confidence.
 */
export type PendingDepegReason = string;

const REASON_ORDER: PendingDepegReasonFlag[] = ["confirmation-window", "extreme-move", "large-cap", "low-confidence"];

export function buildPendingReason(flags: Iterable<PendingDepegReasonFlag>): PendingDepegReason {
  const set = new Set(flags);
  return REASON_ORDER.filter((f) => set.has(f)).join("+");
}

export function parsePendingReason(reason: PendingDepegReason | null | undefined): Set<PendingDepegReasonFlag> {
  const result = new Set<PendingDepegReasonFlag>();
  if (!reason) return result;
  for (const part of reason.split("+")) {
    if (part === "confirmation-window" || part === "large-cap" || part === "low-confidence" || part === "extreme-move") {
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

export async function loadDexPriceRows(db: D1Database): Promise<Map<string, DexPriceRow>> {
  try {
    const dexResult = await db
      .prepare("SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices")
      .all<DexPriceRow>();
    return new Map((dexResult.results ?? []).map((row) => [row.stablecoin_id, row]));
  } catch (err) {
    const msg = toErrorMessage(err);
    if (isMissingTableError(err)) {
      return new Map<string, DexPriceRow>();
    }
    console.error("[depeg-helpers] Unexpected error loading dex_prices:", msg);
    throw err;
  }
}

/** Per-protocol price source stored in dex_prices.price_sources_json */
export interface DexPoolSource {
  protocol: string;
  chain: string;
  price: number;
  tvl: number;
  updatedAt: number;
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
): Promise<Map<string, Array<{ price: number; tvlUsd: number; protocol: string; chain: string; observedAt?: number; sourceFamily?: string }>>> {
  const { challengersByStablecoin, diagnostics } = await loadPublishedDexPoolChallengers(
    db,
    minPoolTvlUsd,
    maxAgeSec,
    nowSec,
  );

  if (diagnostics.mode !== "absent") {
    if (diagnostics.incompletePublishedCoins.length > 0) {
      console.warn(
        `[depeg-helpers] Incomplete challenger snapshots fell back for: ${diagnostics.incompletePublishedCoins.join(", ")}`,
      );
    }
    if (diagnostics.emptyPublishedCoins.length > 0) {
      console.log(
        `[depeg-helpers] Published empty challenger snapshots for: ${diagnostics.emptyPublishedCoins.join(", ")}`,
      );
    }
    if (diagnostics.legacyFallbackCoins.length > 0 && diagnostics.mode !== "legacy") {
      console.log(
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
        observedAt: row.snapshotAt,
        sourceFamily: row.sourceFamily,
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
  const groups = new Map<string, DexProtocolCorroboration>();
  for (const source of protocolSources) {
    const signal = deriveDepegSignal(source.price, pegRef);
    if (signal == null) continue;

    const matches =
      mode === "recover"
        ? signal.absBps < threshold
        : signalCrossesThreshold(signal, threshold) &&
          (mode === "confirm" ? signal.direction === direction : signal.direction !== direction);
    if (!matches) continue;

    const key = dexProtocolGroupKey(source);
    const existing = groups.get(key);
    if (
      existing == null ||
      (mode === "recover"
        ? signal.absBps < existing.signal.absBps
        : signal.absBps > existing.signal.absBps)
    ) {
      groups.set(key, { key, source, signal });
    }
  }
  return [...groups.values()];
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

/** Load per-protocol price breakdowns from dex_prices.price_sources_json for trusted rows. */
export async function loadDexPriceSources(
  db: D1Database,
  maxAgeSec = 2100, // 35 min = 30min cron + 5min buffer
  telemetry?: DexPriceSourceLoadTelemetry,
): Promise<Map<string, DexPoolSource[]>> {
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const rows = await db
      .prepare("SELECT stablecoin_id, price_sources_json, updated_at FROM dex_prices WHERE price_sources_json IS NOT NULL")
      .all<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>();

    const result = new Map<string, DexPoolSource[]>();
    for (const row of rows.results ?? []) {
      const ageSec = nowSec - row.updated_at;
      if (ageSec > maxAgeSec) {
        telemetry?.staleRows.push({
          stablecoinId: row.stablecoin_id,
          updatedAt: row.updated_at,
          ageSec,
          maxAgeSec,
        });
        continue;
      }
      const decoded = decodeJsonString<DexPoolSource[], DexJsonDecodeReason>(row.price_sources_json, {
        mode: "degraded",
        updatedAt: row.updated_at,
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: (parsed) => Array.isArray(parsed)
          ? { ok: true, payload: parsed as DexPoolSource[] }
          : { ok: false, reason: "invalid-shape" },
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
      if (decoded.payload.length === 0) continue;
      const sources = decoded.payload
        .map((source) => ({
          ...source,
          updatedAt:
            typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt) && source.updatedAt > 0
              ? source.updatedAt
              : row.updated_at,
        }))
        .filter((source) => {
          const ageSec = nowSec - source.updatedAt;
          return ageSec >= 0 && ageSec <= maxAgeSec;
        });
      if (sources.length > 0) {
        result.set(row.stablecoin_id, sources);
      }
    }
    return result;
  } catch (err) {
    const msg = toErrorMessage(err);
    if (!isMissingTableError(err)) {
      console.error("[depeg-helpers] Unexpected error loading dex price sources:", msg);
    }
    return new Map();
  }
}

export function buildInsertDepegEventStmt(
  db: D1Database,
  event: DepegEvent,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source, confirmation_sources, pending_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)`,
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

/** Convert a snake_case D1 row to a camelCase DepegEvent */
export function rowToDepegEvent(row: DepegRow): DepegEvent {
  const direction = parseDepegDirection(row);
  const source = parseDepegSource(row);
  const closeReason = parseDepegCloseReason(row);
  let provenance: DepegEvent["provenance"] = null;
  if (row.provenance_json) {
    try {
      const parsed = JSON.parse(row.provenance_json) as DepegEvent["provenance"];
      provenance = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      provenance = null;
    }
  }
  if (
    provenance == null &&
    (row.provenance_confidence_tier || row.provenance_audit_verdict || row.provenance_replay_run_id || row.provenance_replay_version)
  ) {
    provenance = {
      confidenceTier: row.provenance_confidence_tier ?? null,
      auditVerdict: row.provenance_audit_verdict ?? null,
      replayRunId: row.provenance_replay_run_id ?? null,
      replayVersion: row.provenance_replay_version ?? null,
    };
  }
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
    recoveryPrice: row.recovery_price,
    pegReference: row.peg_reference,
    source,
    confirmationSources: row.confirmation_sources ?? null,
    pendingReason: row.pending_reason ?? null,
    closeReason,
    provenance,
  };
}
