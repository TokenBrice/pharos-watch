import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { UsdsStatusResponse } from "@shared/types";
import { UsdsStatusResponseSchema } from "@shared/types/stability";
import {
  BluechipRatingsMapSchema,
  STABLECOIN_CHART_LEGACY_AGGREGATE_UNIVERSE,
  StablecoinListResponseSchema,
} from "@shared/types/market";
import {
  createCacheHandler,
  errorResponse,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { RESPONSE_READY_CACHE_SCHEMA_IDS } from "../lib/response-ready-cache-contracts";
import { normalizeStablecoinChartPoints } from "../lib/stablecoin-charts-payload";

export { handleYieldRankings } from "./yield-rankings-cache";

export const handleStablecoins = createCacheHandler(
  "stablecoins",
  "stablecoins",
  CACHE_PROFILES.producerBacked,
  API_FRESHNESS_MAX_AGE_SEC.stablecoins,
  {
    schema: StablecoinListResponseSchema,
    malformedMessage: "Cached stablecoins payload is malformed",
    responseReadyCache: "json-object",
    responseReadySchemaId: RESPONSE_READY_CACHE_SCHEMA_IDS.stablecoins,
  },
);

export const handleStablecoinCharts = createCacheHandler(
  "stablecoin-charts",
  "stablecoin-charts",
  CACHE_PROFILES.standard,
  API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts,
  {
    injectMeta: "never",
    transform: (payload) => {
      const normalizedPoints = normalizeStablecoinChartPoints(payload);
      if (!normalizedPoints) {
        return errorResponse(503, "Cached stablecoin-charts payload is malformed");
      }

      return normalizedPoints.map((point) => ({
        ...point,
        aggregateUniverse: point.aggregateUniverse ?? STABLECOIN_CHART_LEGACY_AGGREGATE_UNIVERSE,
      }));
    },
  },
);

export const handleBluechipRatings = createCacheHandler(
  "bluechip-ratings",
  "bluechip-ratings",
  CACHE_PROFILES.slow,
  API_FRESHNESS_MAX_AGE_SEC.bluechip,
  {
    schema: BluechipRatingsMapSchema,
    malformedMessage: "Cached bluechip-ratings payload is malformed",
  },
);

export const handleUsdsStatus = createCacheHandler(
  "usds-status",
  "usds-status",
  CACHE_PROFILES.standard,
  API_FRESHNESS_MAX_AGE_SEC.usdsStatus,
  {
    schema: UsdsStatusResponseSchema,
    malformedMessage: "Cached usds-status payload is malformed",
    transform: (payload, { cached }) => {
      const status = payload as UsdsStatusResponse;
      if (status.lastChecked > 0) {
        return status;
      }
      return {
        ...status,
        lastChecked: cached.updatedAt,
      };
    },
  },
);
