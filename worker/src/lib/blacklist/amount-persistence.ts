import type { ContractEventConfig } from "../blacklist-contracts";
import { shouldSuppressAsMirrorZero } from "./shared";

export interface RecoveredBlacklistAmountPersistenceInput {
  eventId: string;
  eventType: string;
  config: ContractEventConfig;
  amount: number;
  amountUsd: number | null;
  amountSource: "event" | "historical_balance" | "unavailable";
  amountStatus: "resolved" | "provider_failed";
  attemptedAt: number;
  lastErrorClass: string | null;
  lastProvider: string;
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
       SET amount = ?,
           amount_native = ?,
           amount_usd_at_event = ?,
           amount_source = ?,
           amount_status = CASE WHEN amount_status = 'permanently_unavailable' THEN amount_status ELSE ? END,
           suppression_reason = COALESCE(suppression_reason, ?),
           contract_address = COALESCE(contract_address, ?),
           config_key = COALESCE(config_key, ?),
           amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
           amount_last_attempted_at = ?,
           amount_last_error_class = ?,
           amount_last_provider = ?
       WHERE id = ?`,
    )
    .bind(
      input.amount,
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
      input.eventId,
    );
  return { statement, suppressed, targetStatus };
}
