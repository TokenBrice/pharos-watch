import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { BaseInputGenerationIdSchema, Sha256Schema } from "@shared/types/safety-schema-primitives";
import { compareText } from "@shared/types/safety-score-v9-fact-primitives";
import { z } from "zod";
import { parseJson } from "./json-parse";
import type { SafetyScoreV9CompilerInput } from "./safety-score-v9-native-input";
import { CENTRIFUGE_BURN_MINT_ASSET_IDS } from "./safety-score-v9-supply-attribution-contract";
import { XAUT_ASSET_ID } from "./safety-score-v9-xaut-supply-attribution-contract";

export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY =
  "safety-score-v9:supply-attribution-source:v1";

export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS = Object.freeze([
  "wm-m0",
  XAUT_ASSET_ID,
  ...CENTRIFUGE_BURN_MINT_ASSET_IDS,
]);

const SafetyScoreV9SupplyAttributionSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-supply-attribution-source"),
    baseInputGenerationId: BaseInputGenerationIdSchema,
    sourceGeneration: z.string().min(1),
    registryFingerprint: Sha256Schema,
    clockSec: z.number().int().nonnegative(),
    activeAssetIds: z.array(z.string().min(1)),
    aggregateCirculatingById: z.record(
      z.string(),
      z.object({
        circulating: z.record(z.string(), z.number().finite().nonnegative()),
        observedAtSec: z.number().int().nonnegative().nullable(),
      }).strict(),
    ),
    chainCirculatingById: z.record(
      z.string(),
      z.record(
        z.string(),
        z.object({ current: z.number().finite().nonnegative() }).strict(),
      ),
    ),
  })
  .strict();

export type SafetyScoreV9SupplyAttributionSource = z.infer<
  typeof SafetyScoreV9SupplyAttributionSourceSchema
>;
export type SafetyScoreV9SupplyAttributionInput = Pick<
  SafetyScoreV9SupplyAttributionSource,
  | "baseInputGenerationId"
  | "sourceGeneration"
  | "registryFingerprint"
  | "clockSec"
  | "activeAssetIds"
  | "aggregateCirculatingById"
  | "chainCirculatingById"
>;

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => compareText(left, right)),
  );
}

export function buildSafetyScoreV9SupplyAttributionSource(
  input: Readonly<SafetyScoreV9CompilerInput>,
): SafetyScoreV9SupplyAttributionSource {
  const activeAssetIdSet = new Set(input.activeAssetIds);
  const activeAssetIds = SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS.filter(
    (assetId) => activeAssetIdSet.has(assetId),
  ).sort();

  return SafetyScoreV9SupplyAttributionSourceSchema.parse({
    schemaVersion: 1,
    kind: "safety-score-v9-supply-attribution-source",
    baseInputGenerationId: input.baseInputGenerationId,
    sourceGeneration: input.sourceGeneration,
    registryFingerprint: input.registryFingerprint,
    clockSec: input.clockSec,
    activeAssetIds,
    aggregateCirculatingById: sortedRecord(
      Object.fromEntries(
        activeAssetIds.flatMap((assetId) => {
          const row = input.aggregateCirculatingById[assetId];
          return row ? [[assetId, row] as const] : [];
        }),
      ),
    ),
    chainCirculatingById: sortedRecord(
      Object.fromEntries(
        activeAssetIds.map((assetId) => [
          assetId,
          sortedRecord(input.chainCirculatingById[assetId] ?? {}),
        ]),
      ),
    ),
  });
}

export function serializeSafetyScoreV9SupplyAttributionSource(
  source: SafetyScoreV9SupplyAttributionSource,
): string {
  return stableJsonStringifyV1(
    SafetyScoreV9SupplyAttributionSourceSchema.parse(source),
  );
}

export function parseSafetyScoreV9SupplyAttributionSource(
  value: unknown,
): SafetyScoreV9SupplyAttributionSource {
  const parsed = typeof value === "string"
    ? parseJson(value, { onFailure: () => undefined })
    : { ok: true as const, value };
  if (!parsed.ok) {
    throw new Error(`Malformed V9 supply-attribution source: ${parsed.message}`);
  }
  return SafetyScoreV9SupplyAttributionSourceSchema.parse(parsed.value);
}
