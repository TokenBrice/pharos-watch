import type { FxRateSourceMode, FxRateState } from "./fx-rate-state";
import { getFxSourceStatus } from "./fx-rate-state";
import { getNaturalFxCadence, type FxSourceCadence } from "./fx-cadence";
import { formatIsoDate } from "@shared/lib/format";

function formatIsoDateFromTimestamp(updatedAt: number | null | undefined): string | null {
  if (updatedAt == null || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  return formatIsoDate(updatedAt);
}

function normalizeFiatCarryForwardMetadata(
  pegKey: string,
  updatedAt: number | null | undefined,
  cadence: FxSourceCadence | undefined,
  sourceDate: string | null | undefined,
): { cadence: FxSourceCadence; sourceDate: string | null } {

  if (cadence != null) {
    return { cadence, sourceDate: sourceDate ?? null };
  }

  const naturalCadence = getNaturalFxCadence(pegKey);
  if (!naturalCadence) {
    return { cadence: cadence ?? "intraday", sourceDate: sourceDate ?? null };
  }

  return {
    cadence: naturalCadence,
    sourceDate: sourceDate ?? formatIsoDateFromTimestamp(updatedAt),
  };
}

export function inheritFxSourceMetadata(
  prevState: FxRateState | null,
  pegKey: string,
  sourceUpdatedAtByPeg: Record<string, number | null>,
  sourceModeByPeg: Record<string, FxRateSourceMode>,
  sourceCadenceByPeg: Record<string, FxSourceCadence>,
  sourceDateByPeg: Record<string, string | null>,
): void {
  const previousMode = prevState?.sourceModeByPeg[pegKey] ?? "cached";
  const previousUpdatedAt = prevState?.sourceUpdatedAtByPeg[pegKey] ?? null;
  const normalized = normalizeFiatCarryForwardMetadata(
    pegKey,
    previousUpdatedAt,
    prevState?.sourceCadenceByPeg[pegKey],
    prevState?.sourceDateByPeg[pegKey] ?? null,
  );

  sourceModeByPeg[pegKey] = previousMode;
  sourceUpdatedAtByPeg[pegKey] = previousUpdatedAt;
  sourceCadenceByPeg[pegKey] = normalized.cadence;
  sourceDateByPeg[pegKey] = normalized.sourceDate;
}

export function canCarryForwardFxRates(
  expectedPegKeys: string[],
  prevState: FxRateState | null,
  prevRates: Record<string, number>,
  syncStartSec: number,
): boolean {
  if (!prevState) return false;

  return expectedPegKeys.every((pegKey) => {
    const prevRate = prevRates[pegKey];
    if (typeof prevRate !== "number" || !Number.isFinite(prevRate) || prevRate <= 0) {
      return false;
    }

    const normalized = normalizeFiatCarryForwardMetadata(
      pegKey,
      prevState.sourceUpdatedAtByPeg[pegKey] ?? null,
      prevState.sourceCadenceByPeg[pegKey],
      prevState.sourceDateByPeg[pegKey] ?? null,
    );

    return getFxSourceStatus(
      prevState.sourceUpdatedAtByPeg[pegKey] ?? null,
      prevState.sourceModeByPeg[pegKey],
      syncStartSec,
      { pegKey, cadence: normalized.cadence, sourceDate: normalized.sourceDate },
    ) === "fresh";
  });
}
