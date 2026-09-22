import { z } from "zod";
import { compareCodeUnits } from "@shared/lib/compare";
import { BluechipRatingsMapSchema } from "@shared/types/bluechip";
import { stableJsonStringifyV1 } from "@shared/lib/depeg-resolver/hash";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import {
  FixedDexLiquidityRowSchema,
  ReportCardsFixedInputMethodologyVersionsSchema,
  normalizeFixedDexLiquidityMap,
  normalizeFixedRedemptionBackstopMap,
  normalizeReportCardsFixedInputMethodologyVersions,
  projectReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import { SafetyScoreV8PublicationIdentitySchema } from "@shared/types/safety-score-publication";
import { BaseInputGenerationIdSchema, Sha256Schema } from "@shared/types/safety-schema-primitives";
import {
  assertCommonFixedInputConsistency,
  assertSameIds,
  createFixedInputPayloadFields,
  normalizeCommonFixedInputRecords,
  SafetyScoreV9SupplyAttributionSchema,
  type DexDeploymentSupplyCoverage,
} from "./report-cards-fixed-input-contract";
import {
  FixedInputCacheEnvelopeFields,
  parseFixedInputCacheEntry,
} from "./report-cards-fixed-input-cache-codec";
import { V9PublicationInputHealthSchema } from "./safety-score-v9/publication-assessment";

export {
  SafetyScoreV9SupplyAttributionSchema,
  type DexDeploymentSupplyCoverage,
};

const BlacklistStatusSchema = z.union([z.boolean(), z.literal("possible"), z.literal("inherited")]);

const FixedInputPayloadFields = createFixedInputPayloadFields({
  publicationHealthSchema: V9PublicationInputHealthSchema.default({
    dex: {
      state: "unavailable",
      generationId: null,
      updatedAtSec: null,
    },
    redemption: {
      state: "unavailable",
      generationId: null,
      updatedAtSec: null,
    },
    liveReserves: { state: "unavailable", coverageRatio: null },
  }),
  afterRedemptionBackstopMap: {
    bluechipMap: BluechipRatingsMapSchema,
    resolvedBlacklistStatuses: z.record(z.string(), BlacklistStatusSchema),
  },
  chainCirculatingByIdSchema: z
    .record(
      z.string(),
      z.record(
        z.string(),
        z.object({
          current: z.number().finite().nonnegative(),
          circulatingPrevDay: z.number().finite().nonnegative(),
          circulatingPrevWeek: z.number().finite().nonnegative(),
          circulatingPrevMonth: z.number().finite().nonnegative(),
        }),
      ),
    )
    .default({}),
  beforeLiveToFallbackCoins: {
    collateralDriftCoins: z
      .array(z.object({ id: z.string(), liveScore: z.number(), curatedScore: z.number(), delta: z.number() }))
      .default([]),
  },
});

const LegacyReportCardsFixedInputV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    ...FixedInputPayloadFields,
    captureKind: z.enum(["exact-publication-inputs", "public-reconstruction"]),
    activeAssetIds: z.array(z.string().min(1)),
    dexGenerationId: z.string().min(1),
    redemptionGenerationId: z.string().min(1),
    dexPayloadFingerprint: Sha256Schema,
    redemptionPayloadFingerprint: Sha256Schema,
    registryFingerprint: Sha256Schema,
    inputMethodologyVersions: ReportCardsFixedInputMethodologyVersionsSchema,
    dexLiqMap: z.record(z.string(), FixedDexLiquidityRowSchema),
  })
  .strict();

const ReportCardsFixedInputSchema = LegacyReportCardsFixedInputV3Schema.extend({
  baseInputGenerationId: BaseInputGenerationIdSchema,
}).strict();
const ReportCardsFixedInputIntakeSchema = ReportCardsFixedInputSchema.omit({
  baseInputGenerationId: true,
}).extend({ baseInputGenerationId: BaseInputGenerationIdSchema.optional() });

export type ReportCardsFixedInput = z.infer<typeof ReportCardsFixedInputSchema>;
type LegacyReportCardsFixedInputV3 = z.infer<typeof LegacyReportCardsFixedInputV3Schema>;

// The V1 replay envelope and V2 native envelope share their transport fields;
// only their versioned identity requirements differ.
const FixedInputCacheEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  ...FixedInputCacheEnvelopeFields,
  safetyScoreIdentity: SafetyScoreV8PublicationIdentitySchema.optional(),
});

