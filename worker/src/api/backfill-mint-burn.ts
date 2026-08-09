import { buildAlchemyUrl, getAlchemyBlockNumber, fetchAlchemyLogs, resolveBlockTimestamps } from "../lib/alchemy-logs";
import type { AlchemyLogEntry } from "../lib/alchemy-logs";
import { createBudget, budgetExhausted } from "../lib/evm-logs";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig, type MintBurnEventDef } from "../lib/mint-burn-contracts";
import type { MintBurnTxContext } from "../lib/mint-burn-bridge-classifier";
import { errorResponse, jsonResponse, parseQueryParams } from "../lib/api-utils";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { assertActiveStablecoin } from "../lib/frozen-guards";
import type { TopicFilter } from "../lib/evm-logs";
import { classifyBridgeBurnRows } from "../lib/mint-burn-pipeline/classification";
import { loadMintBurnPriceContextBatch } from "../lib/mint-burn-pipeline/context";
import { parseMintBurnLogs } from "../lib/mint-burn-pipeline/parse";
import {
  persistMintBurnRows,
  recalcAffectedHours,
} from "../lib/mint-burn-pipeline/persistence";
import {
  ensureMintBurnSyncStateRows,
  mintBurnConfigKey,
  readMintBurnSyncStateForConfig,
  readMintBurnSyncStateBatch,
  upsertMintBurnSyncState,
} from "../lib/mint-burn-pipeline/sync-state";
import type { MintBurnAffectedHour, MintBurnRow } from "../lib/mint-burn-pipeline/types";
import { resolveMintBurnFreshnessConfig } from "../lib/mint-burn-health-config";
import { readAdminIntegerParam, readAdminStringParam, runAdminJob } from "../lib/admin-job";

const ETHEREUM_CHUNK_SIZE = 50_000;

const BACKFILL_BUDGET_LIMIT = 900;
const DEFAULT_MAX_CHUNKS = 24;

function configKey(config: MintBurnContractConfig): string {
  return mintBurnConfigKey(config);
}

type BackfillConfigResult =
  | { ok: true; config: MintBurnContractConfig; selectionMode: "explicit" | "auto"; autoSelectedReason: string | null }
  | { ok: false; response: Response };

async function resolveBackfillConfig(
  db: D1Database,
  chainHeads: Map<string, number>,
  requestedConfigKey: string | null,
): Promise<BackfillConfigResult> {
  if (requestedConfigKey) {
    const config = MINT_BURN_CONFIGS.find((entry) => configKey(entry).toLowerCase() === requestedConfigKey);
    if (!config) {
      return { ok: false, response: errorResponse(404, "Unknown mint/burn configKey") };
    }
    return {
      ok: true,
      config,
      selectionMode: "explicit",
      autoSelectedReason: null,
    };
  }

  const eligibleConfigs = MINT_BURN_CONFIGS.filter(
    (entry) => entry.enabled !== false && ACTIVE_IDS.has(entry.stablecoinId),
  );
  if (eligibleConfigs.length === 0) {
    return { ok: false, response: errorResponse(400, "No eligible mint/burn configs are enabled") };
  }

  await ensureMintBurnSyncStateRows(db, eligibleConfigs);
  const syncStateByKey = await readMintBurnSyncStateBatch(db, eligibleConfigs);
  const majorSymbols = new Set(
    resolveMintBurnFreshnessConfig().majorSymbols.map((symbol) => symbol.trim().toUpperCase()),
  );

  const config = [...eligibleConfigs].sort((a, b) => {
    const aTier = a.tier === "extended" ? 1 : 0;
    const bTier = b.tier === "extended" ? 1 : 0;
    if (aTier !== bTier) return aTier - bTier;

    const aMajor = majorSymbols.has(a.symbol.toUpperCase()) ? 0 : 1;
    const bMajor = majorSymbols.has(b.symbol.toUpperCase()) ? 0 : 1;
    if (aMajor !== bMajor) return aMajor - bMajor;

    const aHead = chainHeads.get(a.chain.chainId) ?? (a.startBlock - 1);
    const bHead = chainHeads.get(b.chain.chainId) ?? (b.startBlock - 1);
    const aLag = Math.max(0, aHead - (syncStateByKey.get(configKey(a)) ?? a.startBlock - 1));
    const bLag = Math.max(0, bHead - (syncStateByKey.get(configKey(b)) ?? b.startBlock - 1));
    return bLag - aLag;
  })[0];
  if (!config) {
    return { ok: false, response: errorResponse(400, "No eligible mint/burn configs are enabled") };
  }

  return {
    ok: true,
    config,
    selectionMode: "auto",
    autoSelectedReason: "critical-first-most-behind",
  };
}

