import { blacklistEventIdentity, blacklistEventIdentitySql } from "@shared/lib/blacklist-event-order";
import { canonicalBlacklistAddress } from "@shared/lib/tron-address";
import type { BlacklistStablecoin } from "@shared/types/market";
import { reconcileBlacklistTronBalance } from "../blacklist-current-balances";
import { batchExecute } from "../db";
import { throwIfAborted } from "../abort";

const PAGE_SIZE = 100;
const CURSOR_PREFIX = "blacklist:identity-reconcile:v1:";
const RECONCILIATION_TABLES = new Set(["blacklist_events", "blacklist_current_balances"] as const);

/** Bounded, resumable audit-preserving cutover; public reads already fold canonical identities. */
export async function reconcileBlacklistIdentities(db: D1Database, signal?: AbortSignal): Promise<void> {
  for (const table of RECONCILIATION_TABLES) {
    throwIfAborted(signal);
    const key = `${CURSOR_PREFIX}${table}`;
    const cursor = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>();
    if (!RECONCILIATION_TABLES.has(table)) {
      throw new Error(`Unsupported blacklist reconciliation table: ${table}`);
    }
    const rows = await db.prepare(table === "blacklist_events"
      ? `SELECT id, stablecoin, chain_id, address, config_key, contract_address, tx_hash
         FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`
      : `SELECT id, stablecoin, chain_id, address, config_key, contract_address
         FROM ${table} WHERE chain_id = 'tron' AND id > ? ORDER BY id LIMIT ?`)
      .bind(cursor?.value ?? "", PAGE_SIZE).all<{
        id: string; stablecoin: BlacklistStablecoin; chain_id: string; address: string;
        config_key: string | null; contract_address: string | null; tx_hash?: string;
      }>();
    const page = rows.results ?? [];
    if (table === "blacklist_events") {
      const duplicateSql = `EXISTS (
        SELECT 1 FROM blacklist_events AS peer WHERE (${blacklistEventIdentitySql("peer")}) = ?
        AND peer.suppression_reason IS NULL AND peer.id < ?
      )`;
      await batchExecute(db, page.map((row) => {
        const address = canonicalBlacklistAddress(row.chain_id, row.address);
        const identity = blacklistEventIdentity(row);
        return db.prepare(`UPDATE blacklist_events SET address = ?,
          suppression_reason = CASE WHEN ${duplicateSql}
            THEN COALESCE(suppression_reason, 'duplicate_log_identity') ELSE suppression_reason END
          WHERE id = ? AND (address IS NOT ? OR (suppression_reason IS NULL AND ${duplicateSql}))`)
          .bind(address, identity, row.id, row.id, address, identity, row.id);
      }), { signal });
    } else {
      for (const row of page) {
        throwIfAborted(signal);
        await reconcileBlacklistTronBalance(db, {
          id: row.id, stablecoin: row.stablecoin, chainId: row.chain_id, address: row.address,
          configKey: row.config_key, contractAddress: row.contract_address,
        });
      }
    }
    await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, page.length === PAGE_SIZE ? page[page.length - 1]!.id : "", Math.floor(Date.now() / 1000)).run();
  }
}
