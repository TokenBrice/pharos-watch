import { V9RatingStatusSchema, V9CompactPartialEvidenceSchema, V9EvidencePillarSchema } from "./safety-score-v9-causes";
import { z } from "zod";
import { DigestSafetyMapUtcDateSchema, type DigestSafetyMapCapture } from "./digest-safety-map-contract";
import type { DepegDirection } from "./market";
import type { MintBurnFlowsResponse } from "./mint-burn";
import {
  SafetyScorePublicationIdentitySchema,
  SafetyScoreV8PublicationIdentitySchema,
  SafetyScoreV9PublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
  type SafetyScoreV8PublicationIdentity,
  type SafetyScoreV9PublicationIdentity,
} from "./safety-score-publication";

export const DigestKindSchema = z.enum(["daily", "weekly"]);
export type DigestKind = z.output<typeof DigestKindSchema>;

/**
 * Digest generation profile. `standard` is the single writer call (plus the
 * hard-issue corrective); `heavy` adds an evidence audit and a revision pass.
 */
export const DigestLlmProfileSchema = z.enum(["standard", "heavy"]);
export type DigestLlmProfile = z.output<typeof DigestLlmProfileSchema>;

export const DigestSafetyContextSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("available"),
        expectedModel: z.enum(["v8", "v9"]),
        identity: SafetyScorePublicationIdentitySchema,
        publishedAt: z.number().int().nonnegative(),
        reason: z.null(),
      })
      .strict(),
    z
      .object({
        status: z.literal("unavailable"),
        expectedModel: z.enum(["v8", "v9"]),
        identity: z.null(),
        publishedAt: z.null(),
        reason: z.string().min(1),
      })
      .strict(),
  ])
  .superRefine((context, ctx) => {
    if (context.status === "available" && context.identity.model !== context.expectedModel) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedModel"],
        message: "Digest Safety Score expected model must match its exact publication identity",
      });
    }
  });
export type DigestSafetyContext = z.output<typeof DigestSafetyContextSchema>;

const DigestV9SafetyPillarSchema = z
  .object({
    score: z.number().nullable(),
    aggregationDisposition: V9EvidencePillarSchema.shape.aggregationDisposition,
    pricedUnknown: V9EvidencePillarSchema.shape.pricedUnknown,
    evidenceLevel: z.string(),
    freshness: z.string(),
    reasons: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()),
  })
  .passthrough();

const DigestV9SafetyCapSchema = z
  .object({
    kind: z.string(),
    limit: z.number(),
    reason: z.string(),
    binding: z.boolean(),
  })
  .passthrough();

export const DigestV9SafetyCoinSchema = z
  .object({
    symbol: z.string(),
    grade: z.string(),
    score: z.number().nullable(),
    ratingStatus: V9RatingStatusSchema.optional(),
    partialEvidence: V9CompactPartialEvidenceSchema.nullable().optional(),
    pillars: z
      .object({
        backing: DigestV9SafetyPillarSchema,
        exit: DigestV9SafetyPillarSchema,
        control: DigestV9SafetyPillarSchema,
      })
      .passthrough(),
    reasonCodes: z.array(z.string()),
    caps: z.array(DigestV9SafetyCapSchema),
    bindingCap: DigestV9SafetyCapSchema.nullable(),
  })
  .passthrough();

/** Normalized V8 digest coin after legacy snapshot defaults are applied. */
export interface DigestV8SafetyCoin {
  symbol: string;
  grade: string;
  score: number;
  peg: number | null;
  liq: number | null;
}

export type DigestV9SafetyCoin = z.output<typeof DigestV9SafetyCoinSchema>;
export type DigestV9SafetyPillar = DigestV9SafetyCoin["pillars"]["backing"];
export type DigestV9SafetyCap = DigestV9SafetyCoin["caps"][number];

export type DigestSafetyScores =
  | {
      model: "v8";
      mentionedCoins: DigestV8SafetyCoin[];
      medianGrade: string;
      aboveBCount: number;
      fCount: number;
      provenance: SafetyScoreV8PublicationIdentity & { publishedAt: number };
    }
  | {
      model: "v9";
      mentionedCoins: DigestV9SafetyCoin[];
      gradeDistribution: Record<string, number>;
      provenance: SafetyScoreV9PublicationIdentity & { publishedAt: number };
    };

