import { z } from "zod";

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

export interface DigestRiskTapeItem {
  id: string;
  label: string;
  value: string;
  tone: DigestRiskTapeTone;
  detail?: string;
}

export interface DigestSignalChange {
  id: string;
  label: string;
  kind: DigestEditorialCandidateKind | "psi" | "gauge";
  symbols: string[];
  detail: string;
}

export interface DigestChangeSummary {
  previousDate?: string | null;
  newSignals: DigestSignalChange[];
  worsenedSignals: DigestSignalChange[];
  improvedSignals: DigestSignalChange[];
  resolvedSignals: DigestSignalChange[];
  repeatedSignals: DigestSignalChange[];
}

export type DigestNextTriggerMetric =
  | "depeg-bps"
  | "supply-1d-usd"
  | "supply-7d-usd"
  | "bank-run-gauge"
  | "dews-band"
  | "psi-score";

export type DigestNextTriggerComparator = "abs-gte" | "gte" | "lte" | "band-gte";

export interface DigestNextTrigger {
  id: string;
  label: string;
  metric: DigestNextTriggerMetric;
  comparator: DigestNextTriggerComparator;
  thresholdLabel: string;
  thresholdValue?: number;
  symbol?: string;
  candidateId?: string;
  rationale: string;
  detail: string;
}

export interface DigestForwardLookOutcome {
  id: string;
  triggerId: string;
  label: string;
  status: "hit" | "missed" | "pending";
  detail: string;
  sourceDate?: string | null;
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
  leadCandidateId?: string | null;
  leadCandidateTitle?: string | null;
  usedCandidateIds?: string[];
  modelSuppressedCandidateIds?: string[];
  qualityIssueCodes?: string[];
}

export interface DigestInputData {
  digestVersion?: number;
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
  activeDepegCount: number;
  topDepegs: {
    stablecoinId?: string;
    symbol: string;
    bps: number;
    direction?: "above" | "below";
    mcapUsd: number;
    startedAt?: number;
    ageHours?: number;
    impactScore?: number;
    peakBps?: number;
    peakPriceUsd?: number;
    currentPriceUsd?: number;
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
  safetyScores?: {
    mentionedCoins: { symbol: string; grade: string; score: number; peg: number | null; liq: number | null }[];
    medianGrade: string;
    aboveBCount: number;
    fCount: number;
  };
  resolvedDepegs?: {
    stablecoinId?: string;
    symbol: string;
    peakBps: number;
    direction?: "above" | "below";
    durationHours: number;
    mcapUsd: number;
    startedAt?: number;
    endedAt?: number;
    impactScore?: number;
  }[];
  mintBurnFlows?: {
    gaugeScore: number;
    gaugeBand: string;
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
  gradeTransitions?: {
    symbol: string;
    fromGrade: string;
    toGrade: string;
    fromScore: number;
    toScore: number;
    currentDimensions: {
      peg: number | null;
      liq: number | null;
      resilience: number | null;
      decentralization: number | null;
    };
    mcapUsd: number;
  }[];
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
  }[];
  crossDayTrends?: {
    psiTrajectory: { date: string; score: number; band: string }[];
    mcapTrajectory: { date: string; mcapUsd: number }[];
    gaugeTrajectory: { date: string; gaugeScore: number }[] | null;
  };
}

export interface DailyDigestResponse {
  digest: string | null;
  digestTitle: string | null;
  digestExtended: string | null;
  generatedAt: number | null;
  editionNumber: number | null;
  riskSignal?: DigestRiskSignal | null;
  changeSummary?: DigestChangeSummary | null;
  nextTriggers?: DigestNextTrigger[] | null;
  forwardLookOutcomes?: DigestForwardLookOutcome[] | null;
  riskTape?: DigestRiskTapeItem[] | null;
}

const DigestRiskTapeToneSchema = z.enum(["critical", "warning", "neutral", "positive"]);

const DigestRiskTapeItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  tone: DigestRiskTapeToneSchema,
  detail: z.string().optional(),
});

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

