import { z } from "zod";
import { BluechipRatingsMapSchema } from "@shared/types/bluechip";
import { DexLiquidityMapSchema, PegSummaryCoinSchema } from "@shared/types/market";
import { RedemptionBackstopMapSchema } from "@shared/types/redemption";
import { ReserveSliceSchema } from "@shared/types/reserves";
import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types/report-cards";
import { stableJsonStringifyV1 } from "@shared/lib/depeg-resolver/hash";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import {
  FixedDexLiquidityRowSchema,
  ReportCardsFixedInputMethodologyVersionsSchema,
  computeDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
  normalizeFixedDexLiquidityMap,
  normalizeFixedInputExitRouteObservations,
  normalizeFixedRedemptionBackstopMap,
  normalizeReportCardsReplayPayload,
  normalizeReportCardsFixedInputMethodologyVersions,
  projectFixedDexLiquidityMap,
  projectReportCardsFixedInputMethodologyVersions,
  type FixedDexLiquidityRow,
} from "@shared/lib/report-cards-fixed-input-identity";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { sha256Hex } from "@shared/lib/sha256";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  SafetyScoreV8PublicationIdentitySchema,
  type SafetyScoreV8PublicationIdentity,
} from "@shared/types/safety-score-publication";
import { ReportCardEvidenceJournalByIdV1Schema } from "@shared/lib/report-card-evidence-journal";
import { SupplyAttributionJournalByIdV1Schema } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import type { DexDeploymentSupplyCoverage } from "@shared/lib/report-card-peg-liquidity";
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
  XautRepresentationGroupSupplyAttributionV2Schema,
  xautRepresentationGroupAttributionValidationError,
} from "./safety-score-v9-xaut-supply-attribution-contract";
import { buildLiveReportCards } from "./report-cards-snapshot-card";
import {
  buildDefunctReportCards,
  buildReportCardsSnapshotEnvelope,
  sortReportCards,
} from "./report-cards-snapshot-finalize";
import { parseJson } from "./json-parse";
import {
  V9PublicationInputHealthSchema,
} from "./safety-score-v9-publication-assessment";

const FreshnessEntrySchema = z.object({
  updatedAt: z.number().finite().nonnegative().nullable(),
  ageSeconds: z.number().finite().nonnegative().nullable(),
  stale: z.boolean(),
});

const BlacklistStatusSchema = z.union([z.boolean(), z.literal("possible"), z.literal("inherited")]);

const NavPriceObservationSchema = z.strictObject({
  priceUsd: z.number().finite().positive(),
  sourceId: z.string().min(1),
  observedAtSec: z.number().int().nonnegative(),
  confidence: z.enum(["high", "medium", "low", "unknown"]),
});

const CanonicalLockMintSupplyAttributionSchema = z.strictObject({
  model: z.literal("canonical-lock-mint-partition-v1"),
  observedAtSec: z.number().int().nonnegative(),
  currentSupplyUsdByChain: z
    .record(z.string().trim().min(1), z.number().finite().positive())
    .refine((rows) => Object.keys(rows).length >= 2, {
      message: "V9 lock/mint attribution requires canonical and pooled supply rows",
    }),
});

const ReviewedDeploymentSupplyRowSchema = z.strictObject({
  routeId: z.string().trim().min(1),
  chainId: z.string().trim().min(1),
  contractAddress: z.string().trim().min(1),
  decimals: z.number().int().min(0).max(36),
  rawSupply: z.string().regex(/^(0|[1-9][0-9]*)$/),
  blockNumberOrSlot: z.string().regex(/^(0|[1-9][0-9]*)$/),
  blockTimeSec: z.number().int().nonnegative(),
  blockHash: z.string().trim().min(1),
  runtimeCodeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  implementationAddress: z.string().trim().min(1).optional(),
  implementationCodeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  underlyingTokenAddress: z.string().trim().min(1).optional(),
  controllerAddress: z.string().trim().min(1).optional(),
  controllerProgramOwner: z.string().trim().min(1).optional(),
  programOwner: z.string().trim().min(1).optional(),
  mintAuthority: z.string().trim().min(1).optional(),
  currentSupplyUsd: z.number().finite().nonnegative(),
});