interface DigestGradeTransitionBase {
  historyId: string;
  recordedAt: number;
  symbol: string;
  fromGrade: string;
  toGrade: string;
  fromScore: number | null;
  toScore: number | null;
  mcapUsd: number;
}

export type DigestGradeTransition =
  | (DigestGradeTransitionBase & {
      model: "v8";
      safetyScoreIdentity: SafetyScoreV8PublicationIdentity;
      currentDimensions: {
        peg: number | null;
        liq: number | null;
        resilience: number | null;
        decentralization: number | null;
      };
    })
  | (DigestGradeTransitionBase & {
      model: "v9";
      safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
      currentPillars: DigestV9SafetyCoin["pillars"];
      reasonCodes: string[];
      caps: DigestV9SafetyCap[];
      bindingCap: DigestV9SafetyCap | null;
    });

export const DigestEventPeriodSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}).refine((period) => period.start < period.end, "Event periods must be nonempty and half-open");
export type DigestEventPeriod = z.output<typeof DigestEventPeriodSchema>;

export const DigestGradeTransitionAccountingSchema = z.discriminatedUnion("complete", [
  z.object({
    complete: z.literal(true),
    window: DigestEventPeriodSchema,
    safetyScoreIdentity: SafetyScorePublicationIdentitySchema,
    count: z.number().int().nonnegative(),
    identities: z.array(z.object({
      historyId: z.string().min(1),
      recordedAt: z.number().int().nonnegative(),
    })),
  }),
  z.object({
    complete: z.literal(false),
    window: DigestEventPeriodSchema,
    reason: z.string().min(1),
  }),
]).superRefine((accounting, ctx) => {
  if (!accounting.complete) return;
  const ids = new Set(accounting.identities.map((entry) => entry.historyId));
  if (ids.size !== accounting.count || ids.size !== accounting.identities.length ||
      accounting.identities.some((entry) =>
        entry.recordedAt < accounting.window.start || entry.recordedAt >= accounting.window.end)) {
    ctx.addIssue({ code: "custom", message: "Transition census must reconcile distinct identities inside its window" });
  }
});
export type DigestGradeTransitionAccounting = z.output<typeof DigestGradeTransitionAccountingSchema>;

export type DigestEditorialCandidateKind =
  | "depeg"
  | "resolved-depeg"
  | "psi"
  | "supply"
  | "mint-burn"
  | "dews"
  | "grade"
  | "yield"
  | "liquidity"
  | "blacklist"
  | "market";

export type DigestEditorialCandidateNovelty =
  | "new"
  | "worsening"
  | "improving"
  | "reversal"
  | "accelerating"
  | "decelerating"
  | "recurring"
  | "chronic"
  | "structural";

export type DigestEditorialCandidateConfidence = "high" | "medium" | "low";

export type DigestEditorialCandidateArtifactRisk = "none" | "low" | "medium" | "high";

export interface DigestEditorialCandidate {
  id: string;
  kind: DigestEditorialCandidateKind;
  title: string;
  symbols: string[];
  impactScore: number;
  novelty: DigestEditorialCandidateNovelty;
  confidence: DigestEditorialCandidateConfidence;
  artifactRisk: DigestEditorialCandidateArtifactRisk;
  headlineFacts: string[];
  whyItMatters: string;
  suppressReason?: string;
}

export interface DigestDataQuality {
  generatedAt: number;
  stablecoinsCacheUpdatedAt: number | null;
  stablecoinsCacheAgeSec: number | null;
  degradedSources?: string[];
  windows: {
    blacklistActivity: { label: string; start: number; end: number };
    mintBurnFlows: { label: string; start: number | null; end: number | null };
    supplyVelocity: { label: string; dates: number[] };
    psi: { label: string; sampleAt: number | null; dailySnapshotAt: number | null };
  };
}




export interface DigestCalmNarrativeFrame {
  label: string;
  detail: string;
  candidateId?: string;
}

export interface DigestEditorialAudit {
  topCandidateIds: string[];
  usableCandidateIds: string[];
  suppressedCandidateIds: string[];
  momentumCandidateIds: string[];
  requiredLeadCandidateIds?: string[];
  /** "hard:/soft:" prefixed reasons for today's lead requirements. */
  leadRequirementReasons?: string[];
  /** Symbols demoted from hard lead to mention-only by the lead quota. */
  demotedLeadMentionTokens?: string[];
  leadCandidateId?: string | null;
  leadCandidateTitle?: string | null;
  usedCandidateIds?: string[];
  modelSuppressedCandidateIds?: string[];
  qualityIssueCodes?: string[];
}


