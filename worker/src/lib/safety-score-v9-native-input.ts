import { z } from "zod";
import { PegSummaryCoinSchema } from "@shared/types/market";
import {
  DexExitRouteObservationSchema,
  ExitRouteObservationCoverageSchema,
} from "@shared/types/market";
import { RedemptionBackstopMapSchema } from "@shared/types/redemption";
import { ReserveSliceSchema } from "@shared/types/reserves";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  ReportCardsFixedInputMethodologyVersionsSchema,
  computeRedemptionPayloadFingerprint,
  normalizeFixedInputExitRouteObservations,
  normalizeFixedRedemptionBackstopMap,
  normalizeReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import { sha256Hex } from "@shared/lib/sha256";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  SafetyScoreV9InputIdentitySchema,
  type SafetyScoreV9InputIdentity,
} from "@shared/types/safety-score-publication";
import { ReportCardEvidenceJournalByIdV1Schema } from "@shared/lib/report-card-evidence-journal";
import { SupplyAttributionJournalByIdV1Schema } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import {
  DexDeploymentSupplyCoverageSchema,
  FreshnessEntrySchema,
  NavPriceObservationSchema,
  SafetyScoreV9SupplyAttributionSchema,
  normalizeFixedInput,
  type ReportCardsFixedInput,
} from "./report-cards-fixed-input";
import {
  projectSafetyScoreV9PegScoreResult,
  projectSafetyScoreV9PegSummary,
  SafetyScoreV9PegProvenanceSummarySchema,
} from "./safety-score-v9-peg-provenance";
import {
  normalizeReviewedDeploymentAttribution,
  reviewedDeploymentAttributionValidationError,
} from "./safety-score-v9-supply-attribution-contract";
import {
  normalizeXautRepresentationGroupAttribution,
  XAUT_ASSET_ID,
  xautRepresentationGroupAttributionValidationError,
} from "./safety-score-v9-xaut-supply-attribution-contract";
import { V9PublicationInputHealthSchema } from "./safety-score-v9-publication-assessment";
import { parseJson } from "./json-parse";

/**
 * DEX liquidity row as the native V9 capture carries it. The V8 report-card
 * projection needed the full producer row (scores, HHI, coverage counts, TVL);
 * the V9 compiler reads exactly these three fields, so nothing else enters a
 * score-bearing capture. Field schemas are copied verbatim from
 * `FixedDexLiquidityRowSchema` so a v3 row stays structurally assignable.
 */
export const NativeDexLiquidityRowSchema = z
  .object({
    exitRouteObservations: z.array(DexExitRouteObservationSchema).nullable().optional(),
    exitRouteObservationCoverage: ExitRouteObservationCoverageSchema.optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (!row.exitRouteObservations || !row.exitRouteObservationCoverage) return;
    const eligibleObservationCount = row.exitRouteObservations.filter(
      (observation) => observation.scoreEligible,
    ).length;
    if (row.exitRouteObservationCoverage.observationCount !== row.exitRouteObservations.length) {
      ctx.addIssue({
        code: "custom",
        path: ["exitRouteObservationCoverage", "observationCount"],
        message: "coverage observation count does not match DEX observations",
      });
    }
    if (row.exitRouteObservationCoverage.scoreEligibleObservationCount !== eligibleObservationCount) {
      ctx.addIssue({
        code: "custom",
        path: ["exitRouteObservationCoverage", "scoreEligibleObservationCount"],
        message: "coverage eligible-observation count does not match DEX observations",
      });
    }
  });

export type NativeDexLiquidityRow = z.infer<typeof NativeDexLiquidityRowSchema>;

const NativeChainCirculatingRowSchema = z
  .object({
    // Only the current USD bucket is score-bearing. The prev-day/week/month
    // buckets exist for the market table's deltas and never reach the V9
    // compiler, so they are not admissible capture bytes.
    current: z.number().finite().nonnegative(),
  })
  .strict();

