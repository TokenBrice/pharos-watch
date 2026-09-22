import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  computeDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
  normalizeFixedDexLiquidityMap,
  normalizeFixedRedemptionBackstopMap,
  projectFixedDexLiquidityMap,
  projectReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import {
  SafetyScoreV8PublicationIdentitySchema,
  type SafetyScoreV8PublicationIdentity,
} from "@shared/types/safety-score-publication";
import { buildFixedInputCacheEntry } from "../lib/report-cards-fixed-input-cache-codec";
import {
  normalizeFixedInput,
  type ReportCardsFixedInput,
} from "../lib/report-cards-fixed-input";

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
  aggregateCirculatingById?: ReportCardsFixedInput["aggregateCirculatingById"];
  safetyScoreV9SupplyAttributionById?: ReportCardsFixedInput["safetyScoreV9SupplyAttributionById"];
  evidenceJournalById?: ReportCardsFixedInput["evidenceJournalById"];
  supplyAttributionJournalById?: ReportCardsFixedInput["supplyAttributionJournalById"];
  pegProvenanceById?: ReportCardsFixedInput["pegProvenanceById"];
  v9PublicationInputHealth?: ReportCardsFixedInput["v9PublicationInputHealth"];
};

/** Builds a retained v3 capture for replay and fixture tests. */
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

/** Mints the retired v1 cache envelope used by replay compatibility tests. */
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