export const DigestSupplyCoverageSchema = z.object({
  complete: z.boolean(),
  observedCount: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
  /** SHA-256 of JSON [aggregateUniverse, sorted full-universe member IDs]. */
  memberFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).refine((coverage) => !coverage.complete || coverage.unavailableCount === 0, {
  message: "Complete supply cannot have unavailable members",
});

export const DigestMcap7dDeltaCoverageSchema = z.object({
  coveredCoins: z.number().int().nonnegative(),
  totalCoins: z.number().int().nonnegative(),
  coveredMcapUsd: z.number().nonnegative(),
}).refine((coverage) => coverage.coveredCoins <= coverage.totalCoins, {
  message: "Covered supply members cannot exceed the universe",
});

export interface DigestInputData {
  digestVersion?: number;
  aggregateUniverse?: "core-stablecoins-v1";
  totalMcapUsd: number;
  /** totalMcapUsd is a known subtotal, not a complete market total unless coverage is complete. */
  supplyCoverage?: z.infer<typeof DigestSupplyCoverageSchema>;
  /** Null when no core coin carries both current and prior-week supply (no comparison pair). */
  mcap7dDelta: number | null;
  /**
   * Basis of `mcap7dDelta`: core coins carrying a prior-week supply bucket and
   * their current market cap. A coin without a baseline is excluded from both
   * sides of the delta, so `coveredMcapUsd` — not `totalMcapUsd` — is the
   * denominator of any published 7-day percentage.
   */
  mcap7dDeltaCoverage?: z.infer<typeof DigestMcap7dDeltaCoverageSchema>;
  totalMcapAth?: {
    value: number;
    date: number;
    daysAgo: number;
  };
  dataQuality?: DigestDataQuality;
  editorialCandidates?: DigestEditorialCandidate[];
  changeSummary?: DigestChangeSummary;
  nextTriggers?: DigestNextTrigger[];
  forwardLookOutcomes?: DigestForwardLookOutcome[];
  riskTape?: DigestRiskTapeItem[];
  calmNarrativeFrame?: DigestCalmNarrativeFrame;
  editorialAudit?: DigestEditorialAudit;
  degradedSources?: string[];
  safetyContext?: DigestSafetyContext;
  /** Dated, capture-matched Safety Score map used by this exact edition. */
  safetyMap?: DigestSafetyMapCapture;
  /** Curated cause annotations for coins in the depeg set (why it broke). */
  causeContext?: {
    stablecoinId: string;
    symbol: string;
    kind: string;
    label: string;
    date: string;
    href?: string;
  }[];
  /** Chronic ledger: ongoing depegs the reader has already seen as headlines. */
  standingConditions?: {
    stablecoinId?: string;
    symbol: string;
    ageDays: number;
    currentBps?: number;
    peakBps?: number;
    mcapUsd?: number;
  }[];
  /** Uncapped tracked open-event count; null when the query is unavailable. */
  activeDepegCount: number | null;
  /** Uncapped recovered-event count, before market-cap/severity/display filters. */
  resolvedDepegCount?: number | null;
  /** Full incident identities for weekly deduplication; absent on legacy editions. */
  depegSignalKeys?: { active: string[] | null; resolved: string[] | null };
  topDepegs: {
    stablecoinId?: string;
    symbol: string;
    /** Signed peak deviation of the open event (kept for archived-row compatibility). */
    bps: number;
    direction?: DepegDirection;
    mcapUsd: number;
    startedAt?: number;
    ageHours?: number;
    impactScore?: number;
    peakBps?: number;
    peakPriceUsd?: number;
    currentPriceUsd?: number;
    /** Prices and deviations share the event's quote domain, never an inferred USD peg. */
    quoteMode?: "native-peg" | "usd";
    peakPriceNative?: number;
    currentPriceNative?: number;
    /** Signed deviation computed from the live price vs the event's peg reference. */
    currentBps?: number;
    /** Event reference and producing quote time; absent on legacy archived rows. */
    pegReference?: number;
    priceObservedAt?: number;
    /** Which deviation severity decisions were made on: live price ("current") or the stored peak ("peak-fallback"). */
    severityBasis?: "current" | "peak-fallback";
    suppressReason?: string;
  }[];
  biggestSupplyChange: {
    id: string;
    symbol: string;
    name: string;
    changeUsd: number;
    currentMcap: number;
  } | null;
  stabilityIndex: {
    score: number;
    band: string;
    components: {
      severity: number | null;
      breadth: number | null;
      stressBreadth?: number | null;
      trend: number | null;
    };
  } | null;
  yesterdayIndex: { score: number; band: string } | null;
  blacklistActivity?: {
    eventCount: number;
    /** Promotion is editorial only; all observed events remain in accounting. */
    editorialEligible?: boolean;
    /** Sum of the known amounts only: a lower bound when `unpricedEventCount > 0`. */
    totalAmountUsd: number;
    /** Events whose USD amount could not be priced; their `amountUsd` is null. */
    unpricedEventCount?: number;
    topEvents: { symbol: string; chain: string; type: "blacklist" | "destroy"; amountUsd: number | null }[];
  };
  supplyVelocity?: {
    /** Present on current captures; archived rows keep the symbol-only shape. */
    stablecoinId?: string;
    coin: string;
    change1d: number;
    change7d: number;
    signal: string;
  }[];
  supplyChanges7d?: {
    /** Present on current captures; archived rows keep the symbol-only shape. */
    stablecoinId?: string;
    coin: string;
    change7d: number;
  }[];
  safetyScores?: DigestSafetyScores;
  resolvedDepegs?: {
    stablecoinId?: string;
    symbol: string;
    peakBps: number;
    direction?: DepegDirection;
    durationHours: number;
    mcapUsd: number;
    startedAt?: number;
    endedAt?: number;
    impactScore?: number;
  }[];
  mintBurnFlows?: {
    gaugeScore: number;
    gaugeBand: string;
    /** Exact source capture; absent on archived editions that predate provenance. */
    provenance?: {
      window: NonNullable<MintBurnFlowsResponse["window"]> | null;
      /** Producer cache publication timestamp; not a unique generation ID. */
      publishedAt: number;
      /** Producer body clock; unavailable on legacy or unreadable payloads. */
      updatedAt: number | null;
    };
    // `report-card-cache` is retained only for archived digest snapshots.
    classificationSource?: "safety-score-v9-publication" | "report-card-cache" | "unavailable";
    classificationReason?: string | null;
    safetyScoreIdentity?: SafetyScorePublicationIdentity | null;
    flightToQuality: {
      active: boolean;
      safeNetUsd: number;
      riskyNetUsd: number;
    };
    topPressure: {
      symbol: string;
      intensity: number;
      net24hUsd: number;
      /** Share of the published scored weight; absent on archived captures. */
      gaugeWeightShare?: number | null;
    }[];
    topChains?: {
      chainId: string;
      netUsd: number;
    }[];
  };
  dewsStress?: {
    bandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number };
    /** Prior generation's distribution, or null when no prior rows were observed. */
    yesterdayBandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number } | null;
    /** Full admitted ALERT+ known-supply subtotal; null when no supply was observed. */
    alertPlusMcapUsd?: number | null;
    alertPlusSupplyCoverage?: z.infer<typeof DigestSupplyCoverageSchema>;
    /** Full rank-changing census before presentation slicing; null without a prior generation. */
    bandChangeCount?: number | null;
    bandChanges: {
      symbol: string;
      from: string;
      to: string;
      score: number;
      topDriver: string;
      mcapUsd?: number;
    }[];
    elevatedCoins: {
      symbol: string;
      band: string;
      score: number;
      mcapUsd: number;
      topSignals?: { name: string; value: number }[];
      changeFromYesterday?: number;
    }[];
  };
  historicalContext?: {
    psiPrecedent: {
      lastSeenDate: number;
      lastSeenDaysAgo: number;
      lastSeenScore: number;
      lastSeenBand: string;
    } | null;
    psiBandStreak: number;
    /** Days from the first core-universe digest to today: the window the PSI precedent query reads. */
    digestTrackingDays: number;
    supplyMoverContext: {
      allTimeHighMcap: number;
      allTimeHighDate: number;
      largestWeeklyChange: number;
      largestWeeklyChangeDate: number;
      largestWeeklyChangeDaysAgo: number;
    } | null;
  };
  psiContributors?: {
    symbol: string;
    bps: number;
    mcapUsd: number;
    marketImpact: number;
  }[];
  gradeTransitions?: DigestGradeTransition[];
  /** Complete slim organic census; gradeTransitions is a presentation-only top five. */
  gradeTransitionAccounting?: DigestGradeTransitionAccounting;
  yieldAnomalies?: {
    symbol: string;
    currentApy: number;
    apy7d: number;
    apy30d: number;
    warnings: string[];
    mcapUsd: number;
  }[];
  liquidityShifts?: {
    symbol: string;
    currentScore: number;
    previousScore: number;
    scoreDelta: number;
    currentTvl: number;
    previousTvl: number;
    mcapUsd: number;
    /** Fractional raw-TVL change over the compared day, e.g. -0.42. */
    tvlChangePct: number | null;
    /**
     * Composite move the TVL change alone implies under the current
     * methodology's log-scale TVL Depth component. Present so coverage cannot
     * read log compression as the score ignoring a real liquidity move.
     */
    expectedScoreDeltaFromTvl: number | null;
    /** Coverage provenance of the newer row (`primary` or `mixed`; others are inadmissible). */
    coverageClass: string;
    coverageConfidence: number;
  }[];
  crossDayTrends?: {
    psiTrajectory: { date: string; score: number; band: string }[];
    mcapTrajectory: { date: string; mcapUsd: number }[];
    gaugeTrajectory: { date: string; gaugeScore: number }[] | null;
  };
}

