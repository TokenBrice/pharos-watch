import type { DigestForwardLookOutcome, DigestInputData, DigestSafetyContext } from "@shared/types/digest";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";

export type WeeklyRiskKind = "depeg" | "dews" | "mint-burn" | "blacklist" | "grade" | "yield" | "liquidity" | "supply";

export interface WeeklyDepegSignal {
  id: string;
  /** Stable identity shared by active and resolved observations of one event. */
  eventIdentity: string;
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
  safetyContext?: DigestSafetyContext;
  degradedSources?: string[];
  dailyDigests: { date: string; title: string; text: string; inputData: DigestInputData }[];
  psiRange: { min: number; max: number; start: number; end: number; dominantBand: string };
  mcapRange: { start: number | null; end: number | null; netChange: number | null; pctChange: number | null; unavailableReason?: string };
  /** Cross-day totals: null when the window did not observe every daily edition. */
  activeDepegObservationsThisWeek: number | null;
  uniqueDepegSignalsThisWeek: number | null;
  totalBlacklistEventsThisWeek: number | null;
  totalBlacklistAmountUsd: number | null;
  blacklistUnpricedEventCount?: number | null;
  metricUnavailableReasons?: Partial<Record<"mcapEnd" | "activeDepegObs" | "uniqueDepegSignals" | "blacklistEvents" | "blacklistUsd" | "gradeTransitions", string[]>>;
  /** Null when canonical safety evidence is unavailable; zero is an observed quiet week. */
  gradeTransitionCount: number | null;
  gaugeRange: { min: number; max: number } | null;
  spikeMetrics: WeeklySpikeMetrics;
  weeklySignals: {
    riskLeaderboard: WeeklyRiskLeaderboardSignal[];
    topDepegSignals: WeeklyDepegSignal[];
    topSupplySignals: { symbol: string; label: string; amountUsd: number }[];
    topDewsChanges: { symbol: string; from: string; to: string; score: number; mcapUsd: number; driver: string }[];
    maxAlertPlusMcapUsd: number;
    topPressureSignals: { symbol: string; intensity: number; net24hUsd: number; date: string }[];
    topBlacklistEvents: { symbol: string; chain: string; type: string; amountUsd: number | null; date: string }[];
    topGradeTransitions: {
      historyId: string;
      recordedAt: number;
      model: SafetyScorePublicationIdentity["model"];
      safetyScoreIdentity: SafetyScorePublicationIdentity;
      symbol: string;
      fromGrade: string;
      toGrade: string;
      mcapUsd: number;
      date: string;
    }[];
    topYieldAnomalies: { symbol: string; apy: number; warnings: string[]; mcapUsd: number; date: string }[];
    topLiquidityShifts: { symbol: string; scoreDelta: number; mcapUsd: number; date: string }[];
  };
  /** Aggregate forward-look accountability across the week's daily editions. */
  forwardLookScoreboard: Record<DigestForwardLookOutcome["status"], number> | null;
  weekOverWeekDeltas: {
    mcap: { current: number | null; prior: number | null; deltaPct: number | null };
    psi: { current: number | null; prior: number | null; delta: number | null; unavailableReason?: string };
    psiDominantBand: { current: string | null; prior: string | null };
    activeDepegObservations: { current: number | null; prior: number | null };
    uniqueDepegSignals: { current: number | null; prior: number | null };
    blacklistEvents: { current: number | null; prior: number | null };
    blacklistUsd: { current: number | null; prior: number | null };
    /** Unavailable canonical safety evidence withholds both comparison counts. */
    gradeTransitions: { current: number | null; prior: number | null };
    gauge: { current: number | null; prior: number | null };
    dataCoverage: { currentDays: number; priorDays: number; currentPsiDays: number; priorPsiDays: number };
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
  input_data: string;
}