const ReviewedDeploymentUnitPartitionSchema = z.strictObject({
  model: z.literal("reviewed-deployment-unit-partition-v1"),
  assetId: z.string().trim().min(1),
  observedAtSec: z.number().int().nonnegative(),
  captureStartedAtSec: z.number().int().nonnegative(),
  captureEndedAtSec: z.number().int().nonnegative(),
  registryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  routeInventoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  deployments: z.array(ReviewedDeploymentSupplyRowSchema).min(2),
});

export const SafetyScoreV9SupplyAttributionSchema = z.discriminatedUnion("model", [
  CanonicalLockMintSupplyAttributionSchema,
  XautRepresentationGroupSupplyAttributionV2Schema,
  ReviewedDeploymentUnitPartitionSchema,
]);

const DexDeploymentSupplyCoverageSchema: z.ZodType<DexDeploymentSupplyCoverage> = z.strictObject({
  totalSupplyUsd: z.number().finite().positive(),
  observedSupplyUsd: z.number().finite().nonnegative(),
  verifiedNoPoolsSupplyUsd: z.number().finite().nonnegative(),
  providerInaccessibleSupplyUsd: z.number().finite().nonnegative(),
  unknownSupplyUsd: z.number().finite().nonnegative(),
  observedSupplyRatio: z.number().finite().min(0).max(1),
  verifiedNoPoolsSupplyRatio: z.number().finite().min(0).max(1),
  providerInaccessibleSupplyRatio: z.number().finite().min(0).max(1),
  unknownSupplyRatio: z.number().finite().min(0).max(1),
  unknownChains: z.array(z.string().min(1)),
});

export {
  computeDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint,
  computeReportCardsReplayPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
  normalizeReportCardsReplayPayload,
  type FixedDexLiquidityRow,
} from "@shared/lib/report-cards-fixed-input-identity";

const FixedInputPayloadFields = {
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
  v9PublicationInputHealth: V9PublicationInputHealthSchema.default({
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
  pegDataById: z.record(z.string(), PegSummaryCoinSchema),
  // NAV observations support route-output valuation only. They remain separate
  // from peg rows because NAV tokens have no fixed peg deviation to score.
  navPriceById: z.record(z.string(), NavPriceObservationSchema).optional(),
  activeDepegPeakBpsById: z.record(z.string(), z.number().finite().nonnegative()),
  redemptionBackstopMap: RedemptionBackstopMapSchema,
  bluechipMap: BluechipRatingsMapSchema,
  resolvedBlacklistStatuses: z.record(z.string(), BlacklistStatusSchema),
  liveReserveMap: z.record(z.string(), z.array(ReserveSliceSchema)),
  liveReserveProvenanceMap: z.record(
    z.string(),
    z.object({ source: z.string().min(1), fetchedAt: z.number().int().nonnegative() }),
  ),
  chainCirculatingById: z
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
  // Top-level USD circulating buckets, carried beside the per-chain map because
  // the supplemental/fallback intake lanes populate only the aggregate and
  // hardcode an empty `chainCirculating`. Without this the v9 supply fact has
  // no figure to fall back to for those assets. Values are already
  // USD-denominated (DefiLlama list semantics); never multiply by price.
  // Optional-with-default so captures predating the field parse unchanged.
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
  // Diagnostic-only producer provenance. This is carried in the private V9
  // envelope but intentionally excluded from every score-bearing identity.
  evidenceJournalById: ReportCardEvidenceJournalByIdV1Schema.default({}),
  // Supply-attribution attempts complete after the source snapshot clock, so
  // only prior bounded rows can enter a private V9 exact-input envelope.
  supplyAttributionJournalById:
    SupplyAttributionJournalByIdV1Schema.default({}),
  // V9-only historical peg evidence quality. Raw depeg events never enter the
  // fixed input; only canonical score-neutral summaries and their digests do.
  pegProvenanceById: z
    .record(z.string(), SafetyScoreV9PegProvenanceSummarySchema)
    .default({}),
  dexDeploymentSupplyCoverageById: z.record(z.string(), DexDeploymentSupplyCoverageSchema).default({}),
  collateralDriftCoins: z
    .array(z.object({ id: z.string(), liveScore: z.number(), curatedScore: z.number(), delta: z.number() }))
    .default([]),
  liveToFallbackCoins: z.array(z.string()).default([]),
};

const LegacyReportCardsFixedInputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ...FixedInputPayloadFields,
    dexLiqMap: DexLiquidityMapSchema,
  })
  .strict();

