import { batchExecute } from "../../lib/db";
import { throwIfAborted } from "../../lib/abort";
import type { BlacklistRow } from "../../lib/blacklist/shared";

export async function insertBlacklistRows(db: D1Database, rows: BlacklistRow[], signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  if (rows.length === 0) return 0;

  // `amount` is a legacy column kept in lockstep with amount_native for pre-v3.2 compat.
  const stmts = rows.map((row) =>
    db
      .prepare(
        `/* blacklist-persistence-insert-events */
         INSERT OR IGNORE INTO blacklist_events
         (id, stablecoin, chain_id, chain_name, event_type, address, amount, amount_native, amount_usd_at_event, amount_source, amount_status, tx_hash, block_number, timestamp, methodology_version, contract_address, config_key, event_signature, event_topic0, suppression_reason, amount_attempt_count, amount_last_attempted_at, amount_last_error_class, amount_last_provider, explorer_tx_url, explorer_address_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.stablecoin,
        row.chain_id,
        row.chain_name,
        row.event_type,
        row.address,
        row.amount_native,
        row.amount_native,
        row.amount_usd_at_event,
        row.amount_source,
        row.amount_status,
        row.tx_hash,
        row.block_number,
        row.timestamp,
        row.methodology_version,
        row.contract_address,
        row.config_key,
        row.event_signature,
        row.event_topic0,
        row.suppression_reason ?? null,
        row.amount_attempt_count,
        row.amount_last_attempted_at,
        row.amount_last_error_class,
        row.amount_last_provider,
        row.explorer_tx_url,
        row.explorer_address_url,
      ),
  );
  return batchExecute(db, stmts, { signal });
}