const DigestRiskTapeToneSchema = z.enum(["critical", "warning", "neutral", "positive"]);

export const DigestRiskTapeItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  tone: DigestRiskTapeToneSchema,
  detail: z.string().optional(),
});
export type DigestRiskTapeItem = z.infer<typeof DigestRiskTapeItemSchema>;

const DigestSignalChangeSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum([
    "depeg",
    "resolved-depeg",
    "psi",
    "supply",
    "mint-burn",
    "dews",
    "grade",
    "yield",
    "liquidity",
    "blacklist",
    "market",
    "gauge",
  ]),
  symbols: z.array(z.string()),
  detail: z.string(),
});
export type DigestSignalChange = z.infer<typeof DigestSignalChangeSchema>;

export const DigestChangeSummarySchema = z.object({
  previousDate: z.string().nullable().optional(),
  newSignals: z.array(DigestSignalChangeSchema),
  worsenedSignals: z.array(DigestSignalChangeSchema),
  improvedSignals: z.array(DigestSignalChangeSchema),
  resolvedSignals: z.array(DigestSignalChangeSchema),
  repeatedSignals: z.array(DigestSignalChangeSchema),
});
export type DigestChangeSummary = z.infer<typeof DigestChangeSummarySchema>;

export const DigestNextTriggerSchema = z.object({
  id: z.string(),
  label: z.string(),
  metric: z.enum(["depeg-bps", "supply-1d-usd", "supply-7d-usd", "bank-run-gauge", "dews-band", "psi-score", "yield-apy", "liquidity-score"]),
  comparator: z.enum(["abs-gte", "gte", "lte", "band-gte"]),
  thresholdLabel: z.string(),
  thresholdValue: z.number().optional(),
  symbol: z.string().optional(),
  stablecoinId: z.string().optional(),
  candidateId: z.string().optional(),
  /** Consecutive prior editions that carried this trigger unchanged (TTL input). */
  repeatedCount: z.number().optional(),
  rationale: z.string(),
  detail: z.string(),
});
export type DigestNextTrigger = z.infer<typeof DigestNextTriggerSchema>;

