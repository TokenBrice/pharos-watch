import {
  BluechipRatingSchema,
  type BluechipRatingsMap,
} from "@shared/types/market";
import { validatePayloadWithSchema } from "./api-schema";
import { decodeCachedJson } from "./cache-json";
import { recordJsonParseFailure } from "./api-cache-read";

type BluechipCacheFailureReason = "missing-cache" | "json-parse-failed" | "invalid-payload";

export function parseBluechipRatingsCache(
  raw: string | null | undefined,
  context: string,
): BluechipRatingsMap {
  const decoded = decodeCachedJson<BluechipRatingsMap, BluechipCacheFailureReason>(
    raw ? { value: raw } : null,
    {
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, reason: "invalid-payload" };
        }

        const ratings: BluechipRatingsMap = {};
        for (const [pharosId, value] of Object.entries(parsed)) {
          const validation = validatePayloadWithSchema(
            BluechipRatingSchema,
            value,
            `${context}:bluechip-cache:${pharosId}`,
          );
          if (validation.ok) ratings[pharosId] = validation.data;
        }
        return { ok: true, payload: ratings };
      },
      onParseFailure: ({ message }) => recordJsonParseFailure(context, message),
    },
  );

  return decoded.ok ? decoded.payload : {};
}