const NativeSafetyScoreV9InputPayloadFields = {
  capturedAt: z.string().datetime(),
  sourceGeneration: z.string().min(1),
  registryRevision: z.string().min(1),
  methodologyVersion: z.string().min(1),
  clockSec: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  liquidityStale: z.boolean(),
  redemptionStale: z.boolean(),
  inputFreshness: z.object({
    dexLiquidity: FreshnessEntrySchema,
    redemptionBackstops: FreshnessEntrySchema,
  }),
  v9PublicationInputHealth: V9PublicationInputHealthSchema,
  pegDataById: z.record(z.string(), PegSummaryCoinSchema),
  // NAV observations support route-output valuation only. They remain separate
  // from peg rows because NAV tokens have no fixed peg deviation to score.
  navPriceById: z.record(z.string(), NavPriceObservationSchema).optional(),
  activeDepegPeakBpsById: z.record(z.string(), z.number().finite().nonnegative()),
  redemptionBackstopMap: RedemptionBackstopMapSchema,
  liveReserveMap: z.record(z.string(), z.array(ReserveSliceSchema)),
  liveReserveProvenanceMap: z.record(
    z.string(),
    z.object({ source: z.string().min(1), fetchedAt: z.number().int().nonnegative() }),
  ),
  chainCirculatingById: z
    .record(z.string(), z.record(z.string(), NativeChainCirculatingRowSchema))
    .default({}),
  // Top-level USD circulating buckets, carried beside the per-chain map because
  // the supplemental/fallback intake lanes populate only the aggregate. Values
  // are already USD-denominated (DefiLlama list semantics); never multiply by
  // price.
  aggregateCirculatingById: z
    .record(
      z.string(),
      z.object({
        circulating: z.record(z.string(), z.number().finite().nonnegative()),
        observedAtSec: z.number().int().nonnegative().nullable(),
      }),
    )
    .default({}),
  // V9-only supply attribution remains separate from chainCirculatingById:
  // the latter belongs to the exact prepared base input and must stay immutable.
  safetyScoreV9SupplyAttributionById: z
    .record(z.string(), SafetyScoreV9SupplyAttributionSchema)
    .default({}),
  // Diagnostic-only producer provenance. Carried in the private V9 envelope but
  // intentionally excluded from every score-bearing identity.
  evidenceJournalById: ReportCardEvidenceJournalByIdV1Schema.default({}),
  supplyAttributionJournalById: SupplyAttributionJournalByIdV1Schema.default({}),
  // V9-only historical peg evidence quality. Raw depeg events never enter the
  // capture; only canonical score-neutral summaries and their digests do.
  pegProvenanceById: z
    .record(z.string(), SafetyScoreV9PegProvenanceSummarySchema)
    .default({}),
  dexDeploymentSupplyCoverageById: z.record(z.string(), DexDeploymentSupplyCoverageSchema).default({}),
  liveToFallbackCoins: z.array(z.string()).default([]),
};

/**
 * Schema v4: the native Safety Score V9 input. Everything the V8 report-card
 * projection needed and the V9 compiler does not read is gone — `bluechipMap`,
 * `resolvedBlacklistStatuses`, `collateralDriftCoins`, the non-current chain
 * circulating buckets, and every DEX row field outside the exit-route
 * observations.
 */
export const NativeSafetyScoreV9InputSchema = z
  .object({
    schemaVersion: z.literal(4),
    captureKind: z.literal("native-v9-inputs"),
    ...NativeSafetyScoreV9InputPayloadFields,
    activeAssetIds: z.array(z.string().min(1)),
    dexGenerationId: z.string().min(1),
    redemptionGenerationId: z.string().min(1),
    dexPayloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    redemptionPayloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    registryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    inputMethodologyVersions: ReportCardsFixedInputMethodologyVersionsSchema,
    dexLiqMap: z.record(z.string(), NativeDexLiquidityRowSchema),
    baseInputGenerationId: z.string().regex(/^report-cards-input:v2:[a-f0-9]{64}$/),
  })
  .strict();

export type NativeSafetyScoreV9Input = z.infer<typeof NativeSafetyScoreV9InputSchema>;

/**
 * The structural input the V9 compiler accepts. The native v4 capture is the
 * production shape; the retained v3 exact fixed input is structurally a
 * superset of it and stays admissible so frozen v3 captures keep replaying
 * byte-for-byte through the same pipeline.
 */
export type SafetyScoreV9CompilerInput = Omit<
  NativeSafetyScoreV9Input,
  "schemaVersion" | "captureKind"
> & {
  schemaVersion: 3 | 4;
  captureKind: "exact-publication-inputs" | "public-reconstruction" | "native-v9-inputs";
};