export const DigestStandingConditionSchema = z.object({
  stablecoinId: z.string().optional(),
  symbol: z.string(),
  ageDays: z.number(),
  currentBps: z.number().optional(),
  peakBps: z.number().optional(),
  mcapUsd: z.number().optional(),
});
export type DigestStandingCondition = z.infer<typeof DigestStandingConditionSchema>;

export const DigestForwardLookOutcomeSchema = z.object({
  id: z.string(),
  triggerId: z.string(),
  label: z.string(),
  status: z.enum(["hit", "missed", "pending", "expired", "unavailable"]),
  detail: z.string(),
  sourceDate: z.string().nullable().optional(),
});
export type DigestForwardLookOutcome = z.infer<typeof DigestForwardLookOutcomeSchema>;

const DigestRiskSignalSchema = z.object({
  kind: z.literal("depeg"),
  symbol: z.string(),
  bps: z.number(),
  mcapUsd: z.number().nullable(),
  severity: z.enum(["critical", "watch"]),
  activeCount: z.number().nullable().optional(),
  date: z.string().nullable().optional(),
});
export type DigestRiskSignal = z.infer<typeof DigestRiskSignalSchema>;

export const DailyDigestResponseSchema = z
  .object({
    digest: z.string().nullable(),
    digestTitle: z.string().nullable().optional(),
    digestExtended: z.string().nullable().optional(),
    generatedAt: z.number().nullable().optional(),
    editionNumber: z.number().nullable().optional(),
    riskSignal: DigestRiskSignalSchema.nullable().optional(),
    changeSummary: DigestChangeSummarySchema.nullable().optional(),
    nextTriggers: z.array(DigestNextTriggerSchema).nullable().optional(),
    forwardLookOutcomes: z.array(DigestForwardLookOutcomeSchema).nullable().optional(),
    riskTape: z.array(DigestRiskTapeItemSchema).nullable().optional(),
    standingConditions: z.array(DigestStandingConditionSchema).nullable().optional(),
  })
  .transform((value) => ({
    digest: value.digest,
    digestTitle: value.digestTitle ?? null,
    digestExtended: value.digestExtended ?? null,
    generatedAt: value.generatedAt ?? null,
    editionNumber: value.editionNumber ?? null,
    riskSignal: value.riskSignal ?? null,
    changeSummary: value.changeSummary ?? null,
    nextTriggers: value.nextTriggers ?? null,
    forwardLookOutcomes: value.forwardLookOutcomes ?? null,
    riskTape: value.riskTape ?? null,
    standingConditions: value.standingConditions ?? null,
  }));
