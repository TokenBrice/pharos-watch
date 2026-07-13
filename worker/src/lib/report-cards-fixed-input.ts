import { z } from "zod";
import { BluechipRatingsMapSchema } from "@shared/types/bluechip";
import {
  DexLiquidityMapSchema,
  ExitRouteObservationCoverageSchema,
  ExitRouteObservationSchema,
  PegSummaryCoinSchema,
  type ExitRouteObservation,
} from "@shared/types/market";
import { RedemptionBackstopMapSchema } from "@shared/types/redemption";
import { ReserveSliceSchema } from "@shared/types/reserves";
import { ReportCardsResponseSchema, type ReportCard, type ReportCardsResponse } from "@shared/types/report-cards";
import { stableJsonStringifyV1 } from "@shared/lib/depeg-resolver/hash";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { sha256Hex } from "@shared/lib/sha256";
import { ACTIVE_STABLECOINS, FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { DexDeploymentSupplyCoverage } from "@shared/lib/report-card-peg-liquidity";
import { buildLiveReportCards } from "./report-cards-snapshot-card";
import {
  buildDefunctReportCards,
  buildReportCardsSnapshotEnvelope,
  sortReportCards,
} from "./report-cards-snapshot-finalize";

const FreshnessEntrySchema = z.object({
  updatedAt: z.number().finite().nonnegative().nullable(),
  ageSeconds: z.number().finite().nonnegative().nullable(),
  stale: z.boolean(),
});

const BlacklistStatusSchema = z.union([z.boolean(), z.literal("possible"), z.literal("inherited")]);

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

const FixedDexLiquidityRowSchema = z.object({
  liquidityScore: z.number().min(0).max(100).nullable(),
  concentrationHhi: z.number().min(0).max(1).nullable(),
  poolCount: z.number().int().nonnegative(),
  chainCount: z.number().int().nonnegative(),
  coverageClass: z.enum(["primary", "mixed", "fallback", "legacy", "unobserved"]).nullable().optional(),
  coverageConfidence: z.number().min(0).max(1).nullable().optional(),
  liquidityEvidenceClass: z
    .enum(["unobserved", "measured", "partial_measured", "observed_unmeasured"])
    .nullable()
    .optional(),
  hasMeasuredLiquidityEvidence: z.boolean().nullable().optional(),
  effectiveTvlUsd: z.number().finite().nonnegative().nullable().optional(),
  balanceMeasuredTvlUsd: z.number().finite().nonnegative().nullable().optional(),
  organicMeasuredTvlUsd: z.number().finite().nonnegative().nullable().optional(),
  deploymentCoverage: z
    .object({
      observedPools: z.number().int().nonnegative(),
      verifiedNoPools: z.number().int().nonnegative(),
      providerInaccessible: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
  exitRouteObservations: z.array(ExitRouteObservationSchema).nullable().optional(),
  exitRouteObservationCoverage: ExitRouteObservationCoverageSchema.optional(),
  methodologyVersion: z.string().min(1).optional(),
  updatedAt: z.number().int().nonnegative(),
});

export type FixedDexLiquidityRow = z.infer<typeof FixedDexLiquidityRowSchema>;

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
  pegDataById: z.record(z.string(), PegSummaryCoinSchema),
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

const ReportCardsFixedInputSchema = z
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
    inputMethodologyVersions: z.object({
      safetyScore: z.string().min(1),
      dexLiquidity: z.array(z.string().min(1)),
      pegScore: z.array(z.string().min(1)),
      redemptionBackstop: z.array(z.string().min(1)),
    }),
    dexLiqMap: z.record(z.string(), FixedDexLiquidityRowSchema),
  })
  .strict();

export type ReportCardsFixedInput = z.infer<typeof ReportCardsFixedInputSchema>;

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

function normalizeExitRouteObservation<T extends ExitRouteObservation>(observation: T): T {
  return {
    ...observation,
    output: {
      ...observation.output,
      ...(observation.output.trackedAssetIds
        ? { trackedAssetIds: [...observation.output.trackedAssetIds].sort() }
        : {}),
      ...(observation.output.assetKeys ? { assetKeys: [...observation.output.assetKeys].sort() } : {}),
      ...(observation.output.basketWeights
        ? {
            basketWeights: [...observation.output.basketWeights].sort(
              (left, right) =>
                (left.assetId ?? "").localeCompare(right.assetId ?? "") ||
                (left.symbol ?? "").localeCompare(right.symbol ?? "") ||
                left.weight - right.weight,
            ),
          }
        : {}),
    },
    commonModeKeys: [...observation.commonModeKeys].sort(),
    ...(observation.capacityCurve
      ? {
          capacityCurve: [...observation.capacityCurve].sort(
            (left, right) =>
              left.maxCostBps - right.maxCostBps || left.requestedNotionalUsd - right.requestedNotionalUsd,
          ),
        }
      : {}),
  } as T;
}

function normalizeExitRouteObservations<T extends ExitRouteObservation>(
  observations: readonly T[] | null | undefined,
): T[] | null | undefined {
  if (observations == null) return observations;
  return observations
    .map(normalizeExitRouteObservation)
    .sort(
      (left, right) =>
        left.routeId.localeCompare(right.routeId) ||
        stableJsonStringifyV1(left).localeCompare(stableJsonStringifyV1(right)),
    );
}

function normalizeDexLiquidityMap(record: Record<string, FixedDexLiquidityRow>): Record<string, FixedDexLiquidityRow> {
  return sortedRecord(
    Object.fromEntries(
      Object.entries(record).map(([id, row]) => [
        id,
        {
          ...row,
          ...(row.exitRouteObservations !== undefined
            ? { exitRouteObservations: normalizeExitRouteObservations(row.exitRouteObservations) }
            : {}),
        },
      ]),
    ),
  );
}

function projectFixedDexLiquidityMap(
  record: Record<string, FixedDexLiquidityRow>,
): Record<string, FixedDexLiquidityRow> {
  return Object.fromEntries(Object.entries(record).map(([id, row]) => [id, FixedDexLiquidityRowSchema.parse(row)]));
}

function normalizeRedemptionBackstopMap(
  record: ReportCardsFixedInput["redemptionBackstopMap"],
): ReportCardsFixedInput["redemptionBackstopMap"] {
  return sortedRecord(
    Object.fromEntries(
      Object.entries(record).map(([id, row]) => [
        id,
        {
          ...row,
          ...(row.capacityProfile?.exitRouteObservations
            ? {
                capacityProfile: {
                  ...row.capacityProfile,
                  exitRouteObservations: normalizeExitRouteObservations(row.capacityProfile.exitRouteObservations)!,
                },
              }
            : {}),
        },
      ]),
    ),
  );
}

export function computeReportCardsRegistryFingerprint(): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "report-cards.fixed-input.registry.v1",
      activeStablecoins: [...ACTIVE_STABLECOINS].sort((left, right) => left.id.localeCompare(right.id)),
      frozenStablecoins: [...FROZEN_STABLECOINS].sort((left, right) => left.id.localeCompare(right.id)),
      deadStablecoins: [...DEAD_STABLECOINS].sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );
}