export const NATIVE_V9_INPUT_CACHE_KEY = "report-cards:fixed-input:exact";
const NATIVE_V9_INPUT_CACHE_MAX_BYTES = 1_900_000;

export const NATIVE_V9_BASE_INPUT_GENERATION_ID_PREFIX = "report-cards-input:v2:";
const NATIVE_V9_BASE_INPUT_DIGEST_DOMAIN = "report-cards.native-v9-base-input.v2";

/**
 * Envelope v2. Same transport as v1 (gzip + base64 + payload checksum), but the
 * capture identity is required and is the native `v9-input` identity: a v2
 * envelope can never carry an unidentified or a V8-shaped capture.
 */
const NativeV9InputCacheEnvelopeSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("report-cards-fixed-input-exact"),
  encoding: z.literal("gzip-base64"),
  sourceGeneration: z.string().min(1),
  safetyScoreIdentity: SafetyScoreV9InputIdentitySchema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  uncompressedBytes: z.number().int().positive(),
  payload: z.string().min(1),
});

/** Fields excluded from the v2 base-input digest. */
type NativeV9BaseInputDigestSource = Omit<
  NativeSafetyScoreV9Input,
  "baseInputGenerationId"
> & { baseInputGenerationId?: string };

/**
 * `report-cards-input:v2:<sha256>` over the canonicalized payload minus the
 * generation id itself and minus every V9-enrichment field.
 *
 * The four enrichment fields are excluded for the same reason the v1 lane
 * excluded them: the compute cron layers supply attribution, both journals, and
 * the peg-provenance seed onto the accepted capture, and the runner then proves
 * the base input did not move. If enrichment shifted the digest that proof
 * could never hold.
 */
export function deriveNativeV9BaseInputGenerationId(input: NativeV9BaseInputDigestSource): string {
  const {
    baseInputGenerationId: _generationId,
    safetyScoreV9SupplyAttributionById: _supplyAttribution,
    evidenceJournalById: _evidenceJournal,
    supplyAttributionJournalById: _supplyAttributionJournal,
    pegProvenanceById: _pegProvenance,
    ...baseInput
  } = input;
  const digest = sha256Hex(
    stableJsonStringifyV1({ domain: NATIVE_V9_BASE_INPUT_DIGEST_DOMAIN, payload: baseInput }),
  );
  return `${NATIVE_V9_BASE_INPUT_GENERATION_ID_PREFIX}${digest}`;
}

const NATIVE_V9_DEX_PAYLOAD_DIGEST_DOMAIN = "safety-score-v9.native-input.dex-payload.v1";

function normalizeNativeDexLiquidityMap(
  record: Record<string, NativeDexLiquidityRow>,
): Record<string, NativeDexLiquidityRow> {
  return sortedRecord(
    Object.fromEntries(
      Object.entries(record).map(([id, row]) => [
        id,
        {
          ...row,
          ...(row.exitRouteObservations !== undefined
            ? { exitRouteObservations: normalizeFixedInputExitRouteObservations(row.exitRouteObservations) }
            : {}),
        },
      ]),
    ),
  );
}

/**
 * Payload fingerprint over the native DEX rows. It cannot reuse the v3 helper:
 * that one re-parses every row through `FixedDexLiquidityRowSchema`, which
 * still requires the V8 scoring fields the native capture drops.
 */
export function computeNativeDexLiquidityPayloadFingerprint(
  dexLiqMap: Record<string, NativeDexLiquidityRow>,
  dexGenerationId: string,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: NATIVE_V9_DEX_PAYLOAD_DIGEST_DOMAIN,
      dexGenerationId,
      dexLiqMap: normalizeNativeDexLiquidityMap(dexLiqMap),
    }),
  );
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function assertSameIds(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    const expectedSet = new Set(expectedSorted);
    const actualSet = new Set(actualSorted);
    throw new Error(
      `${label} mismatch: missing=${expectedSorted.filter((id) => !actualSet.has(id)).join(",") || "none"}; ` +
        `unexpected=${actualSorted.filter((id) => !expectedSet.has(id)).join(",") || "none"}`,
    );
  }
}

