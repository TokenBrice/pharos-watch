import type { DatabaseSync } from "node:sqlite";
import { buildBlacklistContractBalanceKey } from "@shared/lib/blacklist";
import { getBlacklistConfigsForSymbolAndChain } from "../../src/lib/blacklist-contracts";
import {
  BLACKLIST_CURRENT_BALANCE_COLUMNS,
  buildBlacklistCurrentBalanceValues,
} from "../../src/lib/blacklist-current-balances";
import { getBlacklistDerivedCacheKeys } from "../../src/lib/blacklist-cache-keys";
import type { CurrentBalanceMaintenanceRow } from "../lib/blacklist-current-balance-maintenance";
import type { RemoteD1Client } from "../lib/remote-d1";

export function observation(overrides: Partial<CurrentBalanceMaintenanceRow> = {}): CurrentBalanceMaintenanceRow {
  const stablecoin = overrides.stablecoin ?? "USDT";
  const chainId = overrides.chainId ?? "ethereum";
  const config = getBlacklistConfigsForSymbolAndChain(stablecoin, chainId)[0]!;
  return {
    stablecoin,
    chainId,
    address: `0x${"1".padStart(40, "0")}`,
    configKey: config.configKey,
    contractAddress: config.contractAddress,
    amountNative: 100,
    amountUsd: 100,
    source: "current_balance",
    status: "resolved",
    observedAt: 100,
    lastSuccessfulObservedAt: 100,
    attemptCount: 3,
    lastAttemptedAt: 100,
    lastErrorClass: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

export function balanceId(row: CurrentBalanceMaintenanceRow): string {
  return buildBlacklistContractBalanceKey(row.stablecoin, row.chainId, row.address, row.configKey, row.contractAddress);
}

export function seedLedger(sqlite: DatabaseSync): CurrentBalanceMaintenanceRow[] {
  const rows = [
    observation(),
    observation({ address: "0xreleased", amountNative: 20, amountUsd: 20 }),
    observation({ address: "0xdestroyed", amountNative: 30, amountUsd: 30, source: "destroy_event" }),
    observation({ configKey: "other-contract", contractAddress: "0xother", amountNative: 40, amountUsd: 40 }),
    observation({ chainId: "tron", address: "0xtron-retained", amountNative: 50, amountUsd: 50 }),
    observation({ stablecoin: "USDC", address: "0xusdc-retained", amountNative: 60, amountUsd: 60 }),
  ];
  const insert = sqlite.prepare(`INSERT INTO blacklist_current_balances (${BLACKLIST_CURRENT_BALANCE_COLUMNS})
    VALUES (${Array.from({ length: 16 }, () => "?").join(", ")})`);
  for (const row of rows) insert.run(...buildBlacklistCurrentBalanceValues(row));
  const insertEvent = sqlite.prepare(`INSERT INTO blacklist_events
    (id, stablecoin, chain_id, chain_name, event_type, address, config_key, contract_address,
     tx_hash, block_number, timestamp, explorer_tx_url, explorer_address_url)
    VALUES (?, 'USDT', 'ethereum', 'Ethereum', ?, ?, ?, ?, ?, ?, ?, '', '')`);
  for (const [index, row] of rows.slice(0, 4).entries()) {
    insertEvent.run(`freeze-${index}`, "blacklist", row.address, row.configKey, row.contractAddress, `tx-${index}`, index + 1, 50);
    if (index === 1 || index === 2) {
      insertEvent.run(`close-${index}`, index === 1 ? "unblacklist" : "destroy", row.address, row.configKey, row.contractAddress, `close-tx-${index}`, index + 10, 75);
    }
  }
  return rows;
}

export function seedDerivedCaches(sqlite: DatabaseSync): void {
  const insert = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, '{}', 1)");
  for (const key of getBlacklistDerivedCacheKeys()) insert.run(key);
  insert.run("unrelated-cache");
}

/** Emulate Wrangler's independently transactional 200-statement file imports. */
export function sqliteRemoteD1(
  sqlite: DatabaseSync,
  options: { failChunk?: number; failPublish?: boolean; batchSize?: number } = {},
): { d1: RemoteD1Client; imports: string[][] } {
  const imports: string[][] = [];
  const d1: RemoteD1Client = {
    query: <T>(sql: string) => sqlite.prepare(sql).all() as T[],
    queryRaw: (sql) => JSON.stringify(sqlite.prepare(sql).all()),
    executeStatements: (statements, prefix) => {
      const batchSize = options.batchSize ?? 200;
      for (let offset = 0; offset < statements.length; offset += batchSize) {
        const chunk = statements.slice(offset, offset + batchSize);
        imports.push(chunk);
        sqlite.exec("BEGIN");
        try {
          sqlite.exec(chunk.join("\n"));
          if (imports.length === options.failChunk || (options.failPublish && prefix.endsWith("-publish"))) {
            throw new Error("simulated import failure");
          }
          sqlite.exec("COMMIT");
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      }
    },
  };
  return { d1, imports };
}

export function ledgerRows(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT * FROM blacklist_current_balances ORDER BY id").all();
}

export function derivedCacheRows(sqlite: DatabaseSync) {
  return sqlite.prepare(`SELECT * FROM cache WHERE key IN (${getBlacklistDerivedCacheKeys().map(() => "?").join(", ")})`)
    .all(...getBlacklistDerivedCacheKeys());
}
