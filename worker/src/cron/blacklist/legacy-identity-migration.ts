import { logWorkerEventArgs } from "../../lib/structured-log";
import { buildBlacklistContractBalanceKey } from "@shared/lib/blacklist";
import type { BlacklistStablecoin } from "@shared/types/market";
import { CONTRACT_CONFIGS, type ContractEventConfig } from "../../lib/blacklist-contracts";
import { batchExecute } from "../../lib/db";

const EVENT_BATCH_SIZE = 100;
const BALANCE_BATCH_SIZE = 50;

type LegacyIdentity = {
  id: string;
  stablecoin: BlacklistStablecoin;
  chain_id: string;
  address: string;
};

/**
 * The balance copy re-keys a row, so it reads the carried columns up front and
 * re-inserts them by value. An `INSERT … SELECT` that reads the same table it
 * writes leaves `blacklist_current_balances.<column>` ambiguous between the
 * upsert target and the source row, and makes the copy depend on the legacy row
 * still matching mid-batch.
 */
type LegacyBalanceRow = LegacyIdentity & {
  amount_native: string | null;
  amount_usd: number | null;
  source: string;
  status: string;
  observed_at: number;
  last_successful_observed_at: number | null;
  attempt_count: number;
  last_attempted_at: number | null;
  last_error_class: string | null;
  consecutive_failures: number;
};

export type BlacklistLegacyIdentityMigrationResult = {
  eventMigrated: number;
  balanceMigrated: number;
  ambiguousSkipped: number;
};

function buildUniqueConfigByScope(): Map<string, ContractEventConfig | null> {
  const byScope = new Map<string, ContractEventConfig | null>();
  for (const config of CONTRACT_CONFIGS) {
    const key = `${config.stablecoin}:${config.chain.chainId}`;
    byScope.set(key, byScope.has(key) ? null : config);
  }
  return byScope;
}

function resolveConfig(
  row: LegacyIdentity,
  byScope: ReadonlyMap<string, ContractEventConfig | null>,
): ContractEventConfig | null {
  return byScope.get(`${row.stablecoin}:${row.chain_id}`) ?? null;
}

