import {
  BluechipRatingSchema,
  type BluechipRatingsMap,
} from "@shared/types/market";
import { validatePayloadWithSchema } from "./api-schema";
import { decodeCachedJson } from "./cache-json";
import { recordJsonParseFailure } from "./api-cache-read";

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