export async function parseReportCardsFixedInputCacheValue(
  value: unknown,
  navAssetIds?: ReadonlySet<string>,
): Promise<ReportCardsFixedInput> {
  const { envelope, payload } = await parseFixedInputCacheEntry({
    value,
    envelopeSchema: FixedInputCacheEnvelopeSchema,
    malformedEnvelopeLabel: "Malformed exact report-card fixed input cache envelope",
    malformedPayloadLabel: "Malformed exact report-card fixed input cache payload",
    artifactLabel: "Exact report-card fixed input cache artifact",
  });
  const input = normalizeFixedInput(payload, navAssetIds);
  if (input.captureKind !== "exact-publication-inputs") {
    throw new Error("Cached report-card fixed input is not publication-exact");
  }
  if (input.sourceGeneration !== envelope.sourceGeneration) {
    throw new Error("Exact report-card fixed input cache generation mismatch");
  }
  if (
    envelope.safetyScoreIdentity &&
    (envelope.safetyScoreIdentity.baseInputGenerationId !== input.baseInputGenerationId ||
      envelope.safetyScoreIdentity.methodologyVersion !== input.methodologyVersion ||
      envelope.safetyScoreIdentity.publicationGenerationId !== input.sourceGeneration)
  ) {
    throw new Error("Exact report-card fixed input cache identity mismatch");
  }
  return input;
}
function assertFixedInputConsistency(
  input: ReportCardsFixedInput,
  options: { verifyBaseInputGenerationId: boolean; navAssetIds?: ReadonlySet<string> } = { verifyBaseInputGenerationId: true },
): void {
  assertCommonFixedInputConsistency(input, {
    phase: "identity",
    laneLabel: "Fixed input",
    exactLabel: "Exact fixed input",
    requireProducerBindings: input.captureKind === "exact-publication-inputs",
    validateNavPriceIds: input.captureKind === "exact-publication-inputs",
    navAssetIds: options.navAssetIds,
    ...(input.captureKind === "exact-publication-inputs"
      ? { dexActiveRowsLabel: "Exact fixed input DEX active rows" }
      : {}),
  });
  if (input.captureKind === "exact-publication-inputs") {
    assertSameIds(
      Object.keys(input.resolvedBlacklistStatuses),
      input.activeAssetIds,
      "Exact fixed input blacklist rows",
    );
    const dexRowsMissingMethodology = Object.entries(input.dexLiqMap).flatMap(([id, row]) =>
      row.methodologyVersion?.trim() ? [] : [id],
    );
    if (dexRowsMissingMethodology.length > 0) {
      throw new Error(`Exact fixed input DEX rows lack producer methodology: ${dexRowsMissingMethodology.join(",")}`);
    }
    const projectedMethodologyVersions = projectReportCardsFixedInputMethodologyVersions({
      methodologyVersion: input.methodologyVersion,
      dexLiqMap: input.dexLiqMap,
      pegDataById: input.pegDataById,
      redemptionBackstopMap: input.redemptionBackstopMap,
    });
    if (stableJsonStringifyV1(input.inputMethodologyVersions) !== stableJsonStringifyV1(projectedMethodologyVersions)) {
      throw new Error("Exact fixed input producer methodology versions do not match its score-bearing payload rows");
    }
  }
  assertCommonFixedInputConsistency(input, {
    phase: "evidence",
    laneLabel: "Fixed input",
    exactLabel: "Exact fixed input",
    requireProducerBindings: input.captureKind === "exact-publication-inputs",
    validateNavPriceIds: false,
  });
  // Integrity gate: a *supplied* base generation id must match the payload it
  // claims to identify. Skipped only when this same call just derived the id
  // from the identical payload, where the comparison is true by construction.
  if (options.verifyBaseInputGenerationId) {
    const expectedBaseInputGenerationId = deriveReportCardsBaseInputGenerationId(input);
    if (input.baseInputGenerationId !== expectedBaseInputGenerationId) {
      throw new Error(
        `Fixed input base generation ${input.baseInputGenerationId} does not match payload ${expectedBaseInputGenerationId}`,
      );
    }
  }
  assertCommonFixedInputConsistency(input, {
    phase: "freshness",
    laneLabel: "Fixed input",
    exactLabel: "Exact fixed input",
    requireProducerBindings: input.captureKind === "exact-publication-inputs",
    validateNavPriceIds: false,
  });
}
export function normalizeFixedInput(value: unknown, navAssetIds?: ReadonlySet<string>): ReportCardsFixedInput {
  const parsed = ReportCardsFixedInputIntakeSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Malformed fixed report-card input at ${issue?.path.join(".") || "root"}: ${issue?.message}`);
  }
  const input = parsed.data;
  const redemptionBackstopMap = normalizeFixedRedemptionBackstopMap(input.redemptionBackstopMap);
  const { baseInputGenerationId: suppliedBaseInputGenerationId, ...inputPayload } = input;
  const normalizedPayload: LegacyReportCardsFixedInputV3 = {
    ...inputPayload,
    activeAssetIds: [...input.activeAssetIds].sort(),
    inputMethodologyVersions: normalizeReportCardsFixedInputMethodologyVersions(input.inputMethodologyVersions),
    ...normalizeCommonFixedInputRecords(input),
    dexLiqMap: normalizeFixedDexLiquidityMap(input.dexLiqMap),
    redemptionBackstopMap,
    collateralDriftCoins: [...input.collateralDriftCoins].sort((left, right) => compareCodeUnits(left.id, right.id)),
  };
  const normalized: ReportCardsFixedInput = {
    ...normalizedPayload,
    baseInputGenerationId:
      suppliedBaseInputGenerationId ?? deriveReportCardsBaseInputGenerationId(normalizedPayload),
  };
  assertFixedInputConsistency(normalized, {
    verifyBaseInputGenerationId: suppliedBaseInputGenerationId !== undefined,
    navAssetIds,
  });
  return normalized;
}
