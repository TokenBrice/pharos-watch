import {
  BluechipRatingSchema,
  BluechipRatingsMapSchema,
  type BluechipRatingsMap,
} from "@shared/types/bluechip";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { assessBluechipRating } from "@shared/lib/bluechip-freshness";
import { validatePayloadWithSchema } from "../api-schema";
import { decodeCachedJson } from "../cache-json";
import { createCacheHandler, recordJsonParseFailure } from "../api-cache-read";

export const handleBluechipRatings = createCacheHandler(
  "bluechip-ratings",
  "bluechip-ratings",
  CACHE_PROFILES.slow,
  API_FRESHNESS_MAX_AGE_SEC.bluechip,
  {
    schema: BluechipRatingsMapSchema,
    malformedMessage: "Cached bluechip-ratings payload is malformed",
    transform: (payload) => {
      const now = Math.floor(Date.now() / 1000);
      return Object.fromEntries(Object.entries(payload as BluechipRatingsMap).map(
        ([id, rating]) => [id, assessBluechipRating(rating, now)],
      ));
    },
  },
);

type BluechipCacheFailureReason = "missing-cache" | "json-parse-failed" | "invalid-payload";

export interface BluechipRatingsCacheRead {
  ratings: BluechipRatingsMap;
  /** Payload keys that failed schema admission and carry no readable rating. */
  droppedIds: string[];
}

export function readBluechipRatingsCache(
  raw: string | null | undefined,
  context: string,
): BluechipRatingsCacheRead {
  const decoded = decodeCachedJson<BluechipRatingsCacheRead, BluechipCacheFailureReason>(
    raw ? { value: raw } : null,
    {
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, reason: "invalid-payload" };
        }

        const ratings: BluechipRatingsMap = {};
        const droppedIds: string[] = [];
        for (const [pharosId, value] of Object.entries(parsed)) {
          const validation = validatePayloadWithSchema(
            BluechipRatingSchema,
            value,
            `${context}:bluechip-cache:${pharosId}`,
          );
          if (validation.ok) ratings[pharosId] = validation.data;
          else droppedIds.push(pharosId);
        }
        return { ok: true, payload: { ratings, droppedIds } };
      },
      onParseFailure: ({ message }) => recordJsonParseFailure(context, message),
    },
  );

  return decoded.ok ? decoded.payload : { ratings: {}, droppedIds: [] };
}

export function parseBluechipRatingsCache(
  raw: string | null | undefined,
  context: string,
): BluechipRatingsMap {
  return readBluechipRatingsCache(raw, context).ratings;
}
