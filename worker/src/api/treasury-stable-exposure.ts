import { DAY_SECONDS } from "@shared/lib/time-constants";
import { TREASURY_SEEDS } from "@shared/lib/treasury-seeds";
import { buildTreasuryStableExposureSnapshot } from "@shared/lib/treasury-stable-exposure";
import { TreasuryStableExposureResponseSchema } from "@shared/types";
import {
  addFreshnessHeaders,
  buildFreshnessMeta,
  errorResponse,
  jsonResponse,
  validatePayloadWithSchema,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getCache } from "../lib/db-cache";

const MAX_AGE_SEC = DAY_SECONDS;

export const handleTreasuryStableExposure = withErrorHandler(
  "treasury-stable-exposure",
  async (db: D1Database): Promise<Response> => {
    const cached = await getCache(db, "treasury-stable-exposure");
    if (!cached) {
      const body = {
        ...buildTreasuryStableExposureSnapshot(TREASURY_SEEDS, [], 0),
        _meta: buildFreshnessMeta(0, MAX_AGE_SEC),
      };
      return jsonResponse(
        body,
        addFreshnessHeaders({
          "Content-Type": "application/json",
          "Cache-Control": CACHE_PROFILES.slow,
        }, 0, MAX_AGE_SEC),
      );
    }

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(cached.value) as unknown;
    } catch {
      return errorResponse(503, "Cached treasury-stable-exposure payload is malformed");
    }

    const validation = validatePayloadWithSchema(
      TreasuryStableExposureResponseSchema,
      parsedData,
      "treasury-stable-exposure:cache-read",
    );
    if (!validation.ok) {
      return errorResponse(503, "Cached treasury-stable-exposure payload is malformed");
    }

    const body = {
      ...validation.data,
      _meta: buildFreshnessMeta(cached.updatedAt, MAX_AGE_SEC),
    };

    return jsonResponse(
      body,
      addFreshnessHeaders({
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.slow,
      }, cached.updatedAt, MAX_AGE_SEC),
    );
  },
);
