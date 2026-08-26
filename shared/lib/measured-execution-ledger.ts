/**
 * Durable measured-execution evidence ledger (Liquidity Score v6 Phase 0.4).
 *
 * The DEX shadow lane publishes targets once daily (06:16 UTC scoring run) and
 * quotes them once daily (08:10 UTC shadow sync), while the staging tables
 * prune at three hours — consecutive daily generations never coexist in D1.
 * This module encodes two small per-run records into `worker_producer_history`
 * scalar metadata (30-day retention) so admission decisions (Record A) and
 * quote outcomes (Record B) stay joinable per policy cohort:
 *
 *   mxLedgerV: 1   mxLedgerKind: "A"|"B"   mxLedgerCycle: <slot epoch>
 *   mxLedgerParts: <n>   mxLedger0..n-1: <=240-char JSON body chunks
 *
 * The chunk scheme exists because producer history keeps only top-level scalar
 * metadata values, truncates each string to 240 chars, and bounds the whole
 * scalar object to 2,000 serialized chars. Everything here is runtime-neutral;
 * the D1 read path lives in `worker/src/lib/measured-execution-ledger-query.ts`.
 */

export const MEASURED_LEDGER_VERSION = 1;
export const MEASURED_LEDGER_CHUNK_CHARS = 240;
/** Default chunk budget; 6 chunks ≈ 1,440 body chars, comfortably over the 14-cohort shape. */
const MEASURED_LEDGER_DEFAULT_MAX_PARTS = 6;


/** Record A (06:16 scoring run): shadow target-admission outcome per policy cohort. */
export interface MeasuredLedgerAdmissionCohort {
  eligible: number;
  rejected: number;
  published: number;
  /** First observed admission gate (`family:reason`) or publication-failure marker. */
  gateReason: string | null;
}

/** Record B (08:10 shadow sync): quote outcome per policy cohort. */
export interface MeasuredLedgerQuoteCohort {
  measured: number;
  failed: number;
  budgetDeferred: number;
  monotonicityViolations: number;
  costBoundViolations: number;
}

export interface MeasuredLedgerRecordA {
  kind: "A";
  /** Slot epoch of the emitting run (seconds). */
  cycle: number;
  targetGenerationId: string | null;
  solanaTargetGenerationId: string | null;
  tronTargetGenerationId: string | null;
  cohorts: Record<string, MeasuredLedgerAdmissionCohort>;
  /** Whole cohorts dropped deterministically to honor the chunk budget. */
  truncatedCohorts: number;
}

export interface MeasuredLedgerRecordB {
  kind: "B";
  cycle: number;
  targetGenerationId: string | null;
  quoteGenerationId: string | null;
  cohorts: Record<string, MeasuredLedgerQuoteCohort>;
  truncatedCohorts: number;
}

export type MeasuredLedgerRecord = MeasuredLedgerRecordA | MeasuredLedgerRecordB;

/**
 * Adapter profiles whose shadow lane runs exactly one reviewed policy per
 * chain, so `adapter@chain` is already a stable per-policy identity. Every
 * other cohort keys on pool + stablecoin: eleven of the twelve Curve composite
 * policies share one adapter profile and most share `ethereum`, so keying on
 * adapter+chain would let a healthy policy mask a broken sibling.
 */
const FAMILY_SCOPED_MEASURED_ADAPTER_PROFILE_IDS: ReadonlySet<string> = new Set([
  "uniswap-v3-quoter-v2",
]);

const COHORT_POOL_TAIL_CHARS = 8;
const COHORT_STABLECOIN_CHARS = 12;

/**
 * Stable, compact per-policy cohort key. Short by design: the whole record
 * must survive the 2,000-char producer-history scalar bound, and both records
 * derive keys from the same target fields, so the abbreviation is joinable.
 */
