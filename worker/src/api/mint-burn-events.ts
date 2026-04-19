import {
  withErrorHandler,
  addFreshnessHeaders,
  errorResponse,
  parseEnumParam,
  parseOptionalEnumParam,
  parseQueryParams,
  parseRequiredStablecoinIdParam,
  jsonResponse,
  getLatestSuccessfulCronTimestamp,
  fetchPaginatedEvents,
} from "../lib/api-utils";
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

export const handleMintBurnEvents = withErrorHandler(
  "mint-burn-events",
  async (db: D1Database, url: URL): Promise<Response> => {
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
    const numericParams = parseQueryParams(params, {
      minAmount: { type: "float", default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, rangePolicy: "reject" },
      limit: { type: "int", default: 50, min: 1, max: 500, rangePolicy: "reject" },
      offset: { type: "int", default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, rangePolicy: "reject" },
    });
    if (numericParams instanceof Response) return numericParams;
    const { minAmount, limit, offset } = numericParams;

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

    const { events, total } = await fetchPaginatedEvents<EventRow, {
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
    }>(db, {
      tableName: "mint_burn_events",
      orderBy: "timestamp DESC",
      conditions,
      filterBindings,
      limit,
      offset,
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
    });

    const latestTs =
      events.length > 0
        ? events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity)
        : Math.floor(Date.now() / 1000);
    const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-mint-burn", latestTs);

    return jsonResponse({ events, total }, addFreshnessHeaders({
      "Cache-Control": CACHE_PROFILES.realtime,
    }, freshnessTs, API_FRESHNESS_MAX_AGE_SEC.mintBurnEvents));
  },
);
