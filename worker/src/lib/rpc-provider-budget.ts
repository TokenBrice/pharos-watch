import { hasConfiguredValue } from "@shared/lib/env-utils";
import { isRecord } from "@shared/lib/type-guards";
import { sleep } from "./abort";
import { getCache } from "./db-cache";
import { logWorkerEvent } from "./structured-log";

/**
 * Credit accounting for the Dwellir supplemental-RPC trial.
 *
 * Dwellir meters JSON-RPC response items per UTC calendar month and the plan is
 * shared by every isolate serving the trial, so the only durable authority is
 * one cache-table row per month. Increments compare-and-swap on the stored row,
 * and an unreadable row fails closed: overspending the shared plan would take
 * the trial offline for the rest of the month.
 */

export const DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH = 20_000_000;

const DWELLIR_CREDIT_LEDGER_CACHE_PREFIX = "rpc:dwellir:credits:v1";
const DWELLIR_LEDGER_CAS_ATTEMPTS = 3;
const DWELLIR_LEDGER_CAS_RETRY_DELAY_MS = 25;

export type DwellirBudgetReason = "ok" | "not-configured" | "provider-budget-exhausted" | "ledger-unreadable";

export interface DwellirBudgetState {
  configured: boolean;
  usable: boolean;
  reason: DwellirBudgetReason;
  window: string;
  usedCredits: number | null;
  capCredits: number;
  observedAtSec: number;
}

export interface DwellirBudgetEnv {
  DWELLIR_API_KEY?: string;
  DWELLIR_MAX_CREDITS_PER_MONTH?: string;
}

/** Credits observed by this isolate since the last successful flush. */
let pendingDwellirCredits = 0;

function getUtcMonthWindow(nowSec: number): string {
  const date = new Date(nowSec * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getMaxCreditsPerMonth(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) return DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH;
}

function parseCreditLedgerUsedCredits(value: string, window: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.window !== window) return null;
  const usedCredits = parsed.usedCredits;
  return Number.isSafeInteger(usedCredits) && (usedCredits as number) >= 0 ? (usedCredits as number) : null;
}

type DwellirCreditLedgerRead =
  | { state: "missing" }
  | { state: "valid"; usedCredits: number; raw: string }
  | { state: "corrupt" };

/** Reads the month's ledger row. Throws only when D1 itself cannot be read. */
async function readCreditLedger(db: D1Database, window: string): Promise<DwellirCreditLedgerRead> {
  const cached = await getCache(db, `${DWELLIR_CREDIT_LEDGER_CACHE_PREFIX}:${window}`);
  if (cached == null) return { state: "missing" };
  const usedCredits = parseCreditLedgerUsedCredits(cached.value, window);
  return usedCredits == null ? { state: "corrupt" } : { state: "valid", usedCredits, raw: cached.value };
}

export async function loadDwellirBudgetState(
  db: D1Database,
  env: DwellirBudgetEnv,
  nowSec: number,
): Promise<DwellirBudgetState> {
  const window = getUtcMonthWindow(nowSec);
  const capCredits = getMaxCreditsPerMonth(env.DWELLIR_MAX_CREDITS_PER_MONTH);
  const observedAtSec = nowSec;
  // The key is the kill switch: without it no request can be billed, so the
  // ledger is not read and every caller must skip Dwellir.
  if (!hasConfiguredValue(env.DWELLIR_API_KEY)) {
    return {
      configured: false,
      usable: false,
      reason: "not-configured",
      window,
      usedCredits: null,
      capCredits,
      observedAtSec,
    };
  }
  try {
    const read = await readCreditLedger(db, window);
    if (read.state !== "corrupt") {
      const usedCredits = read.state === "missing" ? 0 : read.usedCredits;
      const exhausted = usedCredits >= capCredits;
      return {
        configured: true,
        usable: !exhausted,
        reason: exhausted ? "provider-budget-exhausted" : "ok",
        window,
        usedCredits,
        capCredits,
        observedAtSec,
      };
    }
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dwellir_credit_ledger_corrupt",
      message: "Dwellir monthly credit ledger row is not readable",
      provider: "dwellir",
      source: "credit-ledger",
      metadata: { window },
    });
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dwellir_credit_ledger_read_failed",
      message: "Dwellir monthly credit ledger read failed",
      provider: "dwellir",
      source: "credit-ledger",
      error,
      metadata: { window },
    });
  }
  return {
    configured: true,
    usable: false,
    reason: "ledger-unreadable",
    window,
    usedCredits: null,
    capCredits,
    observedAtSec,
  };
}