export function buildMeasuredLedgerCohortKey(input: {
  adapterProfileId?: string | null;
  chain: string;
  poolId?: string | null;
  stablecoinId?: string | null;
}): string {
  const chain = input.chain.trim().toLowerCase();
  const adapterProfileId = input.adapterProfileId?.trim().toLowerCase() ?? null;
  if (adapterProfileId && FAMILY_SCOPED_MEASURED_ADAPTER_PROFILE_IDS.has(adapterProfileId)) {
    return `${adapterProfileId}@${chain}`;
  }
  let pool = input.poolId?.trim().toLowerCase() ?? "";
  if (pool.startsWith(`${chain}:`)) pool = pool.slice(chain.length + 1);
  const poolTail = pool.length > 0 ? pool.slice(-COHORT_POOL_TAIL_CHARS) : "none";
  const coin = (input.stablecoinId?.trim().toLowerCase() ?? "unknown").slice(0, COHORT_STABLECOIN_CHARS);
  return `${chain}:${poolTail}:${coin}`;
}

type LedgerBody = {
  cy: number;
  tg: string | null;
  ts?: string | null;
  tt?: string | null;
  qg?: string | null;
  tr: number;
  c: Record<string, (string | number)[]>;
};

function cohortPayload(record: MeasuredLedgerRecord, key: string): (string | number)[] {
  if (record.kind === "A") {
    const cohort = record.cohorts[key]!;
    return [cohort.eligible, cohort.rejected, cohort.published, cohort.gateReason ?? 0];
  }
  const cohort = record.cohorts[key]!;
  return [
    cohort.measured,
    cohort.failed,
    cohort.budgetDeferred,
    cohort.monotonicityViolations,
    cohort.costBoundViolations,
  ];
}

function serializeBody(record: MeasuredLedgerRecord, keys: readonly string[], truncated: number): string {
  const body: LedgerBody = {
    cy: record.cycle,
    tg: record.targetGenerationId,
    ...(record.kind === "A"
      ? { ts: record.solanaTargetGenerationId, tt: record.tronTargetGenerationId }
      : { qg: record.quoteGenerationId }),
    tr: record.truncatedCohorts + truncated,
    c: {},
  };
  for (const key of keys) body.c[key] = cohortPayload(record, key);
  return JSON.stringify(body);
}

/**
 * Encodes one record into flat scalar metadata keys. Cohorts are dropped
 * whole, from the end of the sorted key order, until the body fits the chunk
 * budget; the drop count rides in the body as `tr`.
 */