const LegacyReportCardsFixedInputV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...FixedInputPayloadFields,
    dexGenerationId: z.string().min(1),
    dexPayloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    registryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    dexLiqMap: DexLiquidityMapSchema,
  })
  .strict();

const LegacyReportCardsFixedInputV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    ...FixedInputPayloadFields,
    captureKind: z.enum(["exact-publication-inputs", "public-reconstruction"]),
    activeAssetIds: z.array(z.string().min(1)),
    dexGenerationId: z.string().min(1),
    redemptionGenerationId: z.string().min(1),
    dexPayloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    redemptionPayloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    registryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    inputMethodologyVersions: ReportCardsFixedInputMethodologyVersionsSchema,
    dexLiqMap: z.record(z.string(), FixedDexLiquidityRowSchema),
  })
  .strict();

const ReportCardsFixedInputSchema = LegacyReportCardsFixedInputV3Schema.extend({
  baseInputGenerationId: z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/),
}).strict();

export type ReportCardsFixedInput = z.infer<typeof ReportCardsFixedInputSchema>;
type LegacyReportCardsFixedInputV3 = z.infer<typeof LegacyReportCardsFixedInputV3Schema>;

export interface FixedReplayOptions {
  allowMethodologyMismatch?: boolean;
  allowRegistryMismatch?: boolean;
  sameNotionalScoringMode?: "legacy" | "active";
  dexExitObservationMaxAgeSec?: number;
  liveRedemptionExitObservationMaxAgeSec?: number;
}

function recordToMap<T>(record: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(record));
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

export const REPORT_CARDS_FIXED_INPUT_CACHE_KEY = "report-cards:fixed-input:exact";
const REPORT_CARDS_FIXED_INPUT_CACHE_MAX_BYTES = 1_900_000;

const FixedInputCacheEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("report-cards-fixed-input-exact"),
  encoding: z.literal("gzip-base64"),
  sourceGeneration: z.string().min(1),
  safetyScoreIdentity: SafetyScoreV8PublicationIdentitySchema.optional(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  uncompressedBytes: z.number().int().positive(),
  payload: z.string().min(1),
});

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

async function buildFixedInputCacheEntry(
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
  const payload = JSON.stringify(baseInput);
  const uncompressedBytes = new TextEncoder().encode(payload);
  const compressed = await gzipBytes(uncompressedBytes);
  const envelope = JSON.stringify({
    schemaVersion: 1,
    kind: "report-cards-fixed-input-exact",
    encoding: "gzip-base64",
    sourceGeneration: input.sourceGeneration,
    ...(identity ? { safetyScoreIdentity: identity } : {}),
    payloadSha256: sha256Hex(payload),
    uncompressedBytes: uncompressedBytes.byteLength,
    payload: bytesToBase64(compressed),
  });
  const storedBytes = new TextEncoder().encode(envelope).byteLength;
  if (storedBytes > REPORT_CARDS_FIXED_INPUT_CACHE_MAX_BYTES) {
    throw new Error(
      `Exact report-card fixed input cache artifact is ${storedBytes} bytes; maximum is ${REPORT_CARDS_FIXED_INPUT_CACHE_MAX_BYTES}`,
    );
  }
  return {
    key: REPORT_CARDS_FIXED_INPUT_CACHE_KEY,
    value: envelope,
    storedBytes,
    uncompressedBytes: uncompressedBytes.byteLength,
  };
}

export function buildReportCardsFixedInputCacheEntry(
  value: unknown,
  safetyScoreIdentity?: SafetyScoreV8PublicationIdentity,
): Promise<{ key: string; value: string; storedBytes: number; uncompressedBytes: number }> {
  return buildFixedInputCacheEntry(
    value,
    safetyScoreIdentity,
  );
}

export interface ReportCardsFixedInputCacheArtifact {
  input: ReportCardsFixedInput;
  safetyScoreIdentity: SafetyScoreV8PublicationIdentity | null;
}

