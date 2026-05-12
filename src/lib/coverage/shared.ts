import type {
  CoverageBreakdownItem,
  CoverageStatus,
  CoverageTone,
} from "@/lib/coverage-types";

export interface CoverageStatusPreset {
  kind: string;
  label: string;
  tone: CoverageTone;
  available: boolean;
  sortRank: number;
  detail: string;
  spokenLabel?: string;
}

export interface CoverageLegendItem {
  term: string;
  description: string;
  /** Status kinds covered by this legend entry. Used by the invariant test. */
  kinds: readonly string[];
}

export function createStatus(
  kind: string,
  label: string,
  tone: CoverageTone,
  available: boolean,
  sortRank: number,
  detail: string,
  spokenLabel = label,
): CoverageStatus {
  return {
    kind,
    label,
    spokenLabel,
    tone,
    available,
    sortRank,
    detail,
  };
}

export function createPresetStatus(preset: CoverageStatusPreset): CoverageStatus {
  return createStatus(
    preset.kind,
    preset.label,
    preset.tone,
    preset.available,
    preset.sortRank,
    preset.detail,
    preset.spokenLabel,
  );
}

export function createDataUnavailableStatus(featureLabel: string): CoverageStatus {
  return createStatus(
    "data-unavailable",
    "Data n/a",
    "amber",
    false,
    -1,
    `${featureLabel} coverage data is unavailable right now, so this state is not counted as a coverage gap.`,
    "Data unavailable",
  );
}

export function resolveBooleanCoverageStatus(
  enabled: boolean,
  availablePreset: CoverageStatusPreset,
  missingPreset: CoverageStatusPreset,
): CoverageStatus {
  return createPresetStatus(enabled ? availablePreset : missingPreset);
}

export function breakdownItem(key: string, label: string, count: number): CoverageBreakdownItem {
  return { key, label, count };
}

/**
 * Shared "data-unavailable" status kind. Every feature can emit this when its
 * upstream feed has not loaded yet.
 */
export const DATA_UNAVAILABLE_KIND = "data-unavailable";