export function encodeMeasuredLedgerRecord(
  record: MeasuredLedgerRecord,
  options: { maxParts?: number } = {},
): Record<string, string | number> {
  const maxParts = options.maxParts ?? MEASURED_LEDGER_DEFAULT_MAX_PARTS;
  const maxBodyChars = maxParts * MEASURED_LEDGER_CHUNK_CHARS;
  const keys = Object.keys(record.cohorts).sort();
  let retained = keys.length;
  let body = serializeBody(record, keys, 0);
  while (retained > 0 && body.length > maxBodyChars) {
    retained -= 1;
    body = serializeBody(record, keys.slice(0, retained), keys.length - retained);
  }
  const parts = Math.max(1, Math.ceil(body.length / MEASURED_LEDGER_CHUNK_CHARS));
  const encoded: Record<string, string | number> = {
    mxLedgerV: MEASURED_LEDGER_VERSION,
    mxLedgerKind: record.kind,
    mxLedgerCycle: record.cycle,
    mxLedgerParts: parts,
  };
  for (let index = 0; index < parts; index += 1) {
    encoded[`mxLedger${index}`] = body.slice(
      index * MEASURED_LEDGER_CHUNK_CHARS,
      (index + 1) * MEASURED_LEDGER_CHUNK_CHARS,
    );
  }
  return encoded;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodeAdmissionCohort(payload: unknown): MeasuredLedgerAdmissionCohort | null {
  if (!Array.isArray(payload) || payload.length !== 4) return null;
  const [eligible, rejected, published, gateReason] = payload;
  if (
    typeof eligible !== "number" ||
    typeof rejected !== "number" ||
    typeof published !== "number" ||
    (typeof gateReason !== "string" && gateReason !== 0)
  ) {
    return null;
  }
  return { eligible, rejected, published, gateReason: gateReason === 0 ? null : gateReason };
}

function decodeQuoteCohort(payload: unknown): MeasuredLedgerQuoteCohort | null {
  if (!Array.isArray(payload) || payload.length !== 5) return null;
  if (payload.some((value) => typeof value !== "number")) return null;
  const [measured, failed, budgetDeferred, monotonicityViolations, costBoundViolations] =
    payload as number[];
  return {
    measured: measured!,
    failed: failed!,
    budgetDeferred: budgetDeferred!,
    monotonicityViolations: monotonicityViolations!,
    costBoundViolations: costBoundViolations!,
  };
}

/**
 * Reassembles one record from a parsed metadata object. Fail-closed: any
 * missing chunk, foreign shape, or version drift yields null rather than a
 * partially decoded record.
 */
export function decodeMeasuredLedgerRecord(
  metadata: Record<string, unknown>,
): MeasuredLedgerRecord | null {
  if (metadata.mxLedgerV !== MEASURED_LEDGER_VERSION) return null;
  const kind = metadata.mxLedgerKind;
  if (kind !== "A" && kind !== "B") return null;
  const cycle = metadata.mxLedgerCycle;
  const parts = metadata.mxLedgerParts;
  if (typeof cycle !== "number" || !Number.isFinite(cycle)) return null;
  if (typeof parts !== "number" || !Number.isSafeInteger(parts) || parts < 1) return null;
  let body = "";
  for (let index = 0; index < parts; index += 1) {
    const chunk = metadata[`mxLedger${index}`];
    if (typeof chunk !== "string") return null;
    body += chunk;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const rawCohorts = raw.c;
  if (!rawCohorts || typeof rawCohorts !== "object" || Array.isArray(rawCohorts)) return null;
  const truncatedCohorts = typeof raw.tr === "number" && raw.tr >= 0 ? raw.tr : 0;
  if (kind === "A") {
    const cohorts: Record<string, MeasuredLedgerAdmissionCohort> = {};
    for (const [key, payload] of Object.entries(rawCohorts as Record<string, unknown>)) {
      const cohort = decodeAdmissionCohort(payload);
      if (!cohort) return null;
      cohorts[key] = cohort;
    }
    return {
      kind,
      cycle,
      targetGenerationId: asOptionalString(raw.tg),
      solanaTargetGenerationId: asOptionalString(raw.ts),
      tronTargetGenerationId: asOptionalString(raw.tt),
      cohorts,
      truncatedCohorts,
    };
  }
  const cohorts: Record<string, MeasuredLedgerQuoteCohort> = {};
  for (const [key, payload] of Object.entries(rawCohorts as Record<string, unknown>)) {
    const cohort = decodeQuoteCohort(payload);
    if (!cohort) return null;
    cohorts[key] = cohort;
  }
  return {
    kind,
    cycle,
    targetGenerationId: asOptionalString(raw.tg),
    quoteGenerationId: asOptionalString(raw.qg),
    cohorts,
    truncatedCohorts,
  };
}

export interface MeasuredLedgerLadderPoint {
  inputUsd: number;
  costBps: number;
  passesCostBound: boolean;
  reverted?: boolean;
}

/**
 * Counts descending-cost steps across a quote ladder ordered by ascending
 * input notional. Points may be dropped or missing; the check runs over the
 * points that exist. Tolerance defaults to one basis point.
 */
export function countMeasuredLadderMonotonicityViolations(
  points: readonly MeasuredLedgerLadderPoint[],
  toleranceBps = 1,
): number {
  const ordered = [...points].sort((left, right) => left.inputUsd - right.inputUsd);
  let violations = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.costBps < ordered[index - 1]!.costBps - toleranceBps) violations += 1;
  }
  return violations;
}

const COST_BOUND_FLAG_EPSILON_BPS = 0.000001;
const REVERT_COST_TOLERANCE_BPS = 0.02;