function assertNativeFreshnessConsistency(input: NativeSafetyScoreV9Input): void {
  const dexFreshness = input.inputFreshness.dexLiquidity;
  const dexTimestamps = uniqueSorted(Object.values(input.dexLiqMap).map((row) => String(row.updatedAt)));
  if (dexTimestamps.length !== 1 || Number(dexTimestamps[0]) !== dexFreshness.updatedAt) {
    throw new Error("Native V9 input DEX rows do not match the DEX freshness generation");
  }
  const expectedDexGeneration = `dex-liquidity-${dexFreshness.updatedAt}`;
  if (input.dexGenerationId !== expectedDexGeneration) {
    throw new Error(
      `Native V9 input DEX generation ${input.dexGenerationId} does not match active-row generation ${expectedDexGeneration}`,
    );
  }

  const redemptionFreshness = input.inputFreshness.redemptionBackstops;
  const hasRedemptionRows = Object.keys(input.redemptionBackstopMap).length > 0;
  if (hasRedemptionRows) {
    const redemptionTimestamps = uniqueSorted(
      Object.values(input.redemptionBackstopMap).map((row) => String(row.updatedAt)),
    );
    if (redemptionTimestamps.length !== 1 || Number(redemptionTimestamps[0]) !== redemptionFreshness.updatedAt) {
      throw new Error("Native V9 input redemption rows do not match the redemption freshness generation");
    }
  } else if (!redemptionFreshness.stale) {
    throw new Error("Native V9 input has no redemption rows but marks redemption freshness as current");
  }
  if (
    (hasRedemptionRows && !input.redemptionGenerationId.startsWith("redemption:")) ||
    (!hasRedemptionRows && input.redemptionGenerationId !== "redemption-backstops-unavailable")
  ) {
    throw new Error(`Native V9 input redemption generation ${input.redemptionGenerationId} is not producer-bound`);
  }
  if (input.liquidityStale !== dexFreshness.stale || input.redemptionStale !== redemptionFreshness.stale) {
    throw new Error("Native V9 input top-level freshness flags do not match lane freshness");
  }

  for (const [lane, freshness] of Object.entries(input.inputFreshness)) {
    if (freshness.updatedAt != null && freshness.updatedAt > input.clockSec) {
      throw new Error(
        `Native V9 input ${lane} producer timestamp ${freshness.updatedAt} is later than scoring clock ${input.clockSec}`,
      );
    }
    if (freshness.updatedAt == null || freshness.ageSeconds == null) {
      if (!freshness.stale) throw new Error(`Native V9 input ${lane} freshness is incomplete but not stale`);
      continue;
    }
    const expectedAge = input.clockSec - freshness.updatedAt;
    if (freshness.ageSeconds !== expectedAge) {
      throw new Error(
        `Native V9 input ${lane} age ${freshness.ageSeconds} does not match clock-derived age ${expectedAge}`,
      );
    }
  }
}

