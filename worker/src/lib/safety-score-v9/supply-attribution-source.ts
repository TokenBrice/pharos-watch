import { compareCodeUnits, sortedRecord } from "@shared/lib/compare";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import { SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS } from "./supply-attribution";
import {
  SafetyScoreV9SupplyAttributionSourceSchema,
  type SafetyScoreV9SupplyAttributionSource,
} from "./supply-attribution-source-contract";

export function buildSafetyScoreV9SupplyAttributionSource(
  input: Readonly<SafetyScoreV9CompilerInput>,
): SafetyScoreV9SupplyAttributionSource {
  const activeAssetIdSet = new Set(input.activeAssetIds);
  const activeAssetIds = SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS.filter(
    (assetId) => activeAssetIdSet.has(assetId),
  ).sort();
  // Census population: every active asset that carries the audited aggregate
  // (the share denominator). An asset without one can never conserve a
  // partition, so it must not spend a cohort slot.
  const censusAssetIds = [...new Set(input.activeAssetIds)]
    .filter(assetId => input.aggregateCirculatingById[assetId] !== undefined)
    .sort(compareCodeUnits);

  return SafetyScoreV9SupplyAttributionSourceSchema.parse({
    schemaVersion: 1,
    kind: "safety-score-v9-supply-attribution-source",
    baseInputGenerationId: input.baseInputGenerationId,
    sourceGeneration: input.sourceGeneration,
    registryFingerprint: input.registryFingerprint,
    clockSec: input.clockSec,
    activeAssetIds,
    navPriceById: sortedRecord(Object.fromEntries(activeAssetIds.flatMap(assetId => {
      const price = input.navPriceById?.[assetId];
      return price ? [[assetId, price]] : [];
    }))),
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
    censusProjection: {
      activeAssetIds: censusAssetIds,
      aggregateCirculatingById: sortedRecord(
        Object.fromEntries(censusAssetIds.flatMap((assetId) => {
          const row = input.aggregateCirculatingById[assetId];
          return row ? [[assetId, row] as const] : [];
        })),
      ),
      chainCirculatingById: sortedRecord(
        Object.fromEntries(censusAssetIds.map((assetId) => [
          assetId,
          sortedRecord(input.chainCirculatingById[assetId] ?? {}),
        ])),
      ),
      navPriceById: sortedRecord(Object.fromEntries(censusAssetIds.flatMap(assetId => {
        const price = input.navPriceById?.[assetId];
        return price ? [[assetId, price] as const] : [];
      }))),
      pegReferenceById: sortedRecord(Object.fromEntries(censusAssetIds.flatMap(assetId => {
        const pegReference = input.pegDataById?.[assetId]?.pegReference;
        if (pegReference === null || pegReference === undefined) return [];
        if (!Number.isFinite(pegReference.valueUsd) || pegReference.valueUsd <= 0 ||
          !Number.isSafeInteger(pegReference.asOf) || pegReference.asOf < 0) return [];
        return [[assetId, { valueUsd: pegReference.valueUsd, asOf: pegReference.asOf }] as const];
      }))),
    },
  });
}
