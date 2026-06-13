import { describe, expect, it } from "vitest";
import {
  RedemptionAccessModelSchema,
  RedemptionCapacityBasisSchema,
  RedemptionCapacityConfidenceSchema,
  RedemptionCapacityScoringHorizonSchema,
  RedemptionCapacitySemanticsSchema,
  RedemptionDocSourceSupportSchema,
  RedemptionExecutionModelSchema,
  RedemptionFeeConfidenceSchema,
  RedemptionFeeModelKindSchema,
  RedemptionHolderEligibilitySchema,
  RedemptionLiveCapacityKindSchema,
  RedemptionLiveFreshnessKindSchema,
  RedemptionModelConfidenceSchema,
  RedemptionOutputAssetTypeSchema,
  RedemptionResolutionStateSchema,
  RedemptionRouteExitCorrelationSchema,
  RedemptionRouteFamilySchema,
  RedemptionRouteStatusSchema,
  RedemptionRouteStatusSourceSchema,
  RedemptionSettlementModelSchema,
  RedemptionSourceModeSchema,
} from "@shared/types/redemption";
import { REDEMPTION_ENUMS } from "../maintenance/smoke-api.mjs";

// Each smoke-api REDEMPTION_ENUMS set must mirror its Zod schema's options
// exactly, so a future schema change that the smoke validator forgets to mirror
// fails CI instead of silently passing stale data.
const SCHEMA_BY_ENUM_KEY = {
  routeFamily: RedemptionRouteFamilySchema,
  accessModel: RedemptionAccessModelSchema,
  settlementModel: RedemptionSettlementModelSchema,
  executionModel: RedemptionExecutionModelSchema,
  outputAssetType: RedemptionOutputAssetTypeSchema,
  sourceMode: RedemptionSourceModeSchema,
  resolutionState: RedemptionResolutionStateSchema,
  routeStatus: RedemptionRouteStatusSchema,
  routeStatusSource: RedemptionRouteStatusSourceSchema,
  holderEligibility: RedemptionHolderEligibilitySchema,
  capacityConfidence: RedemptionCapacityConfidenceSchema,
  capacityKind: RedemptionLiveCapacityKindSchema,
  freshnessKind: RedemptionLiveFreshnessKindSchema,
  capacityBasis: RedemptionCapacityBasisSchema,
  capacitySemantics: RedemptionCapacitySemanticsSchema,
  capacityScoringHorizon: RedemptionCapacityScoringHorizonSchema,
  feeConfidence: RedemptionFeeConfidenceSchema,
  feeModelKind: RedemptionFeeModelKindSchema,
  modelConfidence: RedemptionModelConfidenceSchema,
  routeExitCorrelation: RedemptionRouteExitCorrelationSchema,
  docSupport: RedemptionDocSourceSupportSchema,
} as const;

const sorted = (values: Iterable<string>) => [...values].sort();

describe("smoke-api REDEMPTION_ENUMS mirror shared/types/redemption schemas", () => {
  it("maps every REDEMPTION_ENUMS key to a schema with no gaps", () => {
    const enumKeys = sorted(Object.keys(REDEMPTION_ENUMS));
    const mappedKeys = sorted(Object.keys(SCHEMA_BY_ENUM_KEY));
    expect(mappedKeys).toEqual(enumKeys);
  });

  for (const [key, schema] of Object.entries(SCHEMA_BY_ENUM_KEY)) {
    it(`${key} matches its schema options`, () => {
      const enumSet = (REDEMPTION_ENUMS as Record<string, Set<string>>)[key];
      expect(enumSet, `REDEMPTION_ENUMS.${key} is missing`).toBeInstanceOf(Set);
      expect(sorted(enumSet)).toEqual(sorted(schema.options));
    });
  }
});