function assertNativeV9InputConsistency(input: NativeSafetyScoreV9Input): void {
  if (new Set(input.activeAssetIds).size !== input.activeAssetIds.length) {
    throw new Error("Native V9 input active asset identities contain duplicates");
  }
  const invalidNavPriceIds = Object.keys(input.navPriceById ?? {}).filter(
    (id) => ACTIVE_STABLECOINS.find((coin) => coin.id === id)?.flags.navToken !== true,
  );
  if (invalidNavPriceIds.length > 0) {
    throw new Error(`Native V9 input NAV price rows target non-NAV assets: ${invalidNavPriceIds.join(",")}`);
  }
  assertSameIds(Object.keys(input.dexLiqMap), input.activeAssetIds, "Native V9 input DEX active rows");

  const currentDexPayloadFingerprint = computeNativeDexLiquidityPayloadFingerprint(
    input.dexLiqMap,
    input.dexGenerationId,
  );
  if (input.dexPayloadFingerprint !== currentDexPayloadFingerprint) {
    throw new Error(
      `Native V9 input DEX payload fingerprint ${input.dexPayloadFingerprint} does not match payload ${currentDexPayloadFingerprint}`,
    );
  }
  const currentRedemptionPayloadFingerprint = computeRedemptionPayloadFingerprint(
    input.redemptionBackstopMap,
    input.redemptionGenerationId,
  );
  if (input.redemptionPayloadFingerprint !== currentRedemptionPayloadFingerprint) {
    throw new Error(
      `Native V9 input redemption payload fingerprint ${input.redemptionPayloadFingerprint} does not match payload ${currentRedemptionPayloadFingerprint}`,
    );
  }

  for (const [assetId, attribution] of Object.entries(input.safetyScoreV9SupplyAttributionById)) {
    if (!input.activeAssetIds.includes(assetId)) {
      throw new Error(`V9 supply attribution targets inactive asset ${assetId}`);
    }
    if (attribution.model !== "reviewed-deployment-unit-partition-v1" && attribution.observedAtSec > input.clockSec) {
      throw new Error(`V9 supply attribution for ${assetId} is later than the scoring clock`);
    }
    if (assetId === XAUT_ASSET_ID && attribution.model === "canonical-lock-mint-partition-v1") {
      throw new Error("Legacy XAUT lock/mint attribution is no longer admissible; a reconciled V2 packet is required");
    }
    const aggregate = input.aggregateCirculatingById[assetId];
    const aggregateSupplyUsd = Object.values(aggregate?.circulating ?? {}).reduce((sum, value) => sum + value, 0);
    const attributedSupplyUsd =
      attribution.model === "canonical-lock-mint-partition-v1"
        ? Object.values(attribution.currentSupplyUsdByChain).reduce((sum, value) => sum + value, 0)
        : attribution.model === "canonical-lock-mint-group-partition-v2"
          ? attribution.canonical.currentSupplyUsd + attribution.representationGroup.currentSupplyUsd
          : attribution.deployments.reduce((sum, deployment) => sum + deployment.currentSupplyUsd, 0);
    const toleranceUsd = Math.max(0.000001, aggregateSupplyUsd * 1e-12);
    if (aggregateSupplyUsd <= 0 || Math.abs(attributedSupplyUsd - aggregateSupplyUsd) > toleranceUsd) {
      throw new Error(`V9 supply attribution for ${assetId} does not conserve aggregate circulating USD`);
    }
    if (attribution.model === "reviewed-deployment-unit-partition-v1") {
      const validationError = reviewedDeploymentAttributionValidationError({
        assetId,
        attribution,
        aggregateSupplyUsd,
        registryFingerprint: input.registryFingerprint,
        clockSec: input.clockSec,
      });
      if (validationError) throw new Error(validationError);
    } else if (attribution.model === "canonical-lock-mint-group-partition-v2") {
      if (attribution.assetId !== assetId) {
        throw new Error(`V9 supply attribution key ${assetId} does not match packet asset ${attribution.assetId}`);
      }
      const validationError = xautRepresentationGroupAttributionValidationError({
        attribution,
        aggregateSupplyUsd,
        registryFingerprint: input.registryFingerprint,
        clockSec: input.clockSec,
      });
      if (validationError) throw new Error(validationError);
    }
  }
  for (const [assetId, records] of Object.entries(input.evidenceJournalById)) {
    if (!input.activeAssetIds.includes(assetId)) {
      throw new Error(`Evidence journal targets inactive asset ${assetId}`);
    }
    for (const record of records) {
      if (record.completedAtSec > input.clockSec) {
        throw new Error(`Evidence journal for ${assetId} is later than the scoring clock`);
      }
    }
  }
  for (const [assetId, records] of Object.entries(input.supplyAttributionJournalById)) {
    if (!input.activeAssetIds.includes(assetId)) {
      throw new Error(`Supply attribution journal targets inactive asset ${assetId}`);
    }
    for (const record of records) {
      if (record.completedAtSec > input.clockSec) {
        throw new Error(`Supply attribution journal for ${assetId} is later than the scoring clock`);
      }
    }
  }
  const pegProvenanceIds = Object.keys(input.pegProvenanceById);
  if (pegProvenanceIds.length > 0) {
    assertSameIds(pegProvenanceIds, Object.keys(input.pegDataById), "V9 peg provenance rows");
  }
  for (const [assetId, summary] of Object.entries(input.pegProvenanceById)) {
    const pegSummary = input.pegDataById[assetId];
    if (!pegSummary || summary.assetId !== assetId) {
      throw new Error(`V9 peg provenance does not match peg row ${assetId}`);
    }
    if (
      summary.clockSec !== input.clockSec ||
      summary.trackingStartSec !== (pegSummary.historyCoverage?.startedAt ?? null)
    ) {
      throw new Error(`V9 peg provenance clock/coverage does not match peg row ${assetId}`);
    }
    if (
      stableJsonStringifyV1(projectSafetyScoreV9PegScoreResult(summary.legacyInclusive.result)) !==
      stableJsonStringifyV1(projectSafetyScoreV9PegSummary(pegSummary))
    ) {
      throw new Error(`V9 peg provenance score does not match peg row ${assetId}`);
    }
  }
  const expectedBaseInputGenerationId = deriveNativeV9BaseInputGenerationId(input);
  if (input.baseInputGenerationId !== expectedBaseInputGenerationId) {
    throw new Error(
      `Native V9 input base generation ${input.baseInputGenerationId} does not match payload ${expectedBaseInputGenerationId}`,
    );
  }
  assertNativeFreshnessConsistency(input);
}

