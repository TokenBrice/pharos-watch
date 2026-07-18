import type { DigestInputData } from "@shared/types/digest";

export type WeeklyRiskKind = "depeg" | "dews" | "mint-burn" | "blacklist" | "grade" | "yield" | "liquidity" | "supply";

export interface WeeklyDepegSignal {
  id: string;
  symbol: string;
  label: string;
  impactScore: number;
  severityScore: number;
  mcapUsd: number;
  bps: number;
  date: string;
  kind: "active" | "resolved";
  critical: boolean;
  /** Event started before this week's window — a standing condition, not fresh weekly news. */
  carriedOver?: boolean;
  suppressReason?: string;
}

export type SpikeDepeg = Pick<
  WeeklyDepegSignal,
  "id" | "date" | "symbol" | "bps" | "mcapUsd" | "impactScore" | "kind" | "critical"
>;

export interface WeeklyRiskLeaderboardSignal {
  id: string;
  kind: WeeklyRiskKind;
  label: string;
  symbols: string[];
  impactScore: number;
  severityScore: number;
  date?: string;
  critical?: boolean;
  /** Signal predates this week's window — a standing condition, not fresh news. */
  carriedOver?: boolean;
  suppressReason?: string;
}

export interface WeeklySpikeMetrics {
  minPsi: { date: string; score: number; band: string } | null;
  minGauge: { date: string; score: number } | null;
  maxDepeg: SpikeDepeg | null;
  maxDepegImpact: SpikeDepeg | null;
}

export interface WeeklyInputData {
  weekStartDate: string;
  weekEndDate: string;
  periodType: "trailing-daily-editions";
  dailyDigests: { date: string; title: string; text: string; inputData: DigestInputData }[];
  psiRange: { min: number; max: number; start: number; end: number; dominantBand: string };
  mcapRange: { start: number; end: number; netChange: number; pctChange: number | null };
  activeDepegObservationsThisWeek: number;
  uniqueDepegSignalsThisWeek: number;
  totalBlacklistEventsThisWeek: number;
  totalBlacklistAmountUsd: number;
  gradeTransitionCount: number;
  gaugeRange: { min: number; max: number } | null;
  spikeMetrics: WeeklySpikeMetrics;
  weeklySignals: {
    riskLeaderboard: WeeklyRiskLeaderboardSignal[];
    topDepegSignals: WeeklyDepegSignal[];
    topSupplySignals: { symbol: string; label: string; amountUsd: number }[];
    topDewsChanges: { symbol: string; from: string; to: string; score: number; mcapUsd: number; driver: string }[];
    maxAlertPlusMcapUsd: number;
    topPressureSignals: { symbol: string; intensity: number; net24hUsd: number; date: string }[];
    topBlacklistEvents: { symbol: string; chain: string; type: string; amountUsd: number; date: string }[];
    topGradeTransitions: { symbol: string; fromGrade: string; toGrade: string; mcapUsd: number; date: string }[];
    topYieldAnomalies: { symbol: string; apy: number; warnings: string[]; mcapUsd: number; date: string }[];
    topLiquidityShifts: { symbol: string; scoreDelta: number; mcapUsd: number; date: string }[];
  };
  /** Aggregate forward-look accountability across the week's daily editions. */
  forwardLookScoreboard: { hit: number; missed: number; pending: number; expired: number } | null;
  weekOverWeekDeltas: {
    mcap: { current: number; prior: number; deltaPct: number | null };
    psi: { current: number; prior: number; delta: number };
    psiDominantBand: { current: string; prior: string };
    activeDepegObservations: { current: number; prior: number };
    uniqueDepegSignals: { current: number; prior: number };
    blacklistEvents: { current: number; prior: number };
    blacklistUsd: { current: number; prior: number };
    gradeTransitions: { current: number; prior: number };
    gauge: { current: number | null; prior: number | null };
    dataCoverage: { currentDays: number; priorDays: number };
  } | null;
}

export interface WeeklyParsedRow {
  inputData: DigestInputData;
  date: string;
  title: string;
  text: string;
}

export interface DailyDigestSourceRow {
  generated_at: number;
  digest_title: string | null;
  digest_text: string;
  digest_extended?: string | null;
  input_data: string;
}
