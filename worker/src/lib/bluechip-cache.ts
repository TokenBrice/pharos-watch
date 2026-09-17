import {
  BluechipRatingsMapSchema,
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
        const validation = validatePayloadWithSchema(
          BluechipRatingsMapSchema,
          parsed,
          `${context}:bluechip-cache`,
        );
        return validation.ok
          ? { ok: true, payload: validation.data }
          : { ok: false, reason: "invalid-payload" };
      },
      onParseFailure: ({ message }) => recordJsonParseFailure(context, message),
    },
  );

  return decoded.ok ? decoded.payload : {};
}
