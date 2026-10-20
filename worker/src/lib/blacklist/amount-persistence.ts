import type { BlacklistAmountStatus } from "@shared/types/market";
import type { ContractEventConfig } from "../blacklist-contracts";
import { shouldSuppressAsMirrorZero } from "./shared";

const SELECTED_AMOUNT_STATE_COLUMNS = [
  "amount_native", "amount_usd_at_event", "amount_source", "amount_status",
  "amount_attempt_count", "amount_last_attempted_at",
  "provenance_source", "provenance_observed_at", "contract_address", "config_key",
] as const;

/** Selected evidence generation, including legacy-derived-zero and provenance-only repairs. */
export type BlacklistAmountSelectedState = {
  [K in typeof SELECTED_AMOUNT_STATE_COLUMNS[number]]: string | number | null;
};

export interface RecoveredBlacklistAmountPersistenceInput {
  eventId: string;
  eventType: string;
  config: ContractEventConfig;
  amount: number;
  amountUsd: number | null;
  amountSource: "event" | "historical_balance" | "derived" | "unavailable";
  amountStatus: "resolved" | "provider_failed";
  attemptedAt: number;
  lastErrorClass: string | null;
  lastProvider: string;
  /** Exact evidence origin, written only by lanes that attach replay provenance. */
  provenanceSource?: string | null;
  provenanceObservedAt?: number | null;
}

/**
 * Attempt bookkeeping shared by every recovery lane. `amountStatus` is optional
 * because derived-zero retries keep their legacy status until they exhaust.
 */
export function buildBlacklistAmountAttemptUpdate(
  db: D1Database,
  input: {
    eventId: string;
    attemptedAt: number;
    errorClass: string | null;
    lastProvider: string;
    amountStatus?: BlacklistAmountStatus;
  },
  options: BlacklistAmountWriteGuardOptions = {},
): D1PreparedStatement {
  const statusClause = input.amountStatus !== undefined ? `,\n               amount_status = ?` : "";
  const statement = db.prepare(
    `UPDATE blacklist_events
           SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?${statusClause}
           WHERE id = ?${unresolvedAmountGuard(options)}${selectedAmountGuard(options)}`,
  );
  const binds: Array<string | number | null> = [input.attemptedAt, input.errorClass, input.lastProvider];
  if (input.amountStatus !== undefined) binds.push(input.amountStatus);
  binds.push(input.eventId);
  binds.push(...selectedAmountGuardBinds(options));
  return statement.bind(...binds);
}

/**
 * Null-only lanes retain their existing guard. Mixed eligibility lanes compare
 * the exact selected evidence generation so legacy-zero/provenance repair works
 * without overwriting a newer resolution, suppression, or operator annotation.
 */
export interface BlacklistAmountWriteGuardOptions {
  requireUnresolvedAmount?: boolean;
  selectedState?: BlacklistAmountSelectedState;
}

function unresolvedAmountGuard(options: BlacklistAmountWriteGuardOptions): string {
  return options.requireUnresolvedAmount
    ? "\n             AND amount_native IS NULL\n             AND suppression_reason IS NULL"
    : "";
}

function selectedAmountGuard(options: BlacklistAmountWriteGuardOptions): string {
  if (!options.selectedState) return "";
  return "\n             AND suppression_reason IS NULL"
    + SELECTED_AMOUNT_STATE_COLUMNS.map((column) => `\n             AND ${column} IS ?`).join("");
}

function selectedAmountGuardBinds(options: BlacklistAmountWriteGuardOptions): Array<string | number | null> {
  const state = options.selectedState;
  return state ? SELECTED_AMOUNT_STATE_COLUMNS.map((column) => state[column] ?? null) : [];
}

export interface RecoveredBlacklistAmountPersistence {
  statement: D1PreparedStatement;
  suppressed: boolean;
  targetStatus: "resolved" | "provider_failed" | "permanently_unavailable";
}

/**
 * Canonical successful-recovery persistence policy shared by scheduled and
 * operator repair lanes. In particular, Circle EURC mirror zeroes are retained
 * for audit provenance but cannot re-enter the public resolved dataset.
 */
export function buildRecoveredBlacklistAmountPersistence(
  db: D1Database,
  input: RecoveredBlacklistAmountPersistenceInput,
  options: BlacklistAmountWriteGuardOptions = {},
): RecoveredBlacklistAmountPersistence {
  const suppressed = shouldSuppressAsMirrorZero(
    input.config.stablecoin,
    input.eventType,
    input.amount,
  );
  const targetStatus = suppressed ? "permanently_unavailable" : input.amountStatus;
  const statement = db
    .prepare(
      `UPDATE blacklist_events
       SET amount_native = ?,
           amount_usd_at_event = ?,
           amount_source = ?,
           amount_status = CASE WHEN amount_status = 'permanently_unavailable' THEN amount_status ELSE ? END,
           suppression_reason = COALESCE(suppression_reason, ?),
           contract_address = COALESCE(contract_address, ?),
           config_key = COALESCE(config_key, ?),
           amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
           amount_last_attempted_at = ?,
           amount_last_error_class = ?,
           amount_last_provider = ?,
           provenance_source = COALESCE(?, provenance_source),
           provenance_observed_at = COALESCE(?, provenance_observed_at)
       WHERE id = ?${unresolvedAmountGuard(options)}${selectedAmountGuard(options)}`,
    )
    .bind(
      input.amount,
      input.amountUsd,
      input.amountSource,
      targetStatus,
      suppressed ? "circle_mirror_zero_balance" : null,
      input.config.contractAddress,
      input.config.configKey,
      input.attemptedAt,
      input.lastErrorClass,
      input.lastProvider,
      input.provenanceSource ?? null,
      input.provenanceObservedAt ?? null,
      input.eventId,
      ...selectedAmountGuardBinds(options),
    );
  return { statement, suppressed, targetStatus };
}
