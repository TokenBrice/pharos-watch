import {
  buildAlchemyUrl,
  getAlchemyBlockNumber,
  fetchAlchemyLogs,
  resolveBlockTimestamps,
} from "../lib/alchemy-logs";
import type { AlchemyLogEntry } from "../lib/alchemy-logs";
import { createBudget, budgetExhausted } from "../lib/evm-logs";
import { batchExecute } from "../lib/db";
import {
  MINT_BURN_CONFIGS,
  type MintBurnContractConfig,
  type MintBurnEventDef,
} from "../lib/mint-burn-contracts";
import { parseMintBurnLogs } from "../cron/sync-mint-burn";
import { requireAdmin } from "../lib/auth";
import { withErrorHandler, errorResponse, jsonResponse, parseIntParam } from "../lib/api-utils";
import type { TopicFilter } from "../lib/evm-logs";

const CHAIN_DEFAULT_CHUNK_SIZE: Record<number, number> = {
  1: 50_000,
  42161: 50_000,
  8453: 50_000,
  10: 50_000,
  43114: 10_000,
  137: 2_000,
};

const BACKFILL_BUDGET_LIMIT = 900;
const DEFAULT_MAX_CHUNKS = 24;

function configKey(config: MintBurnContractConfig): string {
  return `${config.chain.chainId}-${config.contractAddress}`;
}

function maxChunkSizeForChain(evmChainId: number): number {
  return CHAIN_DEFAULT_CHUNK_SIZE[evmChainId] ?? 10_000;
}

