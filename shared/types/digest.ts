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
}

export interface DigestArchiveEntry {
  digestText: string;
  digestTitle: string | null;
  digestExtended: string | null;
  generatedAt: number;
  psiScore: number | null;
  psiBand: string | null;
  totalMcapUsd: number | null;
  digestType?: "daily" | "weekly";
  editionNumber?: number;
}

export interface DigestArchiveResponse {
  digests: DigestArchiveEntry[];
}

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
