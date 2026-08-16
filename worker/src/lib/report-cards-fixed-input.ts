import { z } from "zod";
import { BluechipRatingsMapSchema } from "@shared/types/bluechip";
import { stableJsonStringifyV1 } from "@shared/lib/depeg-resolver/hash";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import {
  FixedDexLiquidityRowSchema,
  ReportCardsFixedInputMethodologyVersionsSchema,
  computeDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
  normalizeFixedDexLiquidityMap,
  normalizeFixedRedemptionBackstopMap,
  normalizeReportCardsFixedInputMethodologyVersions,
  projectFixedDexLiquidityMap,
  projectReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  SafetyScoreV8PublicationIdentitySchema,
  type SafetyScoreV8PublicationIdentity,
} from "@shared/types/safety-score-publication";
import { BaseInputGenerationIdSchema, Sha256Schema } from "@shared/types/safety-schema-primitives";
import {
  assertCommonFixedInputConsistency,
  assertSameIds,
  createFixedInputPayloadFields,
  DexDeploymentSupplyCoverageSchema,
  FreshnessEntrySchema,
  NavPriceObservationSchema,
  normalizeCommonFixedInputRecords,
  SafetyScoreV9SupplyAttributionSchema,
  type DexDeploymentSupplyCoverage,
} from "./report-cards-fixed-input-contract";
import {
  buildFixedInputCacheEntry,
  FixedInputCacheEnvelopeFields,
  parseFixedInputCacheEntry,
  REPORT_CARDS_FIXED_INPUT_CACHE_KEY,
} from "./report-cards-fixed-input-cache-codec";
import { V9PublicationInputHealthSchema } from "./safety-score-v9-publication-assessment";

export {
  DexDeploymentSupplyCoverageSchema,
  FreshnessEntrySchema,
  NavPriceObservationSchema,
  REPORT_CARDS_FIXED_INPUT_CACHE_KEY,
  SafetyScoreV9SupplyAttributionSchema,
  type DexDeploymentSupplyCoverage,
};

const BlacklistStatusSchema = z.union([z.boolean(), z.literal("possible"), z.literal("inherited")]);

export {
  computeDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
  type FixedDexLiquidityRow,
} from "@shared/lib/report-cards-fixed-input-identity";

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
    liveReserves: { state: "unavailable" },
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

export type ReportCardsFixedInput = z.infer<typeof ReportCardsFixedInputSchema>;
type LegacyReportCardsFixedInputV3 = z.infer<typeof LegacyReportCardsFixedInputV3Schema>;

// The V1 replay envelope and V2 native envelope share their transport fields;
// only their versioned identity requirements differ.
const FixedInputCacheEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  ...FixedInputCacheEnvelopeFields,
  safetyScoreIdentity: SafetyScoreV8PublicationIdentitySchema.optional(),
});

export async function buildReportCardsFixedInputCacheEntry(
  value: unknown,
  safetyScoreIdentity?: SafetyScoreV8PublicationIdentity,
): Promise<{ key: string; value: string; storedBytes: number; uncompressedBytes: number }> {
  const input = normalizeFixedInput(value);
  if (input.captureKind !== "exact-publication-inputs") {
    throw new Error("Only exact publication inputs may be persisted as the P0c cache artifact");
  }
  const identity =
    safetyScoreIdentity === undefined ? undefined : SafetyScoreV8PublicationIdentitySchema.parse(safetyScoreIdentity);
  if (
    identity &&
    (identity.baseInputGenerationId !== input.baseInputGenerationId ||
      identity.methodologyVersion !== input.methodologyVersion ||
      identity.publicationGenerationId !== input.sourceGeneration)
  ) {
    throw new Error("Exact report-card fixed input does not match its Safety Score publication identity");
  }
  const {
    safetyScoreV9SupplyAttributionById: _v9SupplyAttribution,
    evidenceJournalById: _evidenceJournal,
    supplyAttributionJournalById: _supplyAttributionJournal,
    pegProvenanceById: _pegProvenance,
    ...baseInput
  } = input;
  return buildFixedInputCacheEntry({
    schemaVersion: 1,
    sourceGeneration: input.sourceGeneration,
    safetyScoreIdentity: identity,
    payload: baseInput,
    label: "Exact report-card fixed input cache artifact",
  });
}

export interface ReportCardsFixedInputCacheArtifact {
  input: ReportCardsFixedInput;
  safetyScoreIdentity: SafetyScoreV8PublicationIdentity | null;
}

export async function parseReportCardsFixedInputCacheArtifact(
  value: unknown,
): Promise<ReportCardsFixedInputCacheArtifact> {
  const { envelope, payload } = await parseFixedInputCacheEntry({
    value,
    envelopeSchema: FixedInputCacheEnvelopeSchema,
    malformedEnvelopeLabel: "Malformed exact report-card fixed input cache envelope",
    malformedPayloadLabel: "Malformed exact report-card fixed input cache payload",
    artifactLabel: "Exact report-card fixed input cache artifact",
  });
  const input = normalizeFixedInput(payload);
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
  return {
    input,
    safetyScoreIdentity: envelope.safetyScoreIdentity ?? null,
  };
}