async function readBodyJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request || request.method !== "POST") return {};
  try {
    return (await request.clone().json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function loadPriceContext(
  db: D1Database,
  stablecoinId: string,
): Promise<{
  prices: Map<string, number>;
  priceHistory: Map<string, { snapshotDate: number; price: number }[]>;
}> {
  const prices = new Map<string, number>();
  const priceHistory = new Map<string, { snapshotDate: number; price: number }[]>();

  const current = await db
    .prepare("SELECT asset_id, price FROM price_cache WHERE asset_id = ?")
    .bind(stablecoinId)
    .first<{ asset_id: string; price: number }>();
  if (current) {
    prices.set(current.asset_id, current.price);
  }

  const history = await db
    .prepare(
      `SELECT stablecoin_id, snapshot_date, price
       FROM supply_history
       WHERE stablecoin_id = ? AND price IS NOT NULL
       ORDER BY snapshot_date ASC`,
    )
    .bind(stablecoinId)
    .all<{ stablecoin_id: string; snapshot_date: number; price: number }>();

  const series: { snapshotDate: number; price: number }[] = [];
  for (const row of history.results ?? []) {
    series.push({ snapshotDate: row.snapshot_date, price: row.price });
  }
  priceHistory.set(stablecoinId, series);

  return { prices, priceHistory };
}

async function recalcAffectedHours(
  db: D1Database,
  affectedHours: Map<string, { stablecoinId: string; chainId: string; hourTs: number }>,
): Promise<void> {
  if (affectedHours.size === 0) return;

  const aggStmt = db.prepare(
    `INSERT OR REPLACE INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
       mint_volume_usd, burn_volume_usd, net_flow_usd)
     SELECT
      stablecoin_id,
      chain_id,
      (timestamp / 3600) * 3600 AS hour_ts,
      SUM(CASE WHEN direction = 'mint' THEN 1 ELSE 0 END),
      SUM(CASE WHEN direction = 'burn' THEN 1 ELSE 0 END),
      COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'burn' THEN amount_usd ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE -amount_usd END), 0)
     FROM mint_burn_events
     WHERE stablecoin_id = ? AND chain_id = ?
       AND timestamp >= ? AND timestamp < ?
     GROUP BY stablecoin_id, chain_id, hour_ts`,
  );

  const stmts = [...affectedHours.values()].map((hour) =>
    aggStmt.bind(hour.stablecoinId, hour.chainId, hour.hourTs, hour.hourTs + 3600),
  );

  await batchExecute(db, stmts);
}

export const handleBackfillMintBurn = withErrorHandler(
  "backfill-mint-burn",
  async (
    db: D1Database,
    url: URL,
    adminKey: string | undefined,
    request: Request | undefined,
    alchemyApiKey: string | null,
  ): Promise<Response> => {
    const authErr = await requireAdmin(request, adminKey);
    if (authErr) return authErr;

    if (!alchemyApiKey) {
      return errorResponse(500, "ALCHEMY_API_KEY is not configured");
    }

    const body = await readBodyJson(request);
    const configKeyParamRaw =
      (typeof body.configKey === "string" ? body.configKey : null) ??
      url.searchParams.get("configKey");
    const configKeyParam = configKeyParamRaw?.trim().toLowerCase();

    if (!configKeyParam) {
      return errorResponse(400, "configKey is required");
    }

    const config = MINT_BURN_CONFIGS.find(
      (entry) => configKey(entry).toLowerCase() === configKeyParam,
    );

    if (!config) {
      return errorResponse(404, "Unknown mint/burn configKey");
    }

    if (config.chain.evmChainId == null) {
      return errorResponse(400, "Selected config is not EVM-compatible");
    }

    const evmChainId = config.chain.evmChainId;
    const chunkMax = maxChunkSizeForChain(evmChainId);
    const defaultChunkSize = chunkMax;

    const fromBlockParam =
      (typeof body.fromBlock === "number" ? Math.trunc(body.fromBlock) : null) ??
      parseIntParam(url.searchParams.get("fromBlock"), -1, -1, Number.MAX_SAFE_INTEGER);
    const toBlockParam =
      (typeof body.toBlock === "number" ? Math.trunc(body.toBlock) : null) ??
      parseIntParam(url.searchParams.get("toBlock"), -1, -1, Number.MAX_SAFE_INTEGER);
    const chunkSizeParam =
      (typeof body.chunkSize === "number" ? Math.trunc(body.chunkSize) : null) ??
      parseIntParam(url.searchParams.get("chunkSize"), defaultChunkSize, 1, chunkMax);
    const maxChunks =
      (typeof body.maxChunks === "number" ? Math.trunc(body.maxChunks) : null) ??
      parseIntParam(url.searchParams.get("maxChunks"), DEFAULT_MAX_CHUNKS, 1, 500);

    const currentState = await db
      .prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?")
      .bind(configKey(config))
      .first<{ last_block: number }>();

    const fromBlock = fromBlockParam >= 0
      ? fromBlockParam
      : (currentState?.last_block ?? (config.startBlock - 1)) + 1;

    const alchemyUrl = buildAlchemyUrl(config.chain.chainId, alchemyApiKey);
    if (!alchemyUrl) {
      return errorResponse(400, `Alchemy URL is not configured for chain ${config.chain.chainId}`);
    }

    const budget = createBudget(BACKFILL_BUDGET_LIMIT);
    const chainHead = await getAlchemyBlockNumber(alchemyUrl, budget);
    if (chainHead == null) {
      return errorResponse(502, "Failed to fetch chain head for backfill range");
    }

    const toBlock = toBlockParam >= 0 ? Math.min(toBlockParam, chainHead) : chainHead;
    if (toBlock < fromBlock) {
      return jsonResponse({
        configKey: configKey(config),
        fromBlock,
        toBlock,
        done: true,
        rowsParsed: 0,
        rowsInserted: 0,
        rowsIgnored: 0,
        rowsDropped: 0,
        chunksProcessed: 0,
        budgetUsed: budget.count,
      });
    }

    const chunkSize = Math.max(1, Math.min(chunkSizeParam, chunkMax));

    const { prices, priceHistory } = await loadPriceContext(db, config.stablecoinId);
    const runTimestamp = Math.floor(Date.now() / 1000);
    const localTimestampCache = new Map<number, number>();

    let cursor = fromBlock;
    let chunksProcessed = 0;
    let rowsParsed = 0;
    let rowsInserted = 0;
    let rowsIgnored = 0;
    let rowsDropped = 0;

    while (cursor <= toBlock && chunksProcessed < maxChunks && !budgetExhausted(budget)) {
      const scanTo = Math.min(cursor + chunkSize - 1, toBlock);

      const collectedLogs: Array<{ eventDef: MintBurnEventDef; logs: AlchemyLogEntry[] }> = [];
      const failedEventDefs: string[] = [];

      for (const eventDef of config.events) {
        if (budgetExhausted(budget)) {
          failedEventDefs.push(`${eventDef.signature}:${eventDef.direction}:budget`);
          continue;
        }

        const topics: TopicFilter[] = [{ index: 0, value: eventDef.topicHash }];
        if (eventDef.filterTopic) {
          topics.push({ index: eventDef.filterTopic.index, value: eventDef.filterTopic.value });
        }

        const fetched = await fetchAlchemyLogs(
          alchemyUrl,
          config.contractAddress,
          topics,
          cursor,
          scanTo,
          budget,
        );

        if (!fetched || !fetched.complete) {
          failedEventDefs.push(`${eventDef.signature}:${eventDef.direction}:fetch-failed`);
          continue;
        }

        if (fetched.logs.length > 0) {
          collectedLogs.push({ eventDef, logs: fetched.logs });
        }
      }

      if (failedEventDefs.length > 0) {
        return errorResponse(
          502,
          `Backfill failed for ${configKey(config)} at ${cursor}-${scanTo}: ${failedEventDefs.join(", ")}`,
        );
      }

      const uniqueBlocks = [
        ...new Set(collectedLogs.flatMap(({ logs }) => logs.map((log) => parseInt(log.blockNumber, 16)))),
      ];

      const blockTimestamps = uniqueBlocks.length > 0
        ? await resolveBlockTimestamps(alchemyUrl, uniqueBlocks, budget, {
            localCache: localTimestampCache,
            persistentCache: { db, chainId: config.chain.chainId },
          })
        : new Map<number, number>();

      if (uniqueBlocks.length > 0 && blockTimestamps.size < uniqueBlocks.length) {
        return errorResponse(
          502,
          `Backfill failed for ${configKey(config)} at ${cursor}-${scanTo}: missing block timestamps`,
        );
      }

      const affectedHours = new Map<string, { stablecoinId: string; chainId: string; hourTs: number }>();

      for (const { eventDef, logs } of collectedLogs) {
        const parsed = parseMintBurnLogs(
          config,
          eventDef,
          logs,
          blockTimestamps,
          prices,
          priceHistory,
          runTimestamp,
        );

        rowsDropped += parsed.dropped;
        rowsParsed += parsed.rows.length;

        for (const row of parsed.rows) {
          const hourTs = Math.floor(row.timestamp / 3600) * 3600;
          const key = `${row.stablecoin_id}-${row.chain_id}-${hourTs}`;
          affectedHours.set(key, {
            stablecoinId: row.stablecoin_id,
            chainId: row.chain_id,
            hourTs,
          });
        }

        if (parsed.rows.length > 0) {
          const insertStmts = parsed.rows.map((row) =>
            db.prepare(
              `INSERT OR IGNORE INTO mint_burn_events
               (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, price_used, price_timestamp, price_source,
                counterparty, tx_hash, block_number, timestamp, explorer_tx_url)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              row.id,
              row.stablecoin_id,
              row.symbol,
              row.chain_id,
              row.direction,
              row.amount,
              row.amount_usd,
              row.price_used,
              row.price_timestamp,
              row.price_source,
              row.counterparty,
              row.tx_hash,
              row.block_number,
              row.timestamp,
              row.explorer_tx_url,
            ),
          );

          const inserted = await batchExecute(db, insertStmts);
          rowsInserted += inserted;
          rowsIgnored += Math.max(0, parsed.rows.length - inserted);
        }
      }

      await recalcAffectedHours(db, affectedHours);

      await db
        .prepare(
          `INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)
           ON CONFLICT(config_key) DO UPDATE SET
             last_block = CASE
               WHEN mint_burn_sync_state.last_block > excluded.last_block THEN mint_burn_sync_state.last_block
               ELSE excluded.last_block
             END`,
        )
        .bind(configKey(config), scanTo)
        .run();

      cursor = scanTo + 1;
      chunksProcessed++;
    }

    return jsonResponse({
      configKey: configKey(config),
      fromBlock,
      toBlock,
      chunkSize,
      maxChunks,
      chunksProcessed,
      done: cursor > toBlock,
      nextFromBlock: cursor <= toBlock ? cursor : null,
      rowsParsed,
      rowsInserted,
      rowsIgnored,
      rowsDropped,
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
    });
  },
);