export type DailyDigestResponse = z.infer<typeof DailyDigestResponseSchema>;

const DigestModelProvenanceSchema = z.object({ servedModel: z.string().nullable().optional() });

export const DigestArchiveEntrySchema = z.object({
  llm: DigestModelProvenanceSchema.optional(),
  digestText: z.string(),
  digestTitle: z.string().nullable(),
  digestExtended: z.string().nullable(),
  generatedAt: z.number(),
  psiScore: z.number().nullable(),
  psiBand: z.string().nullable(),
  totalMcapUsd: z.number().nullable(),
  supplyCoverage: DigestSupplyCoverageSchema.optional(),
  riskSignal: DigestRiskSignalSchema.nullable().optional(),
  nextTriggers: z.array(DigestNextTriggerSchema).nullable().optional(),
  forwardLookOutcomes: z.array(DigestForwardLookOutcomeSchema).nullable().optional(),
  riskTape: z.array(DigestRiskTapeItemSchema).nullable().optional(),
  digestType: DigestKindSchema.optional(),
  editionNumber: z.number().optional(),
  /**
   * Editorial style policy that produced the edition. Absent on editions
   * authored before the policy existed; those read back as `pre-policy` rather
   * than being back-filled, so an archive edition is never claimed to have
   * followed rules that did not exist. See docs/editorial-style.md.
   */
  editorialStyleVersion: z.string().optional(),
  editorialStyleHash: z.string().optional(),
});
export type DigestArchiveEntry = z.infer<typeof DigestArchiveEntrySchema>;

// Cursor: insertion horizon, full row count, rows scanned, last generation/id.
// Internal sentinels count toward traversal and edition numbering, not output.
export const DigestArchiveCursorSchema = z.tuple([
  z.number().int().nonnegative().safe(),
  z.number().int().nonnegative().safe(),
  z.number().int().nonnegative().safe(),
  z.number().int().nonnegative().safe(),
  z.number().int().positive().safe(),
]);
export const DigestArchivePaginationSchema = z.object({
  horizon: z.number().int().nonnegative().safe(),
  total: z.number().int().nonnegative().safe(),
  scanned: z.number().int().nonnegative().safe(),
  nextCursor: z.string().nullable(),
});

export const DigestArchiveResponseSchema = z.object({
  digests: z.array(DigestArchiveEntrySchema),
  pagination: DigestArchivePaginationSchema.optional(),
});
export type DigestArchiveResponse = z.infer<typeof DigestArchiveResponseSchema>;

