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
         SELECT id, stablecoin, chain_id, address
         FROM blacklist_current_balances
         WHERE config_key IS NULL AND contract_address IS NULL
         ORDER BY observed_at ASC, id ASC
         LIMIT ?`,
      )
      .bind(BALANCE_BATCH_SIZE)
      .all<LegacyIdentity>(),
  ]);

  const eventStatements: D1PreparedStatement[] = [];
  const balanceStatements: D1PreparedStatement[] = [];
  let eventMigrated = 0;
  let balanceMigrated = 0;
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
    eventMigrated++;
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
           SELECT ?, stablecoin, chain_id, address, ?, ?, amount_native, amount_usd,
                  source, status, observed_at, last_successful_observed_at,
                  attempt_count, last_attempted_at, last_error_class,
                  consecutive_failures
           FROM blacklist_current_balances
           WHERE id = ? AND config_key IS NULL AND contract_address IS NULL
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
        .bind(scopedId, config.configKey, config.contractAddress, row.id),
      db
        .prepare(
          `/* blacklist-legacy-balance-identity-delete */
           DELETE FROM blacklist_current_balances
           WHERE id = ? AND config_key IS NULL AND contract_address IS NULL`,
        )
        .bind(row.id),
    );
    balanceMigrated++;
  }

  await batchExecute(db, eventStatements, { signal });
  // Fifty pairs fit exactly in one D1 batch, keeping each copy/delete migration
  // in the same transactional D1 batch without a global reset.
  await batchExecute(db, balanceStatements, { signal });
  return { eventMigrated, balanceMigrated, ambiguousSkipped };
}
