import { DAY_SECONDS } from "@shared/lib/time-constants";
import { TreasuryStableExposureResponseSchema } from "@shared/types";
import {
  addFreshnessHeaders,
  buildFreshnessMeta,
  errorResponse,
  jsonResponse,
  readCachedJsonOr503,
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
      return errorResponse(503, "Data not yet available");
    }

    const parsed = readCachedJsonOr503<unknown>("treasury-stable-exposure", "treasury-stable-exposure", cached);
    if (!parsed.ok) {
      return parsed.response;
    }

    const validation = validatePayloadWithSchema(
      TreasuryStableExposureResponseSchema,
      parsed.data,
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
