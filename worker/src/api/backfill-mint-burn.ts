import {
  buildAlchemyUrl,
  getAlchemyBlockNumber,
  fetchAlchemyLogs,
  resolveBlockTimestamps,
} from "../lib/alchemy-logs";
import type { AlchemyLogEntry } from "../lib/alchemy-logs";
import { createBudget, budgetExhausted } from "../lib/evm-logs";
import {
  MINT_BURN_CONFIGS,
  type MintBurnContractConfig,
  type MintBurnEventDef,
} from "../lib/mint-burn-contracts";
import type { MintBurnTxContext } from "../lib/mint-burn-bridge-classifier";
import { requireAdmin } from "../lib/auth";
import { withErrorHandler, errorResponse, jsonResponse, parseIntParam } from "../lib/api-utils";
import type { TopicFilter } from "../lib/evm-logs";
import { classifyBridgeBurnRows } from "../lib/mint-burn-pipeline/classification";
import { loadMintBurnPriceContext } from "../lib/mint-burn-pipeline/context";
import { parseMintBurnLogs } from "../lib/mint-burn-pipeline/parse";
import {
  collectAffectedHours,
  insertMintBurnRows,
  recalcAffectedHours,
  updateBurnClassifications,
} from "../lib/mint-burn-pipeline/persistence";
import {
  mintBurnConfigKey,
  readMintBurnSyncState,
  upsertMintBurnSyncState,
} from "../lib/mint-burn-pipeline/sync-state";
import type { MintBurnAffectedHour } from "../lib/mint-burn-pipeline/types";

const ETHEREUM_CHAIN_ID = "ethereum";
const ETHEREUM_CHUNK_SIZE = 50_000;

const BACKFILL_BUDGET_LIMIT = 900;
const DEFAULT_MAX_CHUNKS = 24;

function configKey(config: MintBurnContractConfig): string {
  return mintBurnConfigKey(config);
}

async function readBodyJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request || request.method !== "POST") return {};
  try {
    return (await request.clone().json()) as Record<string, unknown>;
  } catch {
    return {};
  }
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

    if (config.chain.chainId !== ETHEREUM_CHAIN_ID) {
      return errorResponse(400, "Selected config is outside Ethereum-only mint/burn scope");
    }

    const chunkMax = ETHEREUM_CHUNK_SIZE;
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

    const currentLastBlock = await readMintBurnSyncState(db, configKey(config));

    const fromBlock = fromBlockParam >= 0
      ? fromBlockParam
      : (currentLastBlock ?? (config.startBlock - 1)) + 1;

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
        effectiveBurns: 0,
        bridgeBurns: 0,
        reviewBurns: 0,
        rowsReclassified: 0,
        chunksProcessed: 0,
        budgetUsed: budget.count,
      });
    }

    const chunkSize = Math.max(1, Math.min(chunkSizeParam, chunkMax));

    const { prices, priceHistory } = await loadMintBurnPriceContext(db, config.stablecoinId);
    const runTimestamp = Math.floor(Date.now() / 1000);
    const localTimestampCache = new Map<number, number>();

    let cursor = fromBlock;
    let chunksProcessed = 0;
    let rowsParsed = 0;
    let rowsInserted = 0;
    let rowsIgnored = 0;
    let rowsDropped = 0;
    let effectiveBurns = 0;
    let bridgeBurns = 0;
    let reviewBurns = 0;
    let rowsReclassified = 0;
    const txContextCache = new Map<string, MintBurnTxContext | null>();

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

      const affectedHours = new Map<string, MintBurnAffectedHour>();

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

        const burnCounts = await classifyBridgeBurnRows(
          parsed.rows,
          config,
          alchemyUrl,
          budget,
          txContextCache,
        );
        effectiveBurns += burnCounts.effectiveBurns;
        bridgeBurns += burnCounts.bridgeBurns;
        reviewBurns += burnCounts.reviewBurns;

        collectAffectedHours(parsed.rows, affectedHours);

        if (parsed.rows.length > 0) {
          const insertResult = await insertMintBurnRows(db, parsed.rows);
          rowsInserted += insertResult.inserted;
          rowsIgnored += insertResult.ignored;
          rowsReclassified += await updateBurnClassifications(db, parsed.rows);
        }
      }

      await recalcAffectedHours(db, affectedHours);

      await upsertMintBurnSyncState(db, configKey(config), scanTo, "monotonic-max");

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
      effectiveBurns,
      bridgeBurns,
      reviewBurns,
      rowsReclassified,
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
    });
  },
);