/**
 * Counts points whose `passesCostBound` flag disagrees with the cost bound,
 * plus reverted points that do not materialize as consistent total-loss
 * failures (`costBps` ≈ 10,000 and `passesCostBound === false`).
 */
export function countMeasuredLadderCostBoundViolations(
  points: readonly MeasuredLedgerLadderPoint[],
  maxCostBps: number,
): number {
  let violations = 0;
  for (const point of points) {
    if (point.reverted === true) {
      if (Math.abs(point.costBps - 10_000) > REVERT_COST_TOLERANCE_BPS || point.passesCostBound) {
        violations += 1;
      }
      continue;
    }
    if (point.passesCostBound !== (point.costBps <= maxCostBps + COST_BOUND_FLAG_EPSILON_BPS)) {
      violations += 1;
    }
  }
  return violations;
}

export type MeasuredCohortTriState =
  | "no-eligible-source-row"
  | "eligible-source-rejected"
  | "target-produced-no-quote"
  | "quoted";

export interface MeasuredLedgerJoinedCohortCycle {
  /** UTC day (YYYY-MM-DD) of the admission cycle. */
  cycleDay: string;
  cohortKey: string;
  state: MeasuredCohortTriState;
  admission: MeasuredLedgerAdmissionCohort | null;
  quotes: MeasuredLedgerQuoteCohort | null;
}

function utcDay(cycleSec: number): string {
  return new Date(cycleSec * 1_000).toISOString().slice(0, 10);
}

/**
 * Joins Record A and Record B streams per daily cycle and derives the
 * Phase 0.1 tri-state per policy cohort. The cohort universe is the union of
 * cohorts seen anywhere in the window, so a cohort that stops producing rows
 * surfaces as `no-eligible-source-row` instead of silently disappearing.
 * B joins its A by target generation id first, calendar day second.
 */
export function joinMeasuredLedgerRecords(
  records: readonly MeasuredLedgerRecord[],
): MeasuredLedgerJoinedCohortCycle[] {
  const admissionByDay = new Map<string, MeasuredLedgerRecordA>();
  const quotesByGeneration = new Map<string, MeasuredLedgerRecordB>();
  const quotesByDay = new Map<string, MeasuredLedgerRecordB>();
  const cohortUniverse = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record.cohorts)) cohortUniverse.add(key);
    if (record.kind === "A") {
      const day = utcDay(record.cycle);
      const existing = admissionByDay.get(day);
      if (!existing || record.cycle >= existing.cycle) admissionByDay.set(day, record);
      continue;
    }
    if (record.targetGenerationId) {
      const existing = quotesByGeneration.get(record.targetGenerationId);
      if (!existing || record.cycle >= existing.cycle) {
        quotesByGeneration.set(record.targetGenerationId, record);
      }
    }
    const day = utcDay(record.cycle);
    const existingDay = quotesByDay.get(day);
    if (!existingDay || record.cycle >= existingDay.cycle) quotesByDay.set(day, record);
  }

  const joined: MeasuredLedgerJoinedCohortCycle[] = [];
  const sortedDays = [...admissionByDay.keys()].sort();
  const sortedCohorts = [...cohortUniverse].sort();
  for (const day of sortedDays) {
    const recordA = admissionByDay.get(day)!;
    const recordB =
      (recordA.targetGenerationId ? quotesByGeneration.get(recordA.targetGenerationId) : undefined) ??
      quotesByDay.get(day) ??
      null;
    for (const cohortKey of sortedCohorts) {
      const admission = recordA.cohorts[cohortKey] ?? null;
      const quotes = recordB?.cohorts[cohortKey] ?? null;
      let state: MeasuredCohortTriState;
      if (!admission || admission.eligible === 0) {
        state = "no-eligible-source-row";
      } else if (admission.published === 0) {
        state = "eligible-source-rejected";
      } else if (quotes && quotes.measured > 0) {
        state = "quoted";
      } else {
        state = "target-produced-no-quote";
      }
      joined.push({ cycleDay: day, cohortKey, state, admission, quotes });
    }
  }
  return joined;
}
