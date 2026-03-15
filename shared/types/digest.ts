export interface DigestInputData {
  totalMcapUsd: number;
  mcap7dDelta: number;
  activeDepegCount: number;
  topDepegs: { symbol: string; bps: number; mcapUsd: number }[];
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
    symbol: string;
    peakBps: number;
    durationHours: number;
    mcapUsd: number;
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
    }[];
    elevatedCoins: {
      symbol: string;
      band: string;
      score: number;
      mcapUsd: number;
      topSignals?: { name: string; value: number }[];
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
}

export interface DailyDigestResponse {
  digest: string | null;
  digestTitle?: string | null;
  digestExtended?: string | null;
  generatedAt?: number | null;
}

export interface DigestArchiveEntry {
  digestText: string;
  digestTitle: string | null;
  digestExtended: string | null;
  generatedAt: number;
  psiScore: number | null;
  psiBand: string | null;
  totalMcapUsd: number | null;
}

export interface DigestArchiveResponse {
  digests: DigestArchiveEntry[];
}

export interface StablecoinChartPoint {
  date: number;
  totalCirculatingUSD: Record<string, number>;
}

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
    amount: number | null;
    timestamp: number;
  }>;
}