export const DigestPromoEditionSchema = z.object({
  digestTitle: z.string().nullable(),
  editionNumber: z.number().int().positive(),
  generatedAt: z.number().int().nonnegative(),
  slug: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type DigestPromoEdition = z.infer<typeof DigestPromoEditionSchema>;

export const DigestPromoResponseSchema = z.object({
  latest: DigestPromoEditionSchema.extend({ excerpt: z.string().nullable() }).nullable(),
  previousEditions: z.array(DigestPromoEditionSchema).max(2),
});
export type DigestPromoResponse = z.infer<typeof DigestPromoResponseSchema>;

/**
 * Build-time digest archive written to data/digests.json. Older snapshots may
 * omit edition metadata, so parsing deliberately normalizes those fields to
 * the same defaults used by the sync producer.
 */
export const DigestStoredSnapshotSchema = z.array(
  z.object({
    llm: DigestArchiveEntrySchema.shape.llm,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:-weekly)?$/),
    title: DigestArchiveEntrySchema.shape.digestTitle.unwrap(),
    text: DigestArchiveEntrySchema.shape.digestText,
    extended: DigestArchiveEntrySchema.shape.digestExtended.unwrap(),
    generatedAt: DigestArchiveEntrySchema.shape.generatedAt,
    digestType: DigestArchiveEntrySchema.shape.digestType.default("daily"),
    editionNumber: DigestArchiveEntrySchema.shape.editionNumber.default(0),
    /**
     * Absent on editions authored before the policy. Storage stays optional and
     * archives are never back-filled; the `pre-policy` sentinel is computed at
     * the API and UI read boundary, never written into the snapshot.
     */
    editorialStyleVersion: DigestArchiveEntrySchema.shape.editorialStyleVersion,
    editorialStyleHash: DigestArchiveEntrySchema.shape.editorialStyleHash,
  }),
);
export type DigestContentEntry = z.infer<typeof DigestStoredSnapshotSchema>[number];

const DigestV8SafetyProvenanceSchema = SafetyScoreV8PublicationIdentitySchema.extend({
  publishedAt: z.number().int().nonnegative(),
});

const DigestV9SafetyProvenanceSchema = SafetyScoreV9PublicationIdentitySchema.extend({
  publishedAt: z.number().int().nonnegative(),
});

const DigestV8SafetyScoresSnapshotSchema = z
  .object({
    model: z.literal("v8").optional(),
    mentionedCoins: z.array(
      z
        .object({
          symbol: z.string(),
          grade: z.string().optional(),
          score: z.number().optional(),
          peg: z.number().nullable().optional(),
          liq: z.number().nullable().optional(),
        })
        .passthrough(),
    ),
    medianGrade: z.string(),
    aboveBCount: z.number(),
    fCount: z.number(),
    provenance: DigestV8SafetyProvenanceSchema.optional(),
  })
  .passthrough();

const DigestV9SafetyScoresSnapshotSchema = z
  .object({
    model: z.literal("v9"),
    mentionedCoins: z.array(DigestV9SafetyCoinSchema),
    gradeDistribution: z.record(z.string(), z.number()),
    provenance: DigestV9SafetyProvenanceSchema,
  })
  .passthrough();

