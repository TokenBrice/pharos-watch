import { randomUUID } from "node:crypto";
import {
  BLACKLIST_CURRENT_BALANCE_COLUMNS,
  BLACKLIST_CURRENT_BALANCE_UPSERT_POLICY,
  buildBlacklistCurrentBalanceValues,
  type BlacklistCurrentBalanceRow,
} from "../../src/lib/blacklist-current-balances";
import { getBlacklistDerivedCacheKeys } from "../../src/lib/blacklist-cache-keys";
import { sqlString, type RemoteD1Client } from "./remote-d1";

export type CurrentBalanceMaintenanceRow = Omit<BlacklistCurrentBalanceRow, "id">;

/** Admit every observation before touching the retained, contract-scoped ledger. */
export function applyBlacklistCurrentBalanceMaintenance(
  d1: RemoteD1Client,
  rows: readonly CurrentBalanceMaintenanceRow[],
  prefix: string,
  beforePublish?: () => void,
): void {
  if (rows.length === 0) return;
  const ids = new Set<string>();
  const values = rows.map((row) => {
    if (!row.configKey && !row.contractAddress) {
      throw new Error("refusing identityless blacklist current-balance observation");
    }
    const boundValues = buildBlacklistCurrentBalanceValues(row);
    const id = String(boundValues[0]);
    if (ids.has(id)) throw new Error(`duplicate blacklist current-balance identity ${id}`);
    ids.add(id);
    return boundValues.map((value) => {
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error(`non-finite blacklist current-balance observation ${id}`);
        return String(value);
      }
      return sqlString(value);
    }).join(", ");
  });

  // SAFETY: the scratch identifier contains only a fixed prefix and UUID hex digits.
  // It is persistent across Wrangler file imports, unlike a connection-local TEMP table.
  const stage = `blacklist_balance_stage_${randomUUID().replaceAll("-", "")}`;
  try {
    d1.executeStatements([
      `CREATE TABLE ${stage} AS SELECT ${BLACKLIST_CURRENT_BALANCE_COLUMNS} FROM blacklist_current_balances WHERE 0;`,
      // SAFETY: stage is UUID-hex-only, columns are fixed, and values are finite numbers or sqlString literals.
      ...values.map((value) => `INSERT INTO ${stage} (${BLACKLIST_CURRENT_BALANCE_COLUMNS}) VALUES (${value});`),
    ], `${prefix}-admit`);
    // SAFETY: stage contains only the fixed prefix and UUID hex digits.
    const admitted = d1.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${stage}`)[0]?.count;
    if (admitted !== rows.length) throw new Error(`incomplete blacklist balance admission: ${admitted}/${rows.length}`);
    beforePublish?.();

    // One array entry is one file import even when the client's batch size is one.
    // D1 executes that file transactionally: invalidation and the scoped upsert
    // either both commit, or neither does. No retained rows are deleted.
    d1.executeStatements([
      // SAFETY: stage is UUID-hex-only; columns/policy are fixed and cache keys are sqlString literals.
      `DELETE FROM cache WHERE key IN (${getBlacklistDerivedCacheKeys().map(sqlString).join(", ")});
       INSERT INTO blacklist_current_balances (${BLACKLIST_CURRENT_BALANCE_COLUMNS})
       SELECT ${BLACKLIST_CURRENT_BALANCE_COLUMNS} FROM ${stage} WHERE 1
       ${BLACKLIST_CURRENT_BALANCE_UPSERT_POLICY};
       DROP TABLE ${stage};`,
    ], `${prefix}-publish`);
  } catch (error) {
    try {
      d1.executeStatements([`DROP TABLE IF EXISTS ${stage};`], `${prefix}-cleanup`);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `blacklist balance maintenance failed; scratch cleanup also failed (${stage})`);
    }
    throw error;
  }
}
