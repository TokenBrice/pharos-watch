import type {
  CoverageBreakdownItem,
  CoverageRow,
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

/**
 * Every status kind a preset table can produce, in declaration order. Feature
 * modules derive `statusKinds` from this instead of hand-maintaining a parallel
 * array that silently drifts from the resolver.
 */
export function statusKindsFromPresets(
  ...tables: ReadonlyArray<Readonly<Record<string, CoverageStatusPreset>>>
): readonly string[] {
  return tables.flatMap((table) => Object.values(table).map((preset) => preset.kind));
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

export function createBreakdownCounter(breakdownMap: ReadonlyMap<string, number>): (kind: string) => number {
  return (kind: string) => breakdownMap.get(kind) ?? 0;
}

/**
 * Shared "data-unavailable" status kind. Every feature can emit this when its
 * upstream feed has not loaded yet.
 */
export const DATA_UNAVAILABLE_KIND = "data-unavailable";

export type CoverageBreakdownFormatter = (
  rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
) => CoverageBreakdownItem[];

/**
 * Per-feature resolver bundle. Each `src/lib/coverage/<feature>.ts` module
 * exports one `coverageFeature` built via `defineCoverageFeature`, collapsing
 * what used to be four parallel named exports per feature.
 */
export interface CoverageFeatureModule<
  TResolve extends (...args: never[]) => CoverageStatus,
> {
  statusKinds: readonly string[];
  legendItems: readonly CoverageLegendItem[];
  resolve: TResolve;
  formatBreakdown: CoverageBreakdownFormatter;
}

export function defineCoverageFeature<
  TResolve extends (...args: never[]) => CoverageStatus,
>(def: CoverageFeatureModule<TResolve>): CoverageFeatureModule<TResolve> {
  return def;
}