export function computeDexLiquidityPayloadFingerprint(
  dexLiqMap: Record<string, FixedDexLiquidityRow>,
  dexGenerationId: string,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "report-cards.fixed-input.dex-payload.v1",
      dexGenerationId,
      dexLiqMap: normalizeDexLiquidityMap(projectFixedDexLiquidityMap(dexLiqMap)),
    }),
  );
}

export function computeRedemptionPayloadFingerprint(
  redemptionBackstopMap: ReportCardsFixedInput["redemptionBackstopMap"],
  redemptionGenerationId: string,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "report-cards.fixed-input.redemption-payload.v1",
      redemptionGenerationId,
      redemptionBackstopMap: normalizeRedemptionBackstopMap(redemptionBackstopMap),
    }),
  );
}

export const REPORT_CARDS_FIXED_INPUT_CACHE_KEY = "report-cards:fixed-input:exact";
export const REPORT_CARDS_FIXED_INPUT_CACHE_MAX_BYTES = 1_900_000;

const FixedInputCacheEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("report-cards-fixed-input-exact"),
  encoding: z.literal("gzip-base64"),
  sourceGeneration: z.string().min(1),
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
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes: Uint8Array): Promise<string> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export async function buildReportCardsFixedInputCacheEntry(
  value: unknown,
): Promise<{ key: string; value: string; storedBytes: number; uncompressedBytes: number }> {
  const input = normalizeFixedInput(value);
  if (input.captureKind !== "exact-publication-inputs") {
    throw new Error("Only exact publication inputs may be persisted as the P0c cache artifact");
  }
  const payload = JSON.stringify(input);
  const uncompressedBytes = new TextEncoder().encode(payload);
  const compressed = await gzipBytes(uncompressedBytes);
  const envelope = JSON.stringify({
    schemaVersion: 1,
    kind: "report-cards-fixed-input-exact",
    encoding: "gzip-base64",
    sourceGeneration: input.sourceGeneration,
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

export async function parseReportCardsFixedInputCacheValue(value: unknown): Promise<ReportCardsFixedInput> {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  const envelope = FixedInputCacheEnvelopeSchema.parse(raw);
  const payload = await gunzipText(base64ToBytes(envelope.payload));
  if (new TextEncoder().encode(payload).byteLength !== envelope.uncompressedBytes) {
    throw new Error("Exact report-card fixed input cache artifact byte length does not match its envelope");
  }
  if (sha256Hex(payload) !== envelope.payloadSha256) {
    throw new Error("Exact report-card fixed input cache artifact checksum mismatch");
  }
  const input = normalizeFixedInput(JSON.parse(payload));
  if (input.captureKind !== "exact-publication-inputs") {
    throw new Error("Cached report-card fixed input is not publication-exact");
  }
  if (input.sourceGeneration !== envelope.sourceGeneration) {
    throw new Error("Exact report-card fixed input cache generation mismatch");
  }
  return input;
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
            ? { exitRouteObservations: normalizeExitRouteObservations(row.exitRouteObservations) }
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

function migrateLegacyFixedInput(value: unknown): ReportCardsFixedInput | null {
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
  return ReportCardsFixedInputSchema.parse({
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
    inputMethodologyVersions: {
      safetyScore: legacy.methodologyVersion,
      dexLiquidity: uniqueSorted(Object.values(legacy.dexLiqMap).map((row) => row.methodologyVersion)),
      pegScore: uniqueSorted(Object.values(legacy.pegDataById).map((row) => row.methodologyVersion)),
      redemptionBackstop: uniqueSorted(
        Object.values(legacy.redemptionBackstopMap).map((row) => row.methodologyVersion),
      ),
    },
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
> & {
  captureKind: ReportCardsFixedInput["captureKind"];
  activeAssetIds?: string[];
};

export function createReportCardsFixedInput(draft: ReportCardsFixedInputDraft): ReportCardsFixedInput {
  const activeAssetIds = [...(draft.activeAssetIds ?? ACTIVE_STABLECOINS.map((coin) => coin.id))].sort();
  const dexLiqMap = normalizeDexLiquidityMap(projectFixedDexLiquidityMap(draft.dexLiqMap));
  const redemptionBackstopMap = normalizeRedemptionBackstopMap(draft.redemptionBackstopMap);
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
    inputMethodologyVersions: {
      safetyScore: draft.methodologyVersion,
      dexLiquidity: uniqueSorted(
        Object.values(dexLiqMap).flatMap((row) => {
          const methodologyVersion = (row as FixedDexLiquidityRow & { methodologyVersion?: string }).methodologyVersion;
          return methodologyVersion ? [methodologyVersion] : [];
        }),
      ),
      pegScore: uniqueSorted(Object.values(draft.pegDataById).map((row) => row.methodologyVersion)),
      redemptionBackstop: uniqueSorted(Object.values(redemptionBackstopMap).map((row) => row.methodologyVersion)),
    },
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
    if (freshness.updatedAt == null || freshness.ageSeconds == null) {
      if (!freshness.stale) throw new Error(`Fixed input ${lane} freshness is incomplete but not stale`);
      continue;
    }
    const expectedAge = Math.max(0, input.clockSec - freshness.updatedAt);
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
    assertSameIds(Object.keys(input.dexLiqMap), input.activeAssetIds, "Exact fixed input DEX active rows");
    assertSameIds(
      Object.keys(input.resolvedBlacklistStatuses),
      input.activeAssetIds,
      "Exact fixed input blacklist rows",
    );
  }
  assertFreshnessConsistency(input);
}

function normalizeCard(card: ReportCard): ReportCard {
  return {
    ...card,
    dimensions: Object.fromEntries(
      Object.entries(card.dimensions).map(([key, dimension]) => [
        key,
        {
          ...dimension,
          ...(dimension.detailItems
            ? { detailItems: [...dimension.detailItems].sort((left, right) => left.label.localeCompare(right.label)) }
            : {}),
        },
      ]),
    ) as ReportCard["dimensions"],
    rawInputs: {
      ...card.rawInputs,
      dependencies: [...card.rawInputs.dependencies].sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          (left.type ?? "collateral").localeCompare(right.type ?? "collateral") ||
          left.weight - right.weight,
      ),
    },
  };
}

function parseReportCardsFixedInput(value: unknown): ReportCardsFixedInput {
  const parsed = ReportCardsFixedInputSchema.safeParse(value);
  if (!parsed.success) {
    const migrated = migrateLegacyFixedInput(value);
    if (migrated) return migrated;
  }
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Malformed fixed report-card input at ${issue?.path.join(".") || "root"}: ${issue?.message}`);
  }
  return parsed.data;
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

/** Removes only publication-envelope ordering so replay output is byte-comparable. */
function normalizeReportCardsReplaySnapshot(value: unknown): ReportCardsResponse {
  const snapshot = ReportCardsResponseSchema.parse(value);
  return {
    cards: [...snapshot.cards].map(normalizeCard).sort((left, right) => left.id.localeCompare(right.id)),
    methodology: snapshot.methodology,
    dependencyGraph: {
      edges: [...snapshot.dependencyGraph.edges].sort(
        (left, right) =>
          left.from.localeCompare(right.from) ||
          left.to.localeCompare(right.to) ||
          left.type.localeCompare(right.type) ||
          left.weight - right.weight,
      ),
    },
    updatedAt: snapshot.updatedAt,
    ...(snapshot.liquidityStale != null ? { liquidityStale: snapshot.liquidityStale } : {}),
    ...(snapshot.redemptionStale != null ? { redemptionStale: snapshot.redemptionStale } : {}),
    ...(snapshot.inputFreshness ? { inputFreshness: snapshot.inputFreshness } : {}),
    ...(snapshot.collateralDriftCoins
      ? {
          collateralDriftCoins: [...snapshot.collateralDriftCoins].sort((left, right) =>
            left.id.localeCompare(right.id),
          ),
        }
      : {}),
    ...(snapshot.liveToFallbackCoins ? { liveToFallbackCoins: [...snapshot.liveToFallbackCoins].sort() } : {}),
  };
}

export function serializeNormalizedReportCardsReplay(value: unknown): string {
  return `${JSON.stringify(normalizeReportCardsReplaySnapshot(value), null, 2)}\n`;
}

export function normalizeFixedInput(value: unknown): ReportCardsFixedInput {
  const input = parseReportCardsFixedInput(value);
  const redemptionBackstopMap = normalizeRedemptionBackstopMap(input.redemptionBackstopMap);
  const normalized: ReportCardsFixedInput = {
    ...input,
    activeAssetIds: [...input.activeAssetIds].sort(),
    inputMethodologyVersions: {
      safetyScore: input.inputMethodologyVersions.safetyScore,
      dexLiquidity: uniqueSorted(input.inputMethodologyVersions.dexLiquidity),
      pegScore: uniqueSorted(input.inputMethodologyVersions.pegScore),
      redemptionBackstop: uniqueSorted(input.inputMethodologyVersions.redemptionBackstop),
    },
    pegDataById: sortedRecord(input.pegDataById),
    activeDepegPeakBpsById: sortedRecord(input.activeDepegPeakBpsById),
    dexLiqMap: normalizeDexLiquidityMap(input.dexLiqMap),
    redemptionBackstopMap,
    bluechipMap: sortedRecord(input.bluechipMap),
    resolvedBlacklistStatuses: sortedRecord(input.resolvedBlacklistStatuses),
    liveReserveMap: sortedRecord(input.liveReserveMap),
    chainCirculatingById: sortedRecord(input.chainCirculatingById),
    dexDeploymentSupplyCoverageById: sortedRecord(input.dexDeploymentSupplyCoverageById),
    liveReserveProvenanceMap: sortedRecord(input.liveReserveProvenanceMap),
    collateralDriftCoins: [...input.collateralDriftCoins].sort((left, right) => left.id.localeCompare(right.id)),
    liveToFallbackCoins: [...input.liveToFallbackCoins].sort(),
  };
  assertFixedInputConsistency(normalized);
  return normalized;
}