// Validate the impactful fields actually rendered by digest-snapshot.tsx so
// snapshot drift/corruption is caught at the contract boundary, while keeping
// .passthrough() to preserve the many other DigestInputData fields untouched.
// Fields are optional (the consumer applies ?? fallbacks and older snapshots
// may omit them); the goal is type-safety, not presence enforcement.
const DigestSnapshotInputDataSchema = z
  .object({
    aggregateUniverse: z.literal("core-stablecoins-v1").optional(),
    totalMcapUsd: z.number().optional(),
    supplyCoverage: DigestSupplyCoverageSchema.optional(),
    mcap7dDelta: z.number().nullable().optional(),
    mcap7dDeltaCoverage: DigestMcap7dDeltaCoverageSchema.optional(),
    activeDepegCount: z.number().nullable().optional(),
    resolvedDepegCount: z.number().nullable().optional(),
    depegSignalKeys: z.object({
      active: z.array(z.string()).nullable(),
      resolved: z.array(z.string()).nullable(),
    }).optional(),
    degradedSources: z.array(z.string()).optional(),
    changeSummary: DigestChangeSummarySchema.optional(),
    nextTriggers: z.array(DigestNextTriggerSchema).optional(),
    forwardLookOutcomes: z.array(DigestForwardLookOutcomeSchema).optional(),
    riskTape: z.array(DigestRiskTapeItemSchema).optional(),
    safetyContext: DigestSafetyContextSchema.optional(),
    // The frontend accepts pre-cutover aliases and performs its own complete,
    // capture-matched parse before rendering; preserve that raw compatibility here.
    safetyMap: z.unknown().optional(),
    topDepegs: z
      .array(
        z
          .object({
            stablecoinId: z.string().optional(),
            symbol: z.string(),
            bps: z.number(),
            direction: z.string().optional(),
            mcapUsd: z.number(),
            startedAt: z.number().optional(),
            currentBps: z.number().optional(),
            pegReference: z.number().positive().optional(),
            priceObservedAt: z.number().optional(),
            quoteMode: z.enum(["native-peg", "usd"]).optional(),
            peakPriceNative: z.number().positive().optional(),
            currentPriceNative: z.number().positive().optional(),
            severityBasis: z.enum(["current", "peak-fallback"]).optional(),
          })
          .passthrough(),
      )
      .optional(),
    standingConditions: z.array(DigestStandingConditionSchema).optional(),
    stabilityIndex: z
      .object({
        score: z.number(),
        band: z.string(),
        components: z
          .object({
            severity: z.number().nullable(),
            breadth: z.number().nullable(),
            stressBreadth: z.number().nullable().optional(),
            trend: z.number().nullable(),
          })
          .passthrough(),
      })
      .passthrough()
      .nullable()
      .optional(),
    biggestSupplyChange: z
      .object({
        id: z.string().optional(),
        symbol: z.string(),
        name: z.string(),
        changeUsd: z.number(),
        currentMcap: z.number(),
      })
      .passthrough()
      .nullable()
      .optional(),
    safetyScores: z
      .union([DigestV9SafetyScoresSnapshotSchema, DigestV8SafetyScoresSnapshotSchema])
      .optional(),
    yieldAnomalies: z
      .array(
        z
          .object({
            symbol: z.string(),
            currentApy: z.number(),
            apy7d: z.number(),
            apy30d: z.number(),
            warnings: z.array(z.string()),
          })
          .passthrough(),
      )
      .optional(),
    liquidityShifts: z
      .array(
        z
          .object({
            symbol: z.string(),
            currentScore: z.number(),
            previousScore: z.number(),
            scoreDelta: z.number(),
            currentTvl: z.number(),
            // Added with the #179 liquidity admission gate; archived rows predate them.
            tvlChangePct: z.number().nullable().optional(),
            expectedScoreDeltaFromTvl: z.number().nullable().optional(),
            coverageClass: z.string().optional(),
            coverageConfidence: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),
    supplyVelocity: z
      .array(
        z
          .object({
            coin: z.string(),
            change1d: z.number(),
            change7d: z.number(),
            signal: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    resolvedDepegs: z
      .array(
        z
          .object({
            symbol: z.string(),
            peakBps: z.number(),
            durationHours: z.number(),
            mcapUsd: z.number(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type DigestSnapshotInputData = z.infer<typeof DigestSnapshotInputDataSchema>;

const DigestSnapshotDepegEventSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  direction: z.string(),
  peakDeviationBps: z.number(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});

const DigestSnapshotBlacklistEventSchema = z.object({
  stablecoin: z.string(),
  chainName: z.string(),
  eventType: z.string(),
  address: z.string(),
  amountNative: z.number().nullable(),
  amountUsdAtEvent: z.number().nullable(),
  amountStatus: z.string(),
  timestamp: z.number(),
});

export const DigestSnapshotResponseSchema = z.object({
  date: z.string(),
  inputData: DigestSnapshotInputDataSchema.nullable(),
  prevInputData: DigestSnapshotInputDataSchema.nullable(),
  comparison: z.object({
    fromDate: DigestSafetyMapUtcDateSchema,
    toDate: DigestSafetyMapUtcDateSchema,
    supplyComparable: z.boolean(),
  }).refine((comparison) => comparison.fromDate < comparison.toDate, {
    message: "Comparison endpoints must be chronological",
  }).nullable().optional().describe("Actual captured daily endpoints; absent or null means the comparison interval is unproven. Supply deltas additionally require supplyComparable."),
  depegEvents: z.array(DigestSnapshotDepegEventSchema),
  blacklistEvents: z.array(DigestSnapshotBlacklistEventSchema),
  blacklistSummary: z.object({
    totalEvents: z.number().int().nonnegative(),
    knownAmountUsd: z.number().nullable(),
    valuedEvents: z.number().int().nonnegative(),
    unavailableAmountEvents: z.number().int().nonnegative(),
  }).optional().describe("Full unsuppressed UTC-day cohort; blacklistEvents is only the latest 50-row sample. Missing while the requested UTC day is still open, and on legacy snapshots where totals/valuation are unknown."),
});
export type DigestSnapshotResponse = z.infer<typeof DigestSnapshotResponseSchema>;
