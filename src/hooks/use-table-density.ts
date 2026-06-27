"use client";

import { usePreference } from "./use-preferences";

export type TableDensity = "compact" | "spacious";

interface DensityConfig {
  rowHeight: number;
  iconSize: number;
}

export const DENSITY_CONFIGS: Record<TableDensity, DensityConfig> = {
  compact: {
    rowHeight: 32,
    iconSize: 20,
  },
  spacious: {
    rowHeight: 52,
    iconSize: 28,
  },
};

export function useTableDensity(): [TableDensity, (density: TableDensity) => void, () => void, DensityConfig] {
  const [stored, setDensity, reset] = usePreference<TableDensity>("pharos-table-density", "spacious");

  // The density toggle collapsed from four modes to two (compact + spacious).
  // Migrate any persisted legacy value ("list" → compact, "comfortable" →
  // spacious) on read so old localStorage prefs don't hit an undefined config.
  const legacy = stored as string;
  const density: TableDensity = legacy === "compact" || legacy === "list" ? "compact" : "spacious";
  const config = DENSITY_CONFIGS[density];

  return [density, setDensity, reset, config];
}
