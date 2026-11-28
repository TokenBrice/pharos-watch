import {
  DEWS_SIGNAL_LABELS,
  DEWS_SIGNAL_SHORT_LABELS,
  DEWS_SIGNAL_WEIGHTS,
  type DewsSignalKey,
} from "@shared/lib/dews-config";
import { formatSignedPercent } from "@shared/lib/format";
import type { StressSignalEntry, TvlComparisonUnavailableReason } from "@shared/types/stress";

const TVL_COMPARISON_REASON: Record<TvlComparisonUnavailableReason, string> = {
  "current-tvl-clock-unavailable": "current TVL observation time unavailable",
  "tvl-methodology-unavailable": "TVL methodology unavailable",
  "methodology-basis-change": "TVL measurement basis changed",
  "weekly-tvl-observation-unavailable": "no comparable weekly TVL observation",
};

export function describeLiquidityErosionInputs(signal: StressSignalEntry["signals"][string]): string {
  const { componentCoverage, scoreDelta7d, tvlDelta7d, liquidityScore, liquidityScore7dAgo } = signal;
  const delta = (value: unknown) => formatSignedPercent(typeof value === "number" ? value : null, 1, "unavailable");
  const scores = typeof liquidityScore === "number" && typeof liquidityScore7dAgo === "number"
    ? ` (${liquidityScore7dAgo} → ${liquidityScore})` : "";
  const tvl = tvlDelta7d == null && signal.tvlDelta7dUnavailableReason
    ? `unavailable (${TVL_COMPARISON_REASON[signal.tvlDelta7dUnavailableReason]})` : delta(tvlDelta7d);
  const coverage = componentCoverage === 0 || componentCoverage === 0.5 || componentCoverage === 1
    ? `${componentCoverage * 2} of 2 inputs` : "input coverage unknown";
  return `7d score change ${delta(scoreDelta7d)}${scores} · 7d TVL change ${tvl} · ${coverage}`;
}

export interface DewsContributor {
  key: string;
  label: string;
  shortLabel: string;
  value: number;
  weight: number;
  contribution: number;
}

export interface DewsAmplifier {
  key: "psi" | "contagion";
  label: string;
  value: number;
}

function isDewsSignalKey(key: string): key is DewsSignalKey {
  return key in DEWS_SIGNAL_WEIGHTS;
}

export function getDewsSignalLabel(key: string, short = false): string {
  if (!isDewsSignalKey(key)) return key;
  return short ? DEWS_SIGNAL_SHORT_LABELS[key] : DEWS_SIGNAL_LABELS[key];
}

export function getTopDewsContributors(
  signals: StressSignalEntry["signals"] | undefined,
  limit = 2,
): DewsContributor[] {
  if (!signals) return [];

  return Object.entries(signals)
    .flatMap(([key, signal]) => {
      if (!signal.available || !Number.isFinite(signal.value) || signal.value <= 0) return [];
      const weight = isDewsSignalKey(key) ? DEWS_SIGNAL_WEIGHTS[key] : 0;
      return [
        {
          key,
          label: getDewsSignalLabel(key),
          shortLabel: getDewsSignalLabel(key, true),
          value: signal.value,
          weight,
          contribution: signal.value * weight,
        },
      ];
    })
    .sort((a, b) => {
      if (b.contribution !== a.contribution) return b.contribution - a.contribution;
      if (b.value !== a.value) return b.value - a.value;
      return a.label.localeCompare(b.label);
    })
    .slice(0, limit);
}

export function getDewsAmplifiers(entry: Pick<StressSignalEntry, "amplifiers"> | undefined): DewsAmplifier[] {
  const amplifiers = entry?.amplifiers;
  if (!amplifiers) return [];

  return ([
    { key: "psi", label: "PSI", value: amplifiers.psi },
    { key: "contagion", label: "Contagion", value: amplifiers.contagion },
  ] as const).filter((amp) => Number.isFinite(amp.value) && amp.value > 1);
}