/** Canonicalizes record ordering, derives the base generation id, and validates. */
export function normalizeNativeV9Input(value: unknown): NativeSafetyScoreV9Input {
  const parsed = NativeSafetyScoreV9InputSchema.omit({ baseInputGenerationId: true })
    .extend({ baseInputGenerationId: z.string().optional() })
    .safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Malformed native V9 input at ${issue?.path.join(".") || "root"}: ${issue?.message}`);
  }
  const input = parsed.data;
  const normalizedPayload = {
    ...input,
    activeAssetIds: [...input.activeAssetIds].sort(),
    inputMethodologyVersions: normalizeReportCardsFixedInputMethodologyVersions(input.inputMethodologyVersions),
    pegDataById: sortedRecord(input.pegDataById),
    ...(input.navPriceById ? { navPriceById: sortedRecord(input.navPriceById) } : {}),
    activeDepegPeakBpsById: sortedRecord(input.activeDepegPeakBpsById),
    dexLiqMap: normalizeNativeDexLiquidityMap(input.dexLiqMap),
    redemptionBackstopMap: normalizeFixedRedemptionBackstopMap(input.redemptionBackstopMap),
    liveReserveMap: sortedRecord(input.liveReserveMap),
    liveReserveProvenanceMap: sortedRecord(input.liveReserveProvenanceMap),
    chainCirculatingById: sortedRecord(input.chainCirculatingById),
    aggregateCirculatingById: sortedRecord(input.aggregateCirculatingById),
    safetyScoreV9SupplyAttributionById: sortedRecord(
      Object.fromEntries(
        Object.entries(input.safetyScoreV9SupplyAttributionById).map(([assetId, attribution]) => [
          assetId,
          attribution.model === "canonical-lock-mint-partition-v1"
            ? { ...attribution, currentSupplyUsdByChain: sortedRecord(attribution.currentSupplyUsdByChain) }
            : attribution.model === "canonical-lock-mint-group-partition-v2"
              ? normalizeXautRepresentationGroupAttribution(attribution)
              : normalizeReviewedDeploymentAttribution(attribution),
        ]),
      ),
    ),
    evidenceJournalById: ReportCardEvidenceJournalByIdV1Schema.parse(input.evidenceJournalById),
    supplyAttributionJournalById: SupplyAttributionJournalByIdV1Schema.parse(input.supplyAttributionJournalById),
    pegProvenanceById: sortedRecord(input.pegProvenanceById),
    dexDeploymentSupplyCoverageById: sortedRecord(input.dexDeploymentSupplyCoverageById),
    liveToFallbackCoins: [...input.liveToFallbackCoins].sort(),
  };
  const normalized = NativeSafetyScoreV9InputSchema.parse({
    ...normalizedPayload,
    baseInputGenerationId:
      input.baseInputGenerationId ?? deriveNativeV9BaseInputGenerationId(normalizedPayload),
  });
  assertNativeV9InputConsistency(normalized);
  return normalized;
}

function isNativeV9InputShape(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 4
  );
}

/**
 * Normalizes either the native v4 capture or a retained v3 exact fixed input.
 * The v3 branch is the frozen-capture replay lane and delegates to the legacy
 * normalizer unchanged, so historical captures keep replaying byte-for-byte.
 */
export function normalizeSafetyScoreV9CompilerInput(value: unknown): SafetyScoreV9CompilerInput {
  if (isNativeV9InputShape(value)) return normalizeNativeV9Input(value);
  return normalizeFixedInput(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(Uint8Array.from(bytes)).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes: Uint8Array): Promise<string> {
  const stream = new Response(Uint8Array.from(bytes)).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export async function buildNativeV9InputCacheEntry(
  value: unknown,
  safetyScoreIdentity: SafetyScoreV9InputIdentity,
): Promise<{ key: string; value: string; storedBytes: number; uncompressedBytes: number }> {
  const input = normalizeNativeV9Input(value);
  const identity = SafetyScoreV9InputIdentitySchema.parse(safetyScoreIdentity);
  if (
    identity.baseInputGenerationId !== input.baseInputGenerationId ||
    identity.methodologyVersion !== input.methodologyVersion ||
    identity.publicationGenerationId !== input.sourceGeneration
  ) {
    throw new Error("Native V9 input does not match its capture identity");
  }
  const {
    safetyScoreV9SupplyAttributionById: _v9SupplyAttribution,
    evidenceJournalById: _evidenceJournal,
    supplyAttributionJournalById: _supplyAttributionJournal,
    pegProvenanceById: _pegProvenance,
    ...baseInput
  } = input;
  const payload = JSON.stringify(baseInput);
  const uncompressedBytes = new TextEncoder().encode(payload);
  const compressed = await gzipBytes(uncompressedBytes);
  const envelope = JSON.stringify({
    schemaVersion: 2,
    kind: "report-cards-fixed-input-exact",
    encoding: "gzip-base64",
    sourceGeneration: input.sourceGeneration,
    safetyScoreIdentity: identity,
    payloadSha256: sha256Hex(payload),
    uncompressedBytes: uncompressedBytes.byteLength,
    payload: bytesToBase64(compressed),
  });
  const storedBytes = new TextEncoder().encode(envelope).byteLength;
  if (storedBytes > NATIVE_V9_INPUT_CACHE_MAX_BYTES) {
    throw new Error(
      `Native V9 input cache artifact is ${storedBytes} bytes; maximum is ${NATIVE_V9_INPUT_CACHE_MAX_BYTES}`,
    );
  }
  return {
    key: NATIVE_V9_INPUT_CACHE_KEY,
    value: envelope,
    storedBytes,
    uncompressedBytes: uncompressedBytes.byteLength,
  };
}

export interface NativeV9InputCacheArtifact {
  input: NativeSafetyScoreV9Input;
  safetyScoreIdentity: SafetyScoreV9InputIdentity;
}

export async function parseNativeV9InputCacheArtifact(value: unknown): Promise<NativeV9InputCacheArtifact> {
  const parsedEnvelope = typeof value === "string" ? parseJson(value) : null;
  if (parsedEnvelope && !parsedEnvelope.ok) {
    throw new Error(`Malformed native V9 input cache envelope: ${parsedEnvelope.message}`);
  }
  const raw = parsedEnvelope?.ok ? parsedEnvelope.value : value;
  const envelope = NativeV9InputCacheEnvelopeSchema.parse(raw);
  const payload = await gunzipText(base64ToBytes(envelope.payload));
  if (new TextEncoder().encode(payload).byteLength !== envelope.uncompressedBytes) {
    throw new Error("Native V9 input cache artifact byte length does not match its envelope");
  }
  if (sha256Hex(payload) !== envelope.payloadSha256) {
    throw new Error("Native V9 input cache artifact checksum mismatch");
  }
  const parsedPayload = parseJson(payload);
  if (!parsedPayload.ok) {
    throw new Error(`Malformed native V9 input cache payload: ${parsedPayload.message}`);
  }
  const input = normalizeNativeV9Input(parsedPayload.value);
  if (input.sourceGeneration !== envelope.sourceGeneration) {
    throw new Error("Native V9 input cache generation mismatch");
  }
  if (
    envelope.safetyScoreIdentity.baseInputGenerationId !== input.baseInputGenerationId ||
    envelope.safetyScoreIdentity.methodologyVersion !== input.methodologyVersion ||
    envelope.safetyScoreIdentity.publicationGenerationId !== input.sourceGeneration
  ) {
    throw new Error("Native V9 input cache identity mismatch");
  }
  return { input, safetyScoreIdentity: envelope.safetyScoreIdentity };
}

export async function parseNativeV9InputCacheValue(value: unknown): Promise<NativeSafetyScoreV9Input> {
  return (await parseNativeV9InputCacheArtifact(value)).input;
}