/**
 * Adds to the isolate-local pending counter (1 credit per JSON-RPC response
 * item, including errors). Counts are truncated to whole credits; non-finite
 * and non-positive results are ignored.
 */
export function recordDwellirCredits(count: number): void {
  if (!Number.isFinite(count)) return;
  const credits = Math.trunc(count);
  if (credits <= 0) return;
  pendingDwellirCredits += credits;
}

type DwellirCreditWriteOutcome = "flushed" | "cas-lost" | "ledger-unreadable" | "failed";

type DwellirCreditWriteResult =
  | { outcome: "flushed" }
  | { outcome: "cas-lost" }
  | { outcome: "ledger-unreadable" }
  | { outcome: "failed"; error: unknown };

const DWELLIR_FLUSH_FAILURE_MESSAGES: Record<Exclude<DwellirCreditWriteOutcome, "flushed">, string> = {
  "cas-lost": "Dwellir credit flush lost the monthly ledger compare-and-swap; credits returned to the pending counter",
  "ledger-unreadable": "Dwellir credit flush skipped an unreadable monthly ledger row; credits returned to the pending counter",
  "failed": "Dwellir credit flush failed; credits returned to the pending counter",
};

async function addPendingCreditsToLedger(
  db: D1Database,
  window: string,
  credits: number,
  nowSec: number,
): Promise<DwellirCreditWriteResult> {
  try {
    for (let attempt = 1; attempt <= DWELLIR_LEDGER_CAS_ATTEMPTS; attempt++) {
      const read = await readCreditLedger(db, window);
      if (read.state === "corrupt") return { outcome: "ledger-unreadable" };
      const usedCredits = (read.state === "missing" ? 0 : read.usedCredits) + credits;
      const result = await db
        .prepare(
          `INSERT INTO cache (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at
           WHERE cache.value IS ?`,
        )
        .bind(
          `${DWELLIR_CREDIT_LEDGER_CACHE_PREFIX}:${window}`,
          JSON.stringify({ window, usedCredits }),
          nowSec,
          read.state === "missing" ? null : read.raw,
        )
        .run();
      if ((result.meta.changes ?? 0) === 1) return { outcome: "flushed" };
      if (attempt < DWELLIR_LEDGER_CAS_ATTEMPTS) await sleep(DWELLIR_LEDGER_CAS_RETRY_DELAY_MS * attempt);
    }
    return { outcome: "cas-lost" };
  } catch (error) {
    return { outcome: "failed", error };
  }
}

/**
 * Drains the pending counter into the month's ledger row (compare-and-swap,
 * bounded retries). On failure the drained amount is restored to the pending
 * counter. Never throws.
 */
export async function flushDwellirCredits(
  db: D1Database,
  nowSec: number,
): Promise<{ flushedCredits: number; ok: boolean }> {
  const credits = pendingDwellirCredits;
  if (credits <= 0) return { flushedCredits: 0, ok: true };
  pendingDwellirCredits = 0;
  const window = getUtcMonthWindow(nowSec);
  const result = await addPendingCreditsToLedger(db, window, credits, nowSec);
  if (result.outcome === "flushed") {
    return { flushedCredits: credits, ok: true };
  }
  pendingDwellirCredits += credits;
  logWorkerEvent({
    scope: "lib",
    level: "warn",
    event: "dwellir_credit_flush_failed",
    message: DWELLIR_FLUSH_FAILURE_MESSAGES[result.outcome],
    provider: "dwellir",
    source: "credit-ledger",
    ...(result.outcome === "failed" ? { error: result.error } : {}),
    metadata: { window, credits },
  });
  return { flushedCredits: 0, ok: false };
}
