"use client";

import { usePreference } from "./use-preferences";

export type TableDensity = "list" | "compact" | "comfortable" | "spacious";

interface DensityConfig {
  rowHeight: number;
  iconSize: number;
}

export const DENSITY_CONFIGS: Record<TableDensity, DensityConfig> = {
  list: {
    rowHeight: 28,
    iconSize: 18,
  },
  compact: {
    rowHeight: 32,
    iconSize: 20,
  },
  comfortable: {
    rowHeight: 40,
    iconSize: 24,
  },
  spacious: {
    rowHeight: 52,
    iconSize: 28,
  },
};

export function useTableDensity(): [
  TableDensity,
  (density: TableDensity) => void,
  () => void,
  DensityConfig,
] {
  const [density, setDensity, reset] = usePreference<TableDensity>(
    "pharos-table-density",
    "comfortable"
  );

  const config = DENSITY_CONFIGS[density];

  return [density, setDensity, reset, config];
}
