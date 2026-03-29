import {
  BluechipRatingsMapSchema,
  type BluechipRatingsMap,
} from "@shared/types/market";
import { validatePayloadWithSchema } from "./api-utils";

export function parseBluechipRatingsCache(
  raw: string | null | undefined,
  context: string,
): BluechipRatingsMap {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[bluechip-cache] Failed to parse ${context}:`, error);
    return {};
  }

  const validation = validatePayloadWithSchema(
    BluechipRatingsMapSchema,
    parsed,
    `${context}:bluechip-cache`,
  );
  if (!validation.ok) {
    console.warn(`[bluechip-cache] Invalid Bluechip cache shape for ${context}: ${validation.issues}`);
    return {};
  }

  return validation.data;
}