const DigestChangeSummarySchema = z.object({
  previousDate: z.string().nullable().optional(),
  newSignals: z.array(DigestSignalChangeSchema),
  worsenedSignals: z.array(DigestSignalChangeSchema),
  improvedSignals: z.array(DigestSignalChangeSchema),
  resolvedSignals: z.array(DigestSignalChangeSchema),
  repeatedSignals: z.array(DigestSignalChangeSchema),
});

const DigestNextTriggerSchema = z.object({
  id: z.string(),
  label: z.string(),
  metric: z.enum(["depeg-bps", "supply-1d-usd", "supply-7d-usd", "bank-run-gauge", "dews-band", "psi-score"]),
  comparator: z.enum(["abs-gte", "gte", "lte", "band-gte"]),
  thresholdLabel: z.string(),
  thresholdValue: z.number().optional(),
  symbol: z.string().optional(),
  candidateId: z.string().optional(),
  rationale: z.string(),
  detail: z.string(),
});

const DigestForwardLookOutcomeSchema = z.object({
  id: z.string(),
  triggerId: z.string(),
  label: z.string(),
  status: z.enum(["hit", "missed", "pending"]),
  detail: z.string(),
  sourceDate: z.string().nullable().optional(),
});

export interface DigestRiskSignal {
  kind: "depeg";
  symbol: string;
  bps: number;
  mcapUsd: number | null;
  severity: "critical" | "watch";
  activeCount?: number;
  date?: string | null;
}

const DigestRiskSignalSchema = z.object({
  kind: z.literal("depeg"),
  symbol: z.string(),
  bps: z.number(),
  mcapUsd: z.number().nullable(),
  severity: z.enum(["critical", "watch"]),
  activeCount: z.number().optional(),
  date: z.string().nullable().optional(),
});

export const DailyDigestResponseSchema = z.object({
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
}).transform((value): DailyDigestResponse => ({
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
}));

export interface DigestArchiveEntry {
  digestText: string;
  digestTitle: string | null;
  digestExtended: string | null;
  generatedAt: number;
  psiScore: number | null;
  psiBand: string | null;
  totalMcapUsd: number | null;
  riskSignal?: DigestRiskSignal | null;
  nextTriggers?: DigestNextTrigger[] | null;
  forwardLookOutcomes?: DigestForwardLookOutcome[] | null;
  riskTape?: DigestRiskTapeItem[] | null;
  digestType?: "daily" | "weekly";
  editionNumber?: number;
}

export interface DigestArchiveResponse {
  digests: DigestArchiveEntry[];
}

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

export const DigestArchiveResponseSchema = z.object({
  digests: z.array(DigestArchiveEntrySchema),
});

export interface StablecoinChartPoint {
  date: number;
  totalCirculatingUSD: Record<string, number>;
}

export const StablecoinChartResponseSchema = z.array(z.object({
  date: z.number(),
  totalCirculatingUSD: z.record(z.string(), z.number()),
}));

export interface UsdsStatusResponse {
  freezeActive: boolean;
  implementationAddress: string;
  lastChecked: number;
}

const UsdsImplementationAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid implementation address")
  .transform((value) => value.toLowerCase());

export const UsdsStatusResponseSchema = z.object({
  implementationAddress: UsdsImplementationAddressSchema,
  freezeActive: z.unknown().optional(),
  lastChecked: z.unknown().optional(),
}).transform((value): UsdsStatusResponse => ({
  freezeActive: typeof value.freezeActive === "boolean" ? value.freezeActive : false,
  implementationAddress: value.implementationAddress,
  lastChecked:
    typeof value.lastChecked === "number" && Number.isFinite(value.lastChecked) && value.lastChecked >= 0
      ? Math.floor(value.lastChecked)
      : 0,
}));

export interface DigestSnapshotResponse {
  date: string;
  inputData: DigestInputData | null;
  prevInputData: DigestInputData | null;
  depegEvents: Array<{
    stablecoinId: string;
    symbol: string;
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
  }>;
  blacklistEvents: Array<{
    stablecoin: string;
    chainName: string;
    eventType: string;
    address: string;
    amountNative: number | null;
    amountUsdAtEvent: number | null;
    amountStatus: string;
    timestamp: number;
  }>;
}
