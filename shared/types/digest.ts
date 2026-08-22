import { z } from "zod";
import type { DepegDirection } from "./market";
import {
  SafetyScorePublicationIdentitySchema,
  SafetyScoreV8PublicationIdentitySchema,
  SafetyScoreV9PublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
  type SafetyScoreV8PublicationIdentity,
  type SafetyScoreV9PublicationIdentity,
} from "./safety-score-publication";

export type DigestSafetyContext =
  | {
      status: "available";
      expectedModel: SafetyScorePublicationIdentity["model"];
      identity: SafetyScorePublicationIdentity;
      publishedAt: number;
      reason: null;
    }
  | {
      status: "unavailable";
      expectedModel: SafetyScorePublicationIdentity["model"];
      identity: null;
      publishedAt: null;
      reason: string;
    };

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

export interface DigestV8SafetyCoin {
  symbol: string;
  grade: string;
  score: number;
  peg: number | null;
  liq: number | null;
}

export interface DigestV9SafetyPillar {
  score: number | null;
  evidenceLevel: string;
  freshness: string;
  reasons: { code: string; message: string }[];
}

export interface DigestV9SafetyCap {
  kind: string;
  limit: number;
  reason: string;
  binding: boolean;
}

export interface DigestV9SafetyCoin {
  symbol: string;
  grade: string;
  score: number | null;
  pillars: {
    backing: DigestV9SafetyPillar;
    exit: DigestV9SafetyPillar;
    control: DigestV9SafetyPillar;
  };
  reasonCodes: string[];
  caps: DigestV9SafetyCap[];
  bindingCap: DigestV9SafetyCap | null;
}

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
    mintBurnFlows: { label: string; start: number; end: number };
    supplyVelocity: { label: string; dates: number[] };
    psi: { label: string; sampleAt: number | null; dailySnapshotAt: number | null };
  };
}

export type DigestRiskTapeTone = "critical" | "warning" | "neutral" | "positive";

export type DigestNextTriggerMetric =
  "depeg-bps" | "supply-1d-usd" | "supply-7d-usd" | "bank-run-gauge" | "dews-band" | "psi-score" | "yield-apy" | "liquidity-score";

export type DigestNextTriggerComparator = "abs-gte" | "gte" | "lte" | "band-gte";

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

export interface DigestInputData {
  digestVersion?: number;
  aggregateUniverse?: "core-stablecoins-v1";
  totalMcapUsd: number;
  mcap7dDelta: number;
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
  activeDepegCount: number;
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
    /** Signed deviation computed from the live price vs the event's peg reference. */
    currentBps?: number;
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
      severity: number;
      breadth: number;
      stressBreadth?: number;
      trend: number;
    };
  } | null;
  yesterdayIndex: { score: number; band: string } | null;
  blacklistActivity?: {
    eventCount: number;
    totalAmountUsd: number;
    topEvents: { symbol: string; chain: string; type: "blacklist" | "destroy"; amountUsd: number }[];
  };
  supplyVelocity?: {
    coin: string;
    change1d: number;
    change7d: number;
    signal: string;
  }[];
  supplyChanges7d?: {
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
    }[];
    topChains?: {
      chainId: string;
      netUsd: number;
    }[];
  };
  dewsStress?: {
    bandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number };
    yesterdayBandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number };
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
    /** How many days of digest history exist (from first digest to today) */
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
  status: z.enum(["hit", "missed", "pending", "expired"]),
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
  activeCount: z.number().optional(),
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

const DigestArchiveEntrySchema = z.object({
  digestText: z.string(),
  digestTitle: z.string().nullable(),
  digestExtended: z.string().nullable(),
  generatedAt: z.number(),
  psiScore: z.number().nullable(),
  psiBand: z.string().nullable(),
  totalMcapUsd: z.number().nullable(),
  riskSignal: DigestRiskSignalSchema.nullable().optional(),
  nextTriggers: z.array(DigestNextTriggerSchema).nullable().optional(),
  forwardLookOutcomes: z.array(DigestForwardLookOutcomeSchema).nullable().optional(),
  riskTape: z.array(DigestRiskTapeItemSchema).nullable().optional(),
  digestType: z.enum(["daily", "weekly"]).optional(),
  editionNumber: z.number().optional(),
});
export type DigestArchiveEntry = z.infer<typeof DigestArchiveEntrySchema>;

export const DigestArchiveResponseSchema = z.object({
  digests: z.array(DigestArchiveEntrySchema),
});
export type DigestArchiveResponse = z.infer<typeof DigestArchiveResponseSchema>;

const DigestV8SafetyProvenanceSchema = SafetyScoreV8PublicationIdentitySchema.extend({
  publishedAt: z.number().int().nonnegative(),
});

const DigestV9SafetyProvenanceSchema = SafetyScoreV9PublicationIdentitySchema.extend({
  publishedAt: z.number().int().nonnegative(),
});

const DigestV9SafetyPillarSchema = z
  .object({
    score: z.number().nullable(),
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
    mentionedCoins: z.array(
      z
        .object({
          symbol: z.string(),
          grade: z.string(),
          score: z.number().nullable(),
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
        .passthrough(),
    ),
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
    mcap7dDelta: z.number().optional(),
    activeDepegCount: z.number().optional(),
    changeSummary: DigestChangeSummarySchema.optional(),
    nextTriggers: z.array(DigestNextTriggerSchema).optional(),
    forwardLookOutcomes: z.array(DigestForwardLookOutcomeSchema).optional(),
    riskTape: z.array(DigestRiskTapeItemSchema).optional(),
    safetyContext: DigestSafetyContextSchema.optional(),
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
            severity: z.number(),
            breadth: z.number(),
            stressBreadth: z.number().optional(),
            trend: z.number(),
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
  depegEvents: z.array(DigestSnapshotDepegEventSchema),
  blacklistEvents: z.array(DigestSnapshotBlacklistEventSchema),
});
export type DigestSnapshotResponse = z.infer<typeof DigestSnapshotResponseSchema>;
