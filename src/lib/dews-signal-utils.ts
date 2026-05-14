import {
  DEWS_SIGNAL_LABELS,
  DEWS_SIGNAL_SHORT_LABELS,
  DEWS_SIGNAL_WEIGHTS,
  type DewsSignalKey,
} from "@shared/lib/dews-config";
import type { StressSignalEntry } from "@shared/types";

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

export interface DewsFreshness {
  ageSeconds: number | null;
  stale: boolean;
  label: string | null;
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

export function getDewsFreshness(
  computedAt: number | null | undefined,
  nowSeconds: number,
  staleAfterSeconds: number,
): DewsFreshness {
  if (!computedAt || !Number.isFinite(computedAt)) {
    return { ageSeconds: null, stale: false, label: null };
  }

  const ageSeconds = Math.max(0, Math.floor(nowSeconds - computedAt));
  if (ageSeconds < 60) return { ageSeconds, stale: ageSeconds > staleAfterSeconds, label: "fresh" };
  if (ageSeconds < 3600) {
    return {
      ageSeconds,
      stale: ageSeconds > staleAfterSeconds,
      label: `${Math.floor(ageSeconds / 60)}m old`,
    };
  }
  const hours = Math.floor(ageSeconds / 3600);
  return {
    ageSeconds,
    stale: ageSeconds > staleAfterSeconds,
    label: `${hours}h old`,
  };
}
