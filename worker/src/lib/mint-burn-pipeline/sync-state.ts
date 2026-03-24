import { batchExecute, buildInClause } from "../db";
import type { MintBurnContractConfig } from "../mint-burn-contracts";
import type { MintBurnSyncStateMode } from "./types";

// D1 allows at most 100 bound parameters per statement, so keep config-key
// reads below that ceiling with a small safety margin.
const READ_SYNC_STATE_BATCH_SIZE = 90;

export function mintBurnConfigKey(config: MintBurnContractConfig): string {
  return `${config.chain.chainId}-${config.contractAddress}`;
}

export async function ensureMintBurnSyncStateRows(
  db: D1Database,
  configs: MintBurnContractConfig[],
): Promise<void> {
  if (configs.length === 0) return;
  const initStateStmts = configs.map((config) =>
    db
      .prepare("INSERT OR IGNORE INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)")
      .bind(mintBurnConfigKey(config), config.startBlock - 1),
  );
  await batchExecute(db, initStateStmts);
}

export async function readMintBurnSyncState(
  db: D1Database,
  configKey: string,
): Promise<number | null> {
  const row = await db
    .prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?")
    .bind(configKey)
    .first<{ last_block: number }>();
  return row?.last_block ?? null;
}

export async function readMintBurnSyncStateBatch(
  db: D1Database,
  configs: MintBurnContractConfig[],
): Promise<Map<string, number>> {
  const lastBlocks = new Map<string, number>();
  if (configs.length === 0) return lastBlocks;

  const configKeys = [...new Set(configs.map((config) => mintBurnConfigKey(config)))];
  const fetchedLastBlocks = new Map<string, number>();

  for (let i = 0; i < configKeys.length; i += READ_SYNC_STATE_BATCH_SIZE) {
    const keyChunk = configKeys.slice(i, i + READ_SYNC_STATE_BATCH_SIZE);
    const inClause = buildInClause(keyChunk);
    const rows = await db
      .prepare(
        `SELECT config_key, last_block
         FROM mint_burn_sync_state
         WHERE config_key IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<{ config_key: string; last_block: number }>();

    for (const row of rows.results ?? []) {
      fetchedLastBlocks.set(row.config_key, row.last_block);
    }
  }

  for (const config of configs) {
    const key = mintBurnConfigKey(config);
    lastBlocks.set(key, fetchedLastBlocks.get(key) ?? (config.startBlock - 1));
  }

  return lastBlocks;
}

export async function upsertMintBurnSyncState(
  db: D1Database,
  configKey: string,
  lastBlock: number,
  mode: MintBurnSyncStateMode,
): Promise<void> {
  if (mode === "monotonic-max") {
    await db
      .prepare(
        `INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)
         ON CONFLICT(config_key) DO UPDATE SET
           last_block = CASE
             WHEN mint_burn_sync_state.last_block > excluded.last_block THEN mint_burn_sync_state.last_block
             ELSE excluded.last_block
           END`,
      )
      .bind(configKey, lastBlock)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)
       ON CONFLICT(config_key) DO UPDATE SET last_block = excluded.last_block`,
    )
    .bind(configKey, lastBlock)
    .run();
}