export async function parseReportCardsFixedInputCacheArtifact(
  value: unknown,
): Promise<ReportCardsFixedInputCacheArtifact> {
  const parsedEnvelope = typeof value === "string" ? parseJson(value) : null;
  if (parsedEnvelope && !parsedEnvelope.ok) {
    throw new Error(`Malformed exact report-card fixed input cache envelope: ${parsedEnvelope.message}`);
  }
  const raw = parsedEnvelope?.ok ? parsedEnvelope.value : value;
  const envelope = FixedInputCacheEnvelopeSchema.parse(raw);
  const payload = await gunzipText(base64ToBytes(envelope.payload));
  if (new TextEncoder().encode(payload).byteLength !== envelope.uncompressedBytes) {
    throw new Error("Exact report-card fixed input cache artifact byte length does not match its envelope");
  }
  if (sha256Hex(payload) !== envelope.payloadSha256) {
    throw new Error("Exact report-card fixed input cache artifact checksum mismatch");
  }
  const parsedPayload = parseJson(payload);
  if (!parsedPayload.ok) {
    throw new Error(`Malformed exact report-card fixed input cache payload: ${parsedPayload.message}`);
  }
  const input = normalizeFixedInput(parsedPayload.value);
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

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function projectLegacyDexMap(
  dexLiqMap: Record<string, z.infer<typeof DexLiquidityMapSchema>[string]>,
): Record<string, FixedDexLiquidityRow> {
  return Object.fromEntries(
    Object.entries(dexLiqMap).map(([id, row]) => [
      id,
      FixedDexLiquidityRowSchema.parse({
        liquidityScore: row.liquidityScore,
        concentrationHhi: row.concentrationHhi,
        poolCount: row.poolCount,
        chainCount: row.chainCount,
        coverageClass: row.coverageClass,
        coverageConfidence: row.coverageConfidence,
        liquidityEvidenceClass: row.liquidityEvidenceClass,
        hasMeasuredLiquidityEvidence: row.hasMeasuredLiquidityEvidence,
        effectiveTvlUsd: row.effectiveTvlUsd,
        balanceMeasuredTvlUsd: row.balanceMeasuredTvlUsd,
        organicMeasuredTvlUsd: row.organicMeasuredTvlUsd,
        deploymentCoverage: row.deploymentCoverage,
        exitRouteObservations: row.exitRouteObservations,
        exitRouteObservationCoverage: row.exitRouteObservationCoverage,
        methodologyVersion: row.methodologyVersion,
        updatedAt: row.updatedAt,
      }),
    ]),
  );
}

function computeLegacyDexLiquidityPayloadFingerprint(
  dexLiqMap: z.infer<typeof DexLiquidityMapSchema>,
  dexGenerationId: string,
): string {
  const normalized = sortedRecord(
    Object.fromEntries(
      Object.entries(dexLiqMap).map(([id, row]) => [
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
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "report-cards.fixed-input.dex-payload.v1",
      dexGenerationId,
      dexLiqMap: normalized,
    }),
  );
}

function deriveDexGenerationId(dexLiqMap: Record<string, FixedDexLiquidityRow>): string {
  const updatedAtValues = uniqueSorted(Object.values(dexLiqMap).map((row) => String(row.updatedAt)));
  if (updatedAtValues.length !== 1) {
    throw new Error(`Fixed input DEX payload spans ${updatedAtValues.length} producer timestamps`);
  }
  return `dex-liquidity-${updatedAtValues[0]}`;
}

function deriveRedemptionGenerationId(
  redemptionBackstopMap: ReportCardsFixedInput["redemptionBackstopMap"],
  fallbackUpdatedAt: number | null,
): string {
  const updatedAtValues = uniqueSorted(Object.values(redemptionBackstopMap).map((row) => String(row.updatedAt)));
  if (updatedAtValues.length > 1) {
    throw new Error(`Fixed input redemption payload spans ${updatedAtValues.length} producer timestamps`);
  }
  const updatedAt = updatedAtValues[0] ?? (fallbackUpdatedAt == null ? "unavailable" : String(fallbackUpdatedAt));
  return `redemption-backstops-${updatedAt}`;
}

function migrateLegacyFixedInput(value: unknown): LegacyReportCardsFixedInputV3 | null {
  const v2 = LegacyReportCardsFixedInputV2Schema.safeParse(value);
  const legacy = v2.success ? v2.data : LegacyReportCardsFixedInputV1Schema.safeParse(value).data;
  if (!legacy) return null;
  const dexLiqMap = projectLegacyDexMap(legacy.dexLiqMap);
  const dexGenerationId = v2.success ? v2.data.dexGenerationId : deriveDexGenerationId(dexLiqMap);
  if (
    v2.success &&
    v2.data.dexPayloadFingerprint !== computeLegacyDexLiquidityPayloadFingerprint(v2.data.dexLiqMap, dexGenerationId) &&
    v2.data.dexPayloadFingerprint !==
      computeDexLiquidityPayloadFingerprint(projectLegacyDexMap(v2.data.dexLiqMap), dexGenerationId)
  ) {
    throw new Error("Legacy fixed input DEX payload fingerprint does not match its payload and generation");
  }
  const redemptionGenerationId = deriveRedemptionGenerationId(
    legacy.redemptionBackstopMap,
    legacy.inputFreshness.redemptionBackstops.updatedAt,
  );
  return LegacyReportCardsFixedInputV3Schema.parse({
    ...legacy,
    schemaVersion: 3,
    captureKind: "public-reconstruction",
    activeAssetIds: ACTIVE_STABLECOINS.map((coin) => coin.id).sort(),
    dexGenerationId,
    redemptionGenerationId,
    dexPayloadFingerprint: computeDexLiquidityPayloadFingerprint(dexLiqMap, dexGenerationId),
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint(
      legacy.redemptionBackstopMap,
      redemptionGenerationId,
    ),
    registryFingerprint: v2.success ? v2.data.registryFingerprint : computeReportCardsRegistryFingerprint(),
    inputMethodologyVersions: projectReportCardsFixedInputMethodologyVersions({
      methodologyVersion: legacy.methodologyVersion,
      dexLiqMap: legacy.dexLiqMap,
      pegDataById: legacy.pegDataById,
      redemptionBackstopMap: legacy.redemptionBackstopMap,
    }),
    dexLiqMap,
  });
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

function assertFreshnessConsistency(input: ReportCardsFixedInput): void {
  if (input.captureKind === "exact-publication-inputs") {
    const dexFreshness = input.inputFreshness.dexLiquidity;
    const dexTimestamps = uniqueSorted(Object.values(input.dexLiqMap).map((row) => String(row.updatedAt)));
    if (dexTimestamps.length !== 1 || Number(dexTimestamps[0]) !== dexFreshness.updatedAt) {
      throw new Error("Exact fixed input DEX rows do not match the DEX freshness generation");
    }
    const expectedDexGeneration = `dex-liquidity-${dexFreshness.updatedAt}`;
    if (input.dexGenerationId !== expectedDexGeneration) {
      throw new Error(
        `Exact fixed input DEX generation ${input.dexGenerationId} does not match active-row generation ${expectedDexGeneration}`,
      );
    }

    const redemptionFreshness = input.inputFreshness.redemptionBackstops;
    const redemptionTimestamps = uniqueSorted(
      Object.values(input.redemptionBackstopMap).map((row) => String(row.updatedAt)),
    );
    if (Object.keys(input.redemptionBackstopMap).length > 0) {
      if (redemptionTimestamps.length !== 1 || Number(redemptionTimestamps[0]) !== redemptionFreshness.updatedAt) {
        throw new Error("Exact fixed input redemption rows do not match the redemption freshness generation");
      }
    } else if (!redemptionFreshness.stale) {
      throw new Error("Exact fixed input has no redemption rows but marks redemption freshness as current");
    }
    const hasRedemptionRows = Object.keys(input.redemptionBackstopMap).length > 0;
    if (
      (hasRedemptionRows && !input.redemptionGenerationId.startsWith("redemption:")) ||
      (!hasRedemptionRows && input.redemptionGenerationId !== "redemption-backstops-unavailable")
    ) {
      throw new Error(`Exact fixed input redemption generation ${input.redemptionGenerationId} is not producer-bound`);
    }
    if (input.liquidityStale !== dexFreshness.stale || input.redemptionStale !== redemptionFreshness.stale) {
      throw new Error("Exact fixed input top-level freshness flags do not match lane freshness");
    }
  }

  for (const [lane, freshness] of Object.entries(input.inputFreshness)) {
    if (freshness.updatedAt != null && freshness.updatedAt > input.clockSec) {
      throw new Error(
        `Fixed input ${lane} producer timestamp ${freshness.updatedAt} is later than scoring clock ${input.clockSec}`,
      );
    }
    if (freshness.updatedAt == null || freshness.ageSeconds == null) {
      if (!freshness.stale) throw new Error(`Fixed input ${lane} freshness is incomplete but not stale`);
      continue;
    }
    const expectedAge = input.clockSec - freshness.updatedAt;
    if (freshness.ageSeconds !== expectedAge) {
      throw new Error(
        `Fixed input ${lane} age ${freshness.ageSeconds} does not match clock-derived age ${expectedAge}`,
      );
    }
  }
}

function assertFixedInputConsistency(input: ReportCardsFixedInput): void {
  if (new Set(input.activeAssetIds).size !== input.activeAssetIds.length) {
    throw new Error("Fixed input active asset identities contain duplicates");
  }
  if (input.captureKind === "exact-publication-inputs") {
    const invalidNavPriceIds = Object.keys(input.navPriceById ?? {}).filter(
      (id) => ACTIVE_STABLECOINS.find((coin) => coin.id === id)?.flags.navToken !== true,
    );
    if (invalidNavPriceIds.length > 0) {
      throw new Error(`Fixed input NAV price rows target non-NAV assets: ${invalidNavPriceIds.join(",")}`);
    }
    assertSameIds(Object.keys(input.dexLiqMap), input.activeAssetIds, "Exact fixed input DEX active rows");
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
  for (const [assetId, attribution] of Object.entries(input.safetyScoreV9SupplyAttributionById)) {
    if (!input.activeAssetIds.includes(assetId)) {
      throw new Error(`V9 supply attribution targets inactive asset ${assetId}`);
    }
    if (
      attribution.model !== "reviewed-deployment-unit-partition-v1" &&
      attribution.observedAtSec > input.clockSec
    ) {
      throw new Error(`V9 supply attribution for ${assetId} is later than the scoring clock`);
    }
    if (
      assetId === XAUT_ASSET_ID &&
      attribution.model === "canonical-lock-mint-partition-v1"
    ) {
      throw new Error(
        "Legacy XAUT lock/mint attribution is no longer admissible; a reconciled V2 packet is required",
      );
    }
    const aggregate = input.aggregateCirculatingById[assetId];
    const aggregateSupplyUsd = Object.values(aggregate?.circulating ?? {}).reduce((sum, value) => sum + value, 0);
    const attributedSupplyUsd =
      attribution.model === "canonical-lock-mint-partition-v1"
        ? Object.values(attribution.currentSupplyUsdByChain).reduce((sum, value) => sum + value, 0)
        : attribution.model === "canonical-lock-mint-group-partition-v2"
          ? attribution.canonical.currentSupplyUsd +
            attribution.representationGroup.currentSupplyUsd
          : attribution.deployments.reduce((sum, deployment) => sum + deployment.currentSupplyUsd, 0);
    const toleranceUsd = Math.max(0.000001, aggregateSupplyUsd * 1e-12);
    if (aggregateSupplyUsd <= 0 || Math.abs(attributedSupplyUsd - aggregateSupplyUsd) > toleranceUsd) {
      throw new Error(
        `V9 supply attribution for ${assetId} does not conserve aggregate circulating USD`,
      );
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
        throw new Error(
          `V9 supply attribution key ${assetId} does not match packet asset ${attribution.assetId}`,
        );
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
  for (const [assetId, records] of Object.entries(
    input.supplyAttributionJournalById,
  )) {
    if (!input.activeAssetIds.includes(assetId)) {
      throw new Error(
        `Supply attribution journal targets inactive asset ${assetId}`,
      );
    }
    for (const record of records) {
      if (record.completedAtSec > input.clockSec) {
        throw new Error(
          `Supply attribution journal for ${assetId} is later than the scoring clock`,
        );
      }
    }
  }
  const pegProvenanceIds = Object.keys(input.pegProvenanceById);
  if (pegProvenanceIds.length > 0) {
    assertSameIds(
      pegProvenanceIds,
      Object.keys(input.pegDataById),
      "V9 peg provenance rows",
    );
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
      stableJsonStringifyV1(
        projectSafetyScoreV9PegScoreResult(summary.legacyInclusive.result),
      ) !==
      stableJsonStringifyV1(projectSafetyScoreV9PegSummary(pegSummary))
    ) {
      throw new Error(`V9 peg provenance score does not match peg row ${assetId}`);
    }
  }
  const expectedBaseInputGenerationId = deriveReportCardsBaseInputGenerationId(input);
  if (input.baseInputGenerationId !== expectedBaseInputGenerationId) {
    throw new Error(
      `Fixed input base generation ${input.baseInputGenerationId} does not match payload ${expectedBaseInputGenerationId}`,
    );
  }
  assertFreshnessConsistency(input);
}

function parseReportCardsFixedInput(value: unknown): ReportCardsFixedInput | LegacyReportCardsFixedInputV3 {
  const parsed = ReportCardsFixedInputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const v3 = LegacyReportCardsFixedInputV3Schema.safeParse(value);
  if (v3.success) return v3.data;
  const migrated = migrateLegacyFixedInput(value);
  if (migrated) return migrated;
  const issue = parsed.error.issues[0];
  throw new Error(`Malformed fixed report-card input at ${issue?.path.join(".") || "root"}: ${issue?.message}`);
}

export function buildReportCardsSnapshotFromFixedInput(
  value: unknown,
  options: FixedReplayOptions = {},
): ReportCardsResponse {
  const input = normalizeFixedInput(value);
  if (!options.allowMethodologyMismatch && input.methodologyVersion !== SAFETY_SCORE_METHODOLOGY_VERSION) {
    throw new Error(
      `Fixed input methodology v${input.methodologyVersion} does not match current v${SAFETY_SCORE_METHODOLOGY_VERSION}`,
    );
  }
  const currentRegistryFingerprint = computeReportCardsRegistryFingerprint();
  if (!options.allowRegistryMismatch && input.registryFingerprint !== currentRegistryFingerprint) {
    throw new Error(
      `Fixed input registry fingerprint ${input.registryFingerprint} does not match current ${currentRegistryFingerprint}`,
    );
  }
  if (!options.allowRegistryMismatch) {
    assertSameIds(
      input.activeAssetIds,
      ACTIVE_STABLECOINS.map((coin) => coin.id),
      "Fixed input active registry",
    );
  }
  const currentDexPayloadFingerprint = computeDexLiquidityPayloadFingerprint(input.dexLiqMap, input.dexGenerationId);
  if (input.dexPayloadFingerprint !== currentDexPayloadFingerprint) {
    throw new Error(
      `Fixed input DEX payload fingerprint ${input.dexPayloadFingerprint} does not match payload ${currentDexPayloadFingerprint}`,
    );
  }
  const currentRedemptionPayloadFingerprint = computeRedemptionPayloadFingerprint(
    input.redemptionBackstopMap,
    input.redemptionGenerationId,
  );
  if (input.redemptionPayloadFingerprint !== currentRedemptionPayloadFingerprint) {
    throw new Error(
      `Fixed input redemption payload fingerprint ${input.redemptionPayloadFingerprint} does not match payload ${currentRedemptionPayloadFingerprint}`,
    );
  }

  const dexLiqMap = Object.fromEntries(
    Object.entries(input.dexLiqMap).map(([stablecoinId, row]) => {
      const deploymentSupplyCoverage = input.dexDeploymentSupplyCoverageById[stablecoinId];
      return [stablecoinId, deploymentSupplyCoverage ? { ...row, deploymentSupplyCoverage } : row];
    }),
  );
  const live = buildLiveReportCards({
    pegDataById: recordToMap(input.pegDataById),
    activeDepegPeakBpsById: recordToMap(input.activeDepegPeakBpsById),
    dexLiqMap,
    redemptionBackstopMap: input.redemptionBackstopMap,
    bluechipMap: input.bluechipMap,
    resolvedBlacklistStatuses: recordToMap(input.resolvedBlacklistStatuses),
    liveReserveMap: recordToMap(input.liveReserveMap),
    liveReserveProvenanceMap: recordToMap(input.liveReserveProvenanceMap),
    chainCirculatingById: recordToMap(input.chainCirculatingById),
    sameNotionalScoringMode: options.sameNotionalScoringMode,
    exitObservationAsOfSec: input.clockSec,
    dexExitObservationMaxAgeSec: options.dexExitObservationMaxAgeSec ?? CRON_INTERVALS["sync-dex-liquidity"] * 2,
    liveRedemptionExitObservationMaxAgeSec:
      options.liveRedemptionExitObservationMaxAgeSec ?? CRON_INTERVALS["sync-redemption-backstops"] * 2,
  });

  return ReportCardsResponseSchema.parse(
    buildReportCardsSnapshotEnvelope({
      cards: sortReportCards([...live.cards, ...buildDefunctReportCards()]),
      updatedAt: input.updatedAt,
      liquidityStale: input.liquidityStale,
      redemptionStale: input.redemptionStale,
      inputFreshness: input.inputFreshness,
      collateralDriftCoins: input.collateralDriftCoins,
      liveToFallbackCoins: input.liveToFallbackCoins,
      dependencyGraphEdges: live.dependencyGraphEdges,
    }),
  );
}

export function serializeNormalizedReportCardsReplay(value: unknown): string {
  return `${JSON.stringify(normalizeReportCardsReplayPayload(value), null, 2)}\n`;
}

export function normalizeFixedInput(value: unknown): ReportCardsFixedInput {
  const input = parseReportCardsFixedInput(value);
  const redemptionBackstopMap = normalizeFixedRedemptionBackstopMap(input.redemptionBackstopMap);
  const normalizedPayload: LegacyReportCardsFixedInputV3 = {
    ...input,
    activeAssetIds: [...input.activeAssetIds].sort(),
    inputMethodologyVersions: normalizeReportCardsFixedInputMethodologyVersions(input.inputMethodologyVersions),
    pegDataById: sortedRecord(input.pegDataById),
    ...(input.navPriceById ? { navPriceById: sortedRecord(input.navPriceById) } : {}),
    activeDepegPeakBpsById: sortedRecord(input.activeDepegPeakBpsById),
    dexLiqMap: normalizeFixedDexLiquidityMap(input.dexLiqMap),
    redemptionBackstopMap,
    bluechipMap: sortedRecord(input.bluechipMap),
    resolvedBlacklistStatuses: sortedRecord(input.resolvedBlacklistStatuses),
    liveReserveMap: sortedRecord(input.liveReserveMap),
    chainCirculatingById: sortedRecord(input.chainCirculatingById),
    aggregateCirculatingById: sortedRecord(input.aggregateCirculatingById),
    safetyScoreV9SupplyAttributionById: sortedRecord(
      Object.fromEntries(
        Object.entries(input.safetyScoreV9SupplyAttributionById).map(([assetId, attribution]) => [
          assetId,
          attribution.model === "canonical-lock-mint-partition-v1"
            ? {
                ...attribution,
                currentSupplyUsdByChain: sortedRecord(attribution.currentSupplyUsdByChain),
              }
            : attribution.model === "canonical-lock-mint-group-partition-v2"
              ? normalizeXautRepresentationGroupAttribution(attribution)
              : normalizeReviewedDeploymentAttribution(attribution),
        ]),
      ),
    ),
    evidenceJournalById: ReportCardEvidenceJournalByIdV1Schema.parse(input.evidenceJournalById),
    supplyAttributionJournalById:
      SupplyAttributionJournalByIdV1Schema.parse(
        input.supplyAttributionJournalById,
      ),
    pegProvenanceById: sortedRecord(input.pegProvenanceById),
    dexDeploymentSupplyCoverageById: sortedRecord(input.dexDeploymentSupplyCoverageById),
    liveReserveProvenanceMap: sortedRecord(input.liveReserveProvenanceMap),
    collateralDriftCoins: [...input.collateralDriftCoins].sort((left, right) => left.id.localeCompare(right.id)),
    liveToFallbackCoins: [...input.liveToFallbackCoins].sort(),
  };
  const derivedBaseInputGenerationId = deriveReportCardsBaseInputGenerationId(normalizedPayload);
  const normalized = ReportCardsFixedInputSchema.parse({
    ...normalizedPayload,
    baseInputGenerationId:
      "baseInputGenerationId" in input ? input.baseInputGenerationId : derivedBaseInputGenerationId,
  });
  assertFixedInputConsistency(normalized);
  return normalized;
}
