"use client";

import { useMemo } from "react";
import { usePreference } from "@/hooks/use-preferences";
import type { ColumnId } from "@/lib/column-visibility";
import { fitColumnsToWidth } from "@/lib/stablecoin-table-fit";

interface UseFittedColumnsInput {
  /** Preference namespace; the fit toggle persists as `${namespace}-fit-columns`. */
  namespace: string;
  /** User-chosen visible columns (the Columns menu keeps managing this). */
  intent: readonly ColumnId[];
  /** False disables fitting entirely (e.g. the phone layout), rendering intent as-is. */
  enabled: boolean;
  /** Measured container width in px; 0 = unmeasured (no fit applied). */
  containerWidth: number;
  getColumnWidth: (id: ColumnId) => number;
  /** Width consumed by non-column chrome (pinned/star cell). */
  fixedWidth: number;
}

interface UseFittedColumnsResult {
  renderedColumns: ColumnId[];
  hiddenByFit: ColumnId[];
  fitToWidth: boolean;
  setFitToWidth: (next: boolean) => void;
}

/**
 * Fit-to-width column selection for dense workbench tables: sheds
 * low-priority columns until the user's chosen set fits the measured
 * container instead of forcing horizontal scroll. The persisted toggle lets
 * the user opt back into the render-everything-and-scroll behavior.
 */
export function useFittedColumns({
  namespace,
  intent,
  enabled,
  containerWidth,
  getColumnWidth,
  fixedWidth,
}: UseFittedColumnsInput): UseFittedColumnsResult {
  const [fitToWidth, setFitToWidth] = usePreference<boolean>(`${namespace}-fit-columns`, true, {
    decode: (raw) => raw !== false,
  });

  const { rendered: renderedColumns, hiddenByFit } = useMemo(() => {
    if (!enabled || !fitToWidth) {
      return { rendered: [...intent], hiddenByFit: [] as ColumnId[] };
    }
    return fitColumnsToWidth({ intent, containerWidth, getColumnWidth, fixedWidth });
  }, [enabled, fitToWidth, intent, containerWidth, getColumnWidth, fixedWidth]);

  return { renderedColumns, hiddenByFit, fitToWidth, setFitToWidth };
}
