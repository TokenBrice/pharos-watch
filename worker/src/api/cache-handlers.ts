import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { UsdsStatusResponse } from "@shared/types";
import { UsdsStatusResponseSchema } from "@shared/types/digest";
import { BluechipRatingsMapSchema, StablecoinListResponseSchema } from "@shared/types/market";
import {
  createCacheHandler,
  errorResponse,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { normalizeStablecoinChartPoints } from "../lib/stablecoin-charts-payload";
import {
  appendOrReplaceCurrentStablecoinChartsPoint,
  buildCurrentStablecoinChartsPoint,
} from "../lib/stablecoin-charts-reconciliation";

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
  },
);

export const handleStablecoinCharts = createCacheHandler(
  "stablecoin-charts",
  "stablecoin-charts",
  CACHE_PROFILES.standard,
  API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts,
  {
    injectMeta: "never",
    transform: async (payload, { db }) => {
      const normalizedPoints = normalizeStablecoinChartPoints(payload);
      if (!normalizedPoints) {
        return errorResponse(503, "Cached stablecoin-charts payload is malformed");
      }

      let points = normalizedPoints;

      const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true });
      if (stablecoinsCache.kind === "ok") {
        const currentPoint = buildCurrentStablecoinChartsPoint(
          stablecoinsCache.payload.peggedAssets,
          stablecoinsCache.updatedAt,
        );
        points = appendOrReplaceCurrentStablecoinChartsPoint(points, currentPoint);
      }

      return points;
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
