import { errorResponse } from "../lib/api-response";
import {
  parseEnumParam,
  parseFloatParam,
  parseOptionalEnumParam,
  parseRequiredStablecoinIdParam,
} from "../lib/api-params";
import { buildPaginatedEventResponse } from "../lib/api-pagination";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CACHE_PROFILES } from "../lib/constants";
import { getMintBurnConfigsForStablecoin } from "../lib/mint-burn-contracts";
import { buildInClause } from "../lib/db";

const VALID_DIRECTIONS = new Set(["mint", "burn"]);
const VALID_BURN_TYPES = new Set(["effective_burn", "bridge_burn", "review_required"]);
const VALID_SCOPES = new Set(["all", "counted"]);

interface EventRow {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: string;
  flow_type: "standard" | "atomic_roundtrip" | "bridge_transfer";
  amount: number;
  amount_usd: number | null;
  burn_type: "effective_burn" | "bridge_burn" | "review_required" | null;
  burn_review_reason: string | null;
  counterparty: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
  price_used: number | null;
  price_timestamp: number | null;
  price_source: string | null;
}

export const handleMintBurnEvents = async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;

    const stablecoinId = parseRequiredStablecoinIdParam(params);
    if (stablecoinId instanceof Response) return stablecoinId;

    const direction = parseOptionalEnumParam(params.get("direction"), VALID_DIRECTIONS, "direction");
    if (direction instanceof Response) return direction;
    const chain = params.get("chain");
    const configs = getMintBurnConfigsForStablecoin(stablecoinId);
    if (configs.length === 0) {
      return errorResponse(404, `Stablecoin "${stablecoinId}" is not tracked for mint/burn flows`);
    }
    const trackedChainIds = [...new Set(configs.map((config) => config.chain.chainId))];
    if (chain && !trackedChainIds.includes(chain)) {
      return errorResponse(400, "Invalid chain parameter");
    }
    const queryChainIds = chain ? [chain] : trackedChainIds;
    const chainInClause = buildInClause(queryChainIds);
    const burnType = parseOptionalEnumParam(params.get("burnType"), VALID_BURN_TYPES, "burnType");
    if (burnType instanceof Response) return burnType;
    const scope = parseEnumParam(params.get("scope"), VALID_SCOPES, "scope", "all");
    if (scope instanceof Response) return scope;
    const minAmount = parseFloatParam(params.get("minAmount"), 0, 0, Number.MAX_SAFE_INTEGER, "minAmount", {
      rangePolicy: "reject",
    });
    if (minAmount instanceof Response) return minAmount;

    // Build WHERE conditions
    const conditions: string[] = ["stablecoin_id = ?", `chain_id IN (${chainInClause.sql})`];
    const filterBindings: (string | number)[] = [stablecoinId, ...queryChainIds];

    if (direction) {
      conditions.push("direction = ?");
      filterBindings.push(direction);
    }
    if (burnType) {
      conditions.push("burn_type = ?");
      filterBindings.push(burnType);
    }
    if (scope === "counted") {
      conditions.push("flow_type = 'standard'");
      conditions.push("(direction = 'mint' OR burn_type = 'effective_burn')");
    }
    if (minAmount > 0) {
      conditions.push("amount_usd IS NOT NULL AND amount_usd >= ?");
      filterBindings.push(minAmount);
    }

    return buildPaginatedEventResponse<
      EventRow,
      {
        id: string;
        stablecoinId: string;
        symbol: string;
        chainId: string;
        direction: "mint" | "burn";
        flowType: EventRow["flow_type"];
        amount: number;
        amountUsd: number | null;
        burnType: EventRow["burn_type"];
        burnReviewReason: string | null;
        counterparty: string | null;
        txHash: string;
        blockNumber: number;
        timestamp: number;
        explorerTxUrl: string;
        priceUsed: number | null;
        priceTimestamp: number | null;
        priceSource: string | null;
      }
    >(db, {
      tableName: "mint_burn_events",
      orderBy: "timestamp DESC, block_number DESC, id DESC",
      conditions,
      filterBindings,
      mapRow: (row) => ({
        id: row.id,
        stablecoinId: row.stablecoin_id,
        symbol: row.symbol,
        chainId: row.chain_id,
        direction: row.direction as "mint" | "burn",
        flowType: row.flow_type,
        amount: row.amount,
        amountUsd: row.amount_usd,
        burnType: row.burn_type,
        burnReviewReason: row.burn_review_reason,
        counterparty: row.counterparty,
        txHash: row.tx_hash,
        blockNumber: row.block_number,
        timestamp: row.timestamp,
        explorerTxUrl: row.explorer_tx_url,
        priceUsed: row.price_used,
        priceTimestamp: row.price_timestamp,
        priceSource: row.price_source,
      }),
      searchParams: params,
      pagination: { defaultLimit: 50, minLimit: 1, maxLimit: 500, maxOffset: 25_000 },
      cursor: {
        columns: [
          { column: "timestamp", type: "number", direction: "DESC", getValue: (row) => row.timestamp },
          { column: "block_number", type: "number", direction: "DESC", getValue: (row) => row.block_number },
          { column: "id", type: "string", direction: "DESC", getValue: (row) => row.id },
        ],
      },
      freshness: {
        producerJob: "sync-mint-burn",
        maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnEvents,
        fallbackTimestamp: (events) =>
          events.length > 0
            ? events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity)
            : Math.floor(Date.now() / 1000),
      },
      cacheControl: CACHE_PROFILES.producerBacked,
    });
  };