export async function parseReportCardsFixedInputCacheValue(value: unknown): Promise<ReportCardsFixedInput> {
  return (await parseReportCardsFixedInputCacheArtifact(value)).input;
}

export type ReportCardsFixedInputDraft = Omit<
  ReportCardsFixedInput,
  | "schemaVersion"
  | "captureKind"
  | "activeAssetIds"
  | "dexPayloadFingerprint"
  | "redemptionPayloadFingerprint"
  | "registryFingerprint"
  | "inputMethodologyVersions"
  | "baseInputGenerationId"
  | "aggregateCirculatingById"
  | "safetyScoreV9SupplyAttributionById"
  | "evidenceJournalById"
  | "supplyAttributionJournalById"
  | "pegProvenanceById"
  | "v9PublicationInputHealth"
> & {
  captureKind: ReportCardsFixedInput["captureKind"];
  activeAssetIds?: string[];
  // Optional so reconstruction and test drafts that carry no aggregate bucket
  // keep compiling; the schema default fills in an empty record.
  aggregateCirculatingById?: ReportCardsFixedInput["aggregateCirculatingById"];
  safetyScoreV9SupplyAttributionById?: ReportCardsFixedInput["safetyScoreV9SupplyAttributionById"];
  evidenceJournalById?: ReportCardsFixedInput["evidenceJournalById"];
  supplyAttributionJournalById?: ReportCardsFixedInput["supplyAttributionJournalById"];
  pegProvenanceById?: ReportCardsFixedInput["pegProvenanceById"];
  v9PublicationInputHealth?: ReportCardsFixedInput["v9PublicationInputHealth"];
};

export function createReportCardsFixedInput(draft: ReportCardsFixedInputDraft): ReportCardsFixedInput {
  const activeAssetIds = [...(draft.activeAssetIds ?? ACTIVE_STABLECOINS.map((coin) => coin.id))].sort();
  const dexLiqMap = normalizeFixedDexLiquidityMap(projectFixedDexLiquidityMap(draft.dexLiqMap));
  const redemptionBackstopMap = normalizeFixedRedemptionBackstopMap(draft.redemptionBackstopMap);
  return normalizeFixedInput({
    ...draft,
    dexLiqMap,
    redemptionBackstopMap,
    schemaVersion: 3,
    activeAssetIds,
    registryFingerprint: computeReportCardsRegistryFingerprint(),
    dexPayloadFingerprint: computeDexLiquidityPayloadFingerprint(dexLiqMap, draft.dexGenerationId),
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint(
      redemptionBackstopMap,
      draft.redemptionGenerationId,
    ),
    inputMethodologyVersions: projectReportCardsFixedInputMethodologyVersions({
      methodologyVersion: draft.methodologyVersion,
      dexLiqMap,
      pegDataById: draft.pegDataById,
      redemptionBackstopMap,
    }),
  });
}

function assertFixedInputConsistency(
  input: ReportCardsFixedInput,
  options: { verifyBaseInputGenerationId: boolean } = { verifyBaseInputGenerationId: true },
): void {
  assertCommonFixedInputConsistency(input, {
    phase: "identity",
    laneLabel: "Fixed input",
    exactLabel: "Exact fixed input",
    requireProducerBindings: input.captureKind === "exact-publication-inputs",
    validateNavPriceIds: input.captureKind === "exact-publication-inputs",
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

function parseReportCardsFixedInput(value: unknown): ReportCardsFixedInput | LegacyReportCardsFixedInputV3 {
  const parsed = ReportCardsFixedInputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const v3 = LegacyReportCardsFixedInputV3Schema.safeParse(value);
  if (v3.success) return v3.data;
  const issue = parsed.error.issues[0];
  throw new Error(`Malformed fixed report-card input at ${issue?.path.join(".") || "root"}: ${issue?.message}`);
}

export function normalizeFixedInput(value: unknown): ReportCardsFixedInput {
  const input = parseReportCardsFixedInput(value);
  const redemptionBackstopMap = normalizeFixedRedemptionBackstopMap(input.redemptionBackstopMap);
  const normalizedPayload: LegacyReportCardsFixedInputV3 = {
    ...input,
    activeAssetIds: [...input.activeAssetIds].sort(),
    inputMethodologyVersions: normalizeReportCardsFixedInputMethodologyVersions(input.inputMethodologyVersions),
    ...normalizeCommonFixedInputRecords(input),
    dexLiqMap: normalizeFixedDexLiquidityMap(input.dexLiqMap),
    redemptionBackstopMap,
    collateralDriftCoins: [...input.collateralDriftCoins].sort((left, right) => left.id.localeCompare(right.id)),
  };
  const suppliedBaseInputGenerationId = "baseInputGenerationId" in input ? input.baseInputGenerationId : undefined;
  const normalized = ReportCardsFixedInputSchema.parse({
    ...normalizedPayload,
    baseInputGenerationId:
      suppliedBaseInputGenerationId ?? deriveReportCardsBaseInputGenerationId(normalizedPayload),
  });
  assertFixedInputConsistency(normalized, {
    verifyBaseInputGenerationId: suppliedBaseInputGenerationId !== undefined,
  });
  return normalized;
}
