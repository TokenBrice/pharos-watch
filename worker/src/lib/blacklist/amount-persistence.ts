import type { BlacklistAmountStatus } from "@shared/types/market";
import type { ContractEventConfig } from "../blacklist-contracts";
import { shouldSuppressAsMirrorZero } from "./shared";

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
): D1PreparedStatement {
  const statusClause = input.amountStatus !== undefined ? `,\n               amount_status = ?` : "";
  const statement = db.prepare(
    `UPDATE blacklist_events
           SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?${statusClause}
           WHERE id = ?`,
  );
  const binds: Array<string | number | null> = [input.attemptedAt, input.errorClass, input.lastProvider];
  if (input.amountStatus !== undefined) binds.push(input.amountStatus);
  binds.push(input.eventId);
  return statement.bind(...binds);
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
       WHERE id = ?`,
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
    );
  return { statement, suppressed, targetStatus };
}