export async function migrateLegacyBlacklistIdentities(
  db: D1Database,
  signal?: AbortSignal,
): Promise<BlacklistLegacyIdentityMigrationResult> {
  const byScope = buildUniqueConfigByScope();
  const [events, balances] = await Promise.all([
    db
      .prepare(
        `/* blacklist-legacy-event-identities */
         SELECT id, stablecoin, chain_id, address
         FROM blacklist_events
         WHERE config_key IS NULL AND contract_address IS NULL
         ORDER BY timestamp ASC, id ASC
         LIMIT ?`,
      )
      .bind(EVENT_BATCH_SIZE)
      .all<LegacyIdentity>(),
    db
      .prepare(
        `/* blacklist-legacy-balance-identities */
         SELECT id, stablecoin, chain_id, address, amount_native, amount_usd,
                source, status, observed_at, last_successful_observed_at,
                attempt_count, last_attempted_at, last_error_class,
                consecutive_failures
         FROM blacklist_current_balances
         WHERE config_key IS NULL AND contract_address IS NULL
         ORDER BY observed_at ASC, id ASC
         LIMIT ?`,
      )
      .bind(BALANCE_BATCH_SIZE)
      .all<LegacyBalanceRow>(),
  ]);

  const eventStatements: D1PreparedStatement[] = [];
  const balanceStatements: D1PreparedStatement[] = [];
  let balancePlanned = 0;
  let ambiguousSkipped = 0;

  for (const row of events.results ?? []) {
    const config = resolveConfig(row, byScope);
    if (!config) {
      ambiguousSkipped++;
      continue;
    }
    eventStatements.push(
      db
        .prepare(
          `/* blacklist-legacy-event-identity-migrate */
           UPDATE blacklist_events
           SET config_key = ?, contract_address = ?
           WHERE id = ? AND config_key IS NULL AND contract_address IS NULL`,
        )
        .bind(config.configKey, config.contractAddress, row.id),
    );
  }

  for (const row of balances.results ?? []) {
    const config = resolveConfig(row, byScope);
    if (!config) {
      ambiguousSkipped++;
      continue;
    }
    const scopedId = buildBlacklistContractBalanceKey(
      row.stablecoin,
      row.chain_id,
      row.address,
      config.configKey,
      config.contractAddress,
    );
    balanceStatements.push(
      db
        .prepare(
          `/* blacklist-legacy-balance-identity-copy */
           INSERT INTO blacklist_current_balances
             (id, stablecoin, chain_id, address, config_key, contract_address,
              amount_native, amount_usd, source, status, observed_at,
              last_successful_observed_at, attempt_count, last_attempted_at,
              last_error_class, consecutive_failures)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             config_key = excluded.config_key,
             contract_address = excluded.contract_address,
             amount_native = CASE
               WHEN excluded.observed_at >= blacklist_current_balances.observed_at
                 THEN excluded.amount_native
               ELSE blacklist_current_balances.amount_native
             END,
             amount_usd = CASE
               WHEN excluded.observed_at >= blacklist_current_balances.observed_at
                 THEN excluded.amount_usd
               ELSE blacklist_current_balances.amount_usd
             END,
             source = CASE
               WHEN excluded.observed_at >= blacklist_current_balances.observed_at
                 THEN excluded.source
               ELSE blacklist_current_balances.source
             END,
             status = CASE
               WHEN excluded.observed_at >= blacklist_current_balances.observed_at
                 THEN excluded.status
               ELSE blacklist_current_balances.status
             END,
             observed_at = MAX(excluded.observed_at, blacklist_current_balances.observed_at),
             last_successful_observed_at = MAX(
               COALESCE(excluded.last_successful_observed_at, 0),
               COALESCE(blacklist_current_balances.last_successful_observed_at, 0)
             ),
             attempt_count = MAX(excluded.attempt_count, blacklist_current_balances.attempt_count),
             last_attempted_at = MAX(
               COALESCE(excluded.last_attempted_at, 0),
               COALESCE(blacklist_current_balances.last_attempted_at, 0)
             ),
             last_error_class = CASE
               WHEN excluded.observed_at >= blacklist_current_balances.observed_at
                 THEN excluded.last_error_class
               ELSE blacklist_current_balances.last_error_class
             END,
             consecutive_failures = CASE
               WHEN excluded.observed_at >= blacklist_current_balances.observed_at
                 THEN excluded.consecutive_failures
               ELSE blacklist_current_balances.consecutive_failures
             END`,
        )
        .bind(
          scopedId,
          row.stablecoin,
          row.chain_id,
          row.address,
          config.configKey,
          config.contractAddress,
          row.amount_native,
          row.amount_usd,
          row.source,
          row.status,
          row.observed_at,
          row.last_successful_observed_at,
          row.attempt_count,
          row.last_attempted_at,
          row.last_error_class,
          row.consecutive_failures,
        ),
      db
        .prepare(
          `/* blacklist-legacy-balance-identity-delete */
           DELETE FROM blacklist_current_balances
           WHERE id = ? AND config_key IS NULL AND contract_address IS NULL`,
        )
        .bind(row.id),
    );
    balancePlanned++;
  }

  const eventMigrated = await batchExecute(db, eventStatements, { signal });
  // Fifty pairs fit exactly in one D1 batch, keeping each copy/delete migration
  // in the same transactional D1 batch without a global reset.
  const balanceChanges = await batchExecute(db, balanceStatements, { signal });
  // Every applied migration contributes exactly two row changes (the re-keyed
  // insert and the legacy delete), so a batch that does not commit reports 0
  // instead of the planned count. Reporting the planned count unconditionally
  // is what let a balance backfill sit at 6,122 rows while every run claimed 50.
  const balanceMigrated = Math.floor(balanceChanges / 2);
  if (balanceMigrated < balancePlanned) {
    logWorkerEventArgs("handler", "warn",
      JSON.stringify({
        scope: "sync-blacklist",
        message: "Legacy balance identity migration applied fewer rows than planned",
        planned: balancePlanned,
        applied: balanceMigrated,
      }),
    );
  }
  return { eventMigrated, balanceMigrated, ambiguousSkipped };
}
