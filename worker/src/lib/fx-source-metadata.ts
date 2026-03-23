import type { FxRateSourceMode, FxRateState, FxSourceCadence } from "./fx-rate-state";
import { getFxSourceStatus } from "./fx-rate-state";

const BUSINESS_DAILY_FX_PEG_KEYS = new Set<string>([
  "peggedEUR",
  "peggedGBP",
  "peggedCHF",
  "peggedREAL",
  "peggedJPY",
  "peggedIDR",
  "peggedSGD",
  "peggedTRY",
  "peggedAUD",
  "peggedZAR",
  "peggedCAD",
  "peggedCNY",
  "peggedPHP",
  "peggedMXN",
]);

const CALENDAR_DAILY_FX_PEG_KEYS = new Set<string>([
  "peggedCNH",
  "peggedRUB",
  "peggedUAH",
  "peggedARS",
]);

function formatIsoDateFromTimestamp(updatedAt: number | null | undefined): string | null {
  if (updatedAt == null || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  return new Date(updatedAt * 1000).toISOString().slice(0, 10);
}

function getNaturalFxCadence(pegKey: string): FxSourceCadence | null {
  if (BUSINESS_DAILY_FX_PEG_KEYS.has(pegKey)) return "business-daily";
  if (CALENDAR_DAILY_FX_PEG_KEYS.has(pegKey)) return "calendar-daily";
  return null;
}

export function normalizeFiatCarryForwardMetadata(
  pegKey: string,
  updatedAt: number | null | undefined,
  mode: FxRateSourceMode | undefined,
  cadence: FxSourceCadence | undefined,
  sourceDate: string | null | undefined,
): { cadence: FxSourceCadence; sourceDate: string | null } {
  if (mode === "hardcoded") {
    return { cadence: cadence ?? "intraday", sourceDate: null };
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
    previousMode,
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
      prevState.sourceModeByPeg[pegKey],
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

export function shouldPreserveDailyOverlayProvenance(
  pegKey: string,
  syncStartSec: number,
  sourceUpdatedAtByPeg: Record<string, number | null>,
  sourceModeByPeg: Record<string, FxRateSourceMode>,
  sourceCadenceByPeg: Record<string, FxSourceCadence>,
  sourceDateByPeg: Record<string, string | null>,
): { cadence: FxSourceCadence; sourceDate: string | null } | null {
  const normalized = normalizeFiatCarryForwardMetadata(
    pegKey,
    sourceUpdatedAtByPeg[pegKey] ?? null,
    sourceModeByPeg[pegKey],
    sourceCadenceByPeg[pegKey],
    sourceDateByPeg[pegKey] ?? null,
  );

  if (normalized.sourceDate == null || getNaturalFxCadence(pegKey) == null) {
    return null;
  }

  return getFxSourceStatus(
    sourceUpdatedAtByPeg[pegKey] ?? null,
    sourceModeByPeg[pegKey],
    syncStartSec,
    { pegKey, cadence: normalized.cadence, sourceDate: normalized.sourceDate },
  ) === "fresh"
    ? normalized
    : null;
}

export function applyRealtimeOverlaySourceMetadata(
  pegKey: string,
  updatedAt: number,
  syncStartSec: number,
  sourceUpdatedAtByPeg: Record<string, number | null>,
  sourceModeByPeg: Record<string, FxRateSourceMode>,
  sourceCadenceByPeg: Record<string, FxSourceCadence>,
  sourceDateByPeg: Record<string, string | null>,
): void {
  const preserved = shouldPreserveDailyOverlayProvenance(
    pegKey,
    syncStartSec,
    sourceUpdatedAtByPeg,
    sourceModeByPeg,
    sourceCadenceByPeg,
    sourceDateByPeg,
  );

  sourceUpdatedAtByPeg[pegKey] = updatedAt;
  sourceModeByPeg[pegKey] = "live";
  sourceCadenceByPeg[pegKey] = preserved?.cadence ?? "intraday";
  sourceDateByPeg[pegKey] = preserved?.sourceDate ?? null;
}
