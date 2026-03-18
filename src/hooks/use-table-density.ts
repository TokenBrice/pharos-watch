"use client";

import { usePreference } from "./use-preferences";

export type TableDensity = "compact" | "comfortable" | "spacious";

interface DensityConfig {
  rowHeight: number;
  cellPadding: string;
  fontSize: string;
  iconSize: number;
}

export const DENSITY_CONFIGS: Record<TableDensity, DensityConfig> = {
  compact: {
    rowHeight: 32,
    cellPadding: "px-2 py-1",
    fontSize: "text-xs",
    iconSize: 20,
  },
  comfortable: {
    rowHeight: 40,
    cellPadding: "px-3 py-2",
    fontSize: "text-sm",
    iconSize: 24,
  },
  spacious: {
    rowHeight: 52,
    cellPadding: "px-4 py-3",
    fontSize: "text-base",
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