export interface BackfillMintBurnRouteContext {
  db: D1Database;
  url: URL;
  trustedAdmin?: boolean;
  request?: Request;
  alchemyApiKey?: string | null;
}

export async function handleBackfillMintBurn({
  db,
  url,
  trustedAdmin,
  request,
  alchemyApiKey = null,
}: BackfillMintBurnRouteContext): Promise<Response> {
  const executeBackfill = async (body: Record<string, unknown>): Promise<Response> => {
    if (!alchemyApiKey) {
      return errorResponse(500, "ALCHEMY_API_KEY is not configured");
    }

    const configKeyParam = readAdminStringParam(body, url.searchParams, "configKey")?.toLowerCase() ?? null;

    const chunkMax = ETHEREUM_CHUNK_SIZE;
    const defaultChunkSize = chunkMax;
    const maxChunksLimit = 500;
    const numericParams = parseQueryParams(url.searchParams, {
      fromBlock: { type: "int", default: -1, min: -1, max: Number.MAX_SAFE_INTEGER },
      toBlock: { type: "int", default: -1, min: -1, max: Number.MAX_SAFE_INTEGER },
      chunkSize: { type: "int", default: defaultChunkSize, min: 1, max: chunkMax },
      maxChunks: { type: "int", default: DEFAULT_MAX_CHUNKS, min: 1, max: maxChunksLimit },
    });
    if (numericParams instanceof Response) {
      return numericParams;
    }
    const {
      fromBlock: parsedFromBlock,
      toBlock: parsedToBlock,
      chunkSize: parsedChunkSize,
      maxChunks: parsedMaxChunks,
    } = numericParams;

    const fromBlockParam = readAdminIntegerParam(body, url.searchParams, "fromBlock") ?? parsedFromBlock;
    const toBlockParam = readAdminIntegerParam(body, url.searchParams, "toBlock") ?? parsedToBlock;
    const chunkSizeParam = readAdminIntegerParam(body, url.searchParams, "chunkSize") ?? parsedChunkSize;
    // Re-clamp: readAdminIntegerParam only digit-checks, so a body-supplied
    // maxChunks bypasses the parseQueryParams max bound (see audit Q-234).
    const maxChunks = Math.max(
      1,
      Math.min(readAdminIntegerParam(body, url.searchParams, "maxChunks") ?? parsedMaxChunks, maxChunksLimit),
    );

    const budget = createBudget(BACKFILL_BUDGET_LIMIT);
    const chainHeads = new Map<string, number>();
    for (const chainId of [...new Set(MINT_BURN_CONFIGS.map((config) => config.chain.chainId))]) {
      const alchemyUrl = buildAlchemyUrl(chainId, alchemyApiKey);
      if (!alchemyUrl) {
        return errorResponse(400, `Alchemy URL is not configured for chain ${chainId}`);
      }
      const chainHead = await getAlchemyBlockNumber(alchemyUrl, budget);
      if (chainHead == null) {
        return errorResponse(502, `Failed to fetch chain head for ${chainId} backfill range`);
      }
      chainHeads.set(chainId, chainHead);
    }

    const selectedConfig = await resolveBackfillConfig(db, chainHeads, configKeyParam);
    if (!selectedConfig.ok) return selectedConfig.response;

    const { config, selectionMode, autoSelectedReason } = selectedConfig;
    const inactiveRejection = assertActiveStablecoin(config.stablecoinId);
    if (inactiveRejection) return inactiveRejection;
    const alchemyUrl = buildAlchemyUrl(config.chain.chainId, alchemyApiKey);
    if (!alchemyUrl) {
      return errorResponse(400, `Alchemy URL is not configured for chain ${config.chain.chainId}`);
    }
    const chainHead = chainHeads.get(config.chain.chainId);
    if (chainHead == null) {
      return errorResponse(502, `Failed to fetch chain head for chain ${config.chain.chainId}`);
    }

    const currentLastBlock = await readMintBurnSyncStateForConfig(db, config);
    const fromBlock = fromBlockParam >= 0 ? fromBlockParam : (currentLastBlock ?? config.startBlock - 1) + 1;
    const toBlock = toBlockParam >= 0 ? Math.min(toBlockParam, chainHead) : chainHead;
    if (toBlock < fromBlock) {
      return jsonResponse({
        configKey: configKey(config),
        selectedSymbol: config.symbol,
        selectionMode,
        autoSelectedReason,
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
        txContextShortfalls: 0,
        rowsReclassified: 0,
        reclassified: { flowTypeChanges: 0, burnTypeChanges: 0 },
        chunksProcessed: 0,
        budgetUsed: budget.count,
      });
    }

    const chunkSize = Math.max(1, Math.min(chunkSizeParam, chunkMax));
    const { prices, priceHistory } = await loadMintBurnPriceContextBatch(db, [config.stablecoinId]);
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
    let txContextShortfalls = 0;
    let flowTypeChanges = 0;
    let burnTypeChanges = 0;
    let rowsReclassifiedUnique = 0;
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

        const fetched = await fetchAlchemyLogs(alchemyUrl, config.contractAddress, topics, cursor, scanTo, budget);
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

      const uniqueBlocks = [...new Set(collectedLogs.flatMap(({ logs }) => logs.map((log) => parseInt(log.blockNumber, 16))))];
      const blockTimestamps =
        uniqueBlocks.length > 0
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
      const allParsedRows: MintBurnRow[] = [];

      for (const { eventDef, logs } of collectedLogs) {
        const parsed = parseMintBurnLogs(config, eventDef, logs, blockTimestamps, prices, priceHistory, runTimestamp);

        rowsDropped += parsed.dropped;
        rowsParsed += parsed.rows.length;

        allParsedRows.push(...parsed.rows);
      }

      const burnCounts = await classifyBridgeBurnRows(allParsedRows, config, alchemyUrl, budget, txContextCache);
      if (burnCounts.txContextShortfalls > 0) {
        txContextShortfalls += burnCounts.txContextShortfalls;
        return errorResponse(
          502,
          `Backfill failed for ${configKey(config)} at ${cursor}-${scanTo}: ` +
            `${burnCounts.txContextShortfalls} transaction context lookup(s) unavailable`,
        );
      }
      effectiveBurns += burnCounts.effectiveBurns;
      bridgeBurns += burnCounts.bridgeBurns;
      reviewBurns += burnCounts.reviewBurns;

      const persistResult = await persistMintBurnRows(db, allParsedRows, affectedHours);
      rowsInserted += persistResult.inserted;
      rowsIgnored += persistResult.ignored;
      flowTypeChanges += persistResult.flowTypeChanges;
      burnTypeChanges += persistResult.burnTypeChanges;
      rowsReclassifiedUnique += persistResult.rowsUpdated;

      await recalcAffectedHours(db, affectedHours);
      await upsertMintBurnSyncState(db, configKey(config), scanTo, "monotonic-max");

      cursor = scanTo + 1;
      chunksProcessed++;
    }

    return jsonResponse({
      configKey: configKey(config),
      selectedSymbol: config.symbol,
      selectionMode,
      autoSelectedReason,
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
      txContextShortfalls,
      // Legacy scalar: unique rows that had any classification column rewritten.
      // Exact per-column counts live in `reclassified` below.
      rowsReclassified: rowsReclassifiedUnique,
      reclassified: { flowTypeChanges, burnTypeChanges },
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
    });
  };

  return runAdminJob({ request, trustedAdmin, url, parseBody: true }, (context) => executeBackfill(context.body));
}
