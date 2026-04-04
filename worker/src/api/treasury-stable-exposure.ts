import { DAY_SECONDS } from "@shared/lib/time-constants";
import { TREASURY_SEEDS } from "@shared/lib/treasury-seeds";
import {
  buildTreasuryStableExposureSnapshot,
  getTreasuryStableExposureResponseInvariantIssues,
} from "@shared/lib/treasury-stable-exposure";
import {
  GovernanceTypeSchema,
  ReportCardGradeSchema,
  TreasurySeedExtractionModeSchema,
  TreasuryStableExposureResponseSchema,
  type TreasuryStableExposureEntity,
  type TreasuryStableExposureResponse,
} from "@shared/types";
import { z } from "zod";
import {
  addFreshnessHeaders,
  buildFreshnessMeta,
  errorResponse,
  jsonResponse,
  validatePayloadWithSchema,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getCache } from "../lib/db-cache";

const MAX_AGE_SEC = DAY_SECONDS;
const EPSILON = 0.01;
const LEGACY_CACHE_NOTE = "Legacy treasury cache normalized during worker rollout; denominator diagnostics refresh after the next treasury sync.";
const LEGACY_INVALID_DENOMINATOR_NOTE = "Treasury-relative metrics are suppressed until the next treasury sync republishes this row with the new denominator model.";

const LegacyTreasuryStableExposureHoldingSchema = z.object({
  stablecoinId: z.string(),
  name: z.string(),
  symbol: z.string(),
  governance: GovernanceTypeSchema,
  usdValue: z.number(),
  pctOfTreasury: z.number().nullable(),
  pctOfStableSleeve: z.number().nullable(),
  safetyScore: z.number().nullable(),
  safetyGrade: ReportCardGradeSchema.nullable(),
});

const LegacyTreasuryStableExposureCoverageSchema = z.object({
  extractionMode: TreasurySeedExtractionModeSchema,
  ownerCount: z.number().int(),
  ownerChainCount: z.number().int(),
  trackedStableUsd: z.number(),
  stablecoinSleeveUsd: z.number(),
  untrackedStableUsd: z.number(),
  ratedTrackedStableUsd: z.number(),
  trackedStablePctOfTreasury: z.number().nullable(),
  trackedStablePctOfStableSleeve: z.number().nullable(),
  ratedTrackedStablePct: z.number().nullable(),
  untrackedStableCount: z.number().int(),
  notes: z.array(z.string()),
});

const LegacyTreasuryStableExposureEntitySchema = z.object({
  protocolId: z.string(),
  slug: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  source: z.literal("defillama-github"),
  adapterFile: z.string().nullable(),
  chains: z.array(z.string()),
  treasuryUsd: z.number(),
  stablecoinSleeveUsd: z.number(),
  trackedStableUsd: z.number(),
  decentralizedStableUsd: z.number(),
  decentralizedStablePctOfTreasury: z.number().nullable(),
  decentralizedStablePctOfStableSleeve: z.number().nullable(),
  weightedSafetyScore: z.number().nullable(),
  weightedSafetyGrade: ReportCardGradeSchema.nullable(),
  governanceBuckets: z.object({
    centralizedUsd: z.number(),
    centralizedDependentUsd: z.number(),
    decentralizedUsd: z.number(),
  }),
  holdings: z.array(LegacyTreasuryStableExposureHoldingSchema),
  coverage: LegacyTreasuryStableExposureCoverageSchema,
});

const LegacyTreasuryStableExposureResponseSchema = z.object({
  entities: z.array(LegacyTreasuryStableExposureEntitySchema),
  updatedAt: z.number(),
  coverage: z.object({
    entityCount: z.number().int(),
    registryCount: z.number().int(),
    launchEligibleCount: z.number().int(),
    ownerChainTuples: z.number().int(),
    launchOwnerChainTuples: z.number().int(),
    evmOnly: z.boolean(),
    extractionModes: z.object({
      staticSeeded: z.number().int(),
      customReviewed: z.number().int(),
      dynamicUnresolved: z.number().int(),
      missing: z.number().int(),
    }),
  }),
});

type LegacyTreasuryStableExposureEntity = z.infer<typeof LegacyTreasuryStableExposureEntitySchema>;

function pushUniqueNote(notes: string[], note: string): string[] {
  return notes.includes(note) ? notes : [...notes, note];
}

