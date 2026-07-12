import { z } from "zod";
import { BluechipRatingsMapSchema } from "@shared/types/bluechip";
import { DexLiquidityMapSchema, PegSummaryCoinSchema } from "@shared/types/market";
import { RedemptionBackstopMapSchema } from "@shared/types/redemption";
import { ReserveSliceSchema } from "@shared/types/reserves";
import { ReportCardsResponseSchema, type ReportCard, type ReportCardsResponse } from "@shared/types/report-cards";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
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

export const ReportCardsFixedInputSchema = z
  .object({
    schemaVersion: z.literal(1),
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
    dexLiqMap: DexLiquidityMapSchema,
    redemptionBackstopMap: RedemptionBackstopMapSchema,
    bluechipMap: BluechipRatingsMapSchema,
    resolvedBlacklistStatuses: z.record(z.string(), BlacklistStatusSchema),
    liveReserveMap: z.record(z.string(), z.array(ReserveSliceSchema)),
    liveReserveProvenanceMap: z.record(
      z.string(),
      z.object({ source: z.string().min(1), fetchedAt: z.number().int().nonnegative() }),
    ),
    collateralDriftCoins: z
      .array(z.object({ id: z.string(), liveScore: z.number(), curatedScore: z.number(), delta: z.number() }))
      .default([]),
    liveToFallbackCoins: z.array(z.string()).default([]),
  })
  .strict();

export type ReportCardsFixedInput = z.infer<typeof ReportCardsFixedInputSchema>;

export interface FixedReplayOptions {
  allowMethodologyMismatch?: boolean;
}

function recordToMap<T>(record: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(record));
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
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

export function parseReportCardsFixedInput(value: unknown): ReportCardsFixedInput {
  const parsed = ReportCardsFixedInputSchema.safeParse(value);
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
  const input = parseReportCardsFixedInput(value);
  if (!options.allowMethodologyMismatch && input.methodologyVersion !== SAFETY_SCORE_METHODOLOGY_VERSION) {
    throw new Error(
      `Fixed input methodology v${input.methodologyVersion} does not match current v${SAFETY_SCORE_METHODOLOGY_VERSION}`,
    );
  }

  const live = buildLiveReportCards({
    pegDataById: recordToMap(input.pegDataById),
    activeDepegPeakBpsById: recordToMap(input.activeDepegPeakBpsById),
    dexLiqMap: input.dexLiqMap,
    redemptionBackstopMap: input.redemptionBackstopMap,
    bluechipMap: input.bluechipMap,
    resolvedBlacklistStatuses: recordToMap(input.resolvedBlacklistStatuses),
    liveReserveMap: recordToMap(input.liveReserveMap),
    liveReserveProvenanceMap: recordToMap(input.liveReserveProvenanceMap),
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
export function normalizeReportCardsReplaySnapshot(value: unknown): ReportCardsResponse {
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
  return {
    ...input,
    pegDataById: sortedRecord(input.pegDataById),
    activeDepegPeakBpsById: sortedRecord(input.activeDepegPeakBpsById),
    dexLiqMap: sortedRecord(input.dexLiqMap),
    redemptionBackstopMap: sortedRecord(input.redemptionBackstopMap),
    bluechipMap: sortedRecord(input.bluechipMap),
    resolvedBlacklistStatuses: sortedRecord(input.resolvedBlacklistStatuses),
    liveReserveMap: sortedRecord(input.liveReserveMap),
    liveReserveProvenanceMap: sortedRecord(input.liveReserveProvenanceMap),
    collateralDriftCoins: [...input.collateralDriftCoins].sort((left, right) => left.id.localeCompare(right.id)),
    liveToFallbackCoins: [...input.liveToFallbackCoins].sort(),
  };
}
