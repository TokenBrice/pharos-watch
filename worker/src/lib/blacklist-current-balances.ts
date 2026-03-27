import { buildBlacklistAddressCountKey } from "@shared/lib/blacklist";
import type { BlacklistStablecoin } from "@shared/types/market";
import type { D1Database } from "@cloudflare/workers-types";

export interface BlacklistCurrentBalanceRow {
  id: string;
  stablecoin: BlacklistStablecoin;
  chainId: string;
  address: string;
  amountNative: number | null;
  amountUsd: number | null;
  source: string;
  status: "resolved" | "provider_failed";
  observedAt: number;
  attemptCount: number;
  lastAttemptedAt: number | null;
  lastErrorClass: string | null;
}

function buildBlacklistCurrentBalanceId(
  stablecoin: BlacklistStablecoin,
  chainId: string,
  address: string,
): string {
  return buildBlacklistAddressCountKey(stablecoin, chainId, address);
}

export async function loadBlacklistCurrentBalanceMap(
  db: D1Database,
): Promise<Map<string, BlacklistCurrentBalanceRow>> {
  const result = await db
    .prepare(
      `SELECT id, stablecoin, chain_id, address, amount_native, amount_usd, source, status,
              observed_at, attempt_count, last_attempted_at, last_error_class
       FROM blacklist_current_balances`,
    )
    .all<{
      id: string;
      stablecoin: BlacklistStablecoin;
      chain_id: string;
      address: string;
      amount_native: number | null;
      amount_usd: number | null;
      source: string;
      status: "resolved" | "provider_failed";
      observed_at: number;
      attempt_count: number;
      last_attempted_at: number | null;
      last_error_class: string | null;
    }>();

  return new Map(
    (result.results ?? []).map((row) => [
      row.id,
      {
        id: row.id,
        stablecoin: row.stablecoin,
        chainId: row.chain_id,
        address: row.address,
        amountNative: row.amount_native,
        amountUsd: row.amount_usd,
        source: row.source,
        status: row.status,
        observedAt: row.observed_at,
        attemptCount: row.attempt_count,
        lastAttemptedAt: row.last_attempted_at,
        lastErrorClass: row.last_error_class,
      },
    ]),
  );
}

export async function upsertBlacklistCurrentBalance(
  db: D1Database,
  row: Omit<BlacklistCurrentBalanceRow, "id">,
): Promise<void> {
  const id = buildBlacklistCurrentBalanceId(row.stablecoin, row.chainId, row.address);
  await db
    .prepare(
      `INSERT INTO blacklist_current_balances
         (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at,
          attempt_count, last_attempted_at, last_error_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         amount_native = excluded.amount_native,
         amount_usd = excluded.amount_usd,
         source = excluded.source,
         status = excluded.status,
         observed_at = excluded.observed_at,
         attempt_count = excluded.attempt_count,
         last_attempted_at = excluded.last_attempted_at,
         last_error_class = excluded.last_error_class`,
    )
    .bind(
      id,
      row.stablecoin,
      row.chainId,
      row.address,
      row.amountNative,
      row.amountUsd,
      row.source,
      row.status,
      row.observedAt,
      row.attemptCount,
      row.lastAttemptedAt,
      row.lastErrorClass,
    )
    .run();
}

export async function deleteBlacklistCurrentBalance(
  db: D1Database,
  stablecoin: BlacklistStablecoin,
  chainId: string,
  address: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM blacklist_current_balances WHERE id = ?")
    .bind(buildBlacklistCurrentBalanceId(stablecoin, chainId, address))
    .run();
}