function shouldInvalidateLegacyDenominator(entity: LegacyTreasuryStableExposureEntity): boolean {
  if (!Number.isFinite(entity.treasuryUsd) || entity.treasuryUsd <= 0) return true;
  if (entity.stablecoinSleeveUsd > entity.treasuryUsd + EPSILON) return true;
  if (entity.trackedStableUsd > entity.stablecoinSleeveUsd + EPSILON) return true;
  if (entity.decentralizedStableUsd > entity.trackedStableUsd + EPSILON) return true;
  if ((entity.coverage.trackedStablePctOfTreasury ?? 0) > 100.01) return true;
  if ((entity.decentralizedStablePctOfTreasury ?? 0) > 100.01) return true;
  if (entity.holdings.some((holding) => holding.usdValue > entity.treasuryUsd + EPSILON)) return true;
  if (entity.holdings.some((holding) => (holding.pctOfTreasury ?? 0) > 100.01)) return true;
  return false;
}

function normalizeLegacyTreasuryStableExposureEntity(
  entity: LegacyTreasuryStableExposureEntity,
): TreasuryStableExposureEntity {
  const invalidDenominator = shouldInvalidateLegacyDenominator(entity);
  let notes = pushUniqueNote(entity.coverage.notes, LEGACY_CACHE_NOTE);
  if (invalidDenominator) {
    notes = pushUniqueNote(notes, LEGACY_INVALID_DENOMINATOR_NOTE);
  }

  return {
    ...entity,
    directWalletUsd: entity.treasuryUsd,
    treasuryUsd: invalidDenominator ? null : entity.treasuryUsd,
    decentralizedStablePctOfTreasury: invalidDenominator ? null : entity.decentralizedStablePctOfTreasury,
    holdings: entity.holdings.map((holding) => ({
      ...holding,
      pctOfTreasury: invalidDenominator ? null : holding.pctOfTreasury,
    })),
    coverage: {
      ...entity.coverage,
      denominatorStatus: invalidDenominator ? "invalid" : "direct-only",
      directWalletUsd: entity.treasuryUsd,
      defiPositionUsd: 0,
      consumedDirectBalanceUsd: 0,
      derivedUntrackedStableUsd: 0,
      trackedStablePctOfTreasury: invalidDenominator ? null : entity.coverage.trackedStablePctOfTreasury,
      derivedUntrackedStableCount: 0,
      skippedDerivedPositionCount: 0,
      notes,
    },
  };
}

function normalizeLegacyTreasuryStableExposureResponse(
  parsedData: unknown,
): TreasuryStableExposureResponse | null {
  const legacy = LegacyTreasuryStableExposureResponseSchema.safeParse(parsedData);
  if (!legacy.success) return null;

  return buildTreasuryStableExposureSnapshot(
    TREASURY_SEEDS,
    legacy.data.entities.map(normalizeLegacyTreasuryStableExposureEntity),
    legacy.data.updatedAt,
  );
}

export const handleTreasuryStableExposure = withErrorHandler(
  "treasury-stable-exposure",
  async (db: D1Database): Promise<Response> => {
    const cached = await getCache(db, "treasury-stable-exposure");
    if (!cached) {
      const body = {
        ...buildTreasuryStableExposureSnapshot(TREASURY_SEEDS, [], 0),
        _meta: buildFreshnessMeta(0, MAX_AGE_SEC),
      };
      return jsonResponse(
        body,
        addFreshnessHeaders({
          "Content-Type": "application/json",
          "Cache-Control": CACHE_PROFILES.slow,
        }, 0, MAX_AGE_SEC),
      );
    }

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(cached.value) as unknown;
    } catch {
      return errorResponse(503, "Cached treasury-stable-exposure payload is malformed");
    }

    const validation = validatePayloadWithSchema(
      TreasuryStableExposureResponseSchema,
      parsedData,
      "treasury-stable-exposure:cache-read",
    );

    const normalizedData = validation.ok
      ? validation.data
      : normalizeLegacyTreasuryStableExposureResponse(parsedData);

    if (!normalizedData) {
      return errorResponse(503, "Cached treasury-stable-exposure payload is malformed");
    }
    if (getTreasuryStableExposureResponseInvariantIssues(normalizedData).length > 0) {
      return errorResponse(503, "Cached treasury-stable-exposure payload is malformed");
    }

    const body = {
      ...normalizedData,
      _meta: buildFreshnessMeta(cached.updatedAt, MAX_AGE_SEC),
    };

    return jsonResponse(
      body,
      addFreshnessHeaders({
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.slow,
      }, cached.updatedAt, MAX_AGE_SEC),
    );
  },
);
