import { isTreasuryComparableEntity } from "@shared/lib/treasury-stable-exposure";
import type { TreasuryStableExposureEntity } from "@shared/types";

// Re-export so consumers have one import source
export { isTreasuryComparableEntity };

// ---------------------------------------------------------------------------
// Sort key type + options
// ---------------------------------------------------------------------------

export type TreasuryExposureSortKey =
  | "decentralizedStableUsd"
  | "decentralizedStablePctOfTreasury"
  | "decentralizedStablePctOfStableSleeve"
  | "trackedStableUsd"
  | "weightedSafetyScore";

export const TREASURY_SORT_OPTIONS: Array<{ value: TreasuryExposureSortKey; label: string }> = [
  { value: "decentralizedStableUsd", label: "Decentralized Stable $" },
  { value: "decentralizedStablePctOfTreasury", label: "Decentralized Stable % of Treasury" },
  { value: "decentralizedStablePctOfStableSleeve", label: "Decentralized Stable % of Stable Sleeve" },
  { value: "trackedStableUsd", label: "Tracked Stable Sleeve $" },
  { value: "weightedSafetyScore", label: "Weighted Stable Grade" },
];

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const usdCompactFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatTreasuryUsd(value: number): string {
  return usdCompactFormatter.format(value);
}

export function formatTreasuryUsdNullable(value: number | null): string {
  return value == null ? "N/A" : formatTreasuryUsd(value);
}


// ---------------------------------------------------------------------------
// Denominator status helpers
// ---------------------------------------------------------------------------

export function denominatorStatusLabel(entity: TreasuryStableExposureEntity): string {
  switch (entity.coverage.denominatorStatus) {
    case "adjusted-with-defi":
      return "Treasury-comparable";
    case "partial":
      return "Partial denominator";
    case "invalid":
      return "Invalid denominator";
    case "direct-only":
    default:
      return "Direct-only denominator";
  }
}

export function denominatorStatusClassName(entity: TreasuryStableExposureEntity): string {
  switch (entity.coverage.denominatorStatus) {
    case "adjusted-with-defi":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "partial":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "invalid":
      return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "direct-only":
    default:
      return "border-border/70 bg-background/60 text-muted-foreground";
  }
}

export function coverageSummary(entity: TreasuryStableExposureEntity): string {
  const trackedPct = entity.coverage.trackedStablePctOfStableSleeve;
  if (entity.coverage.denominatorStatus === "invalid") return "Invalid treasury denominator";
  if (entity.coverage.denominatorStatus === "partial") {
    return trackedPct == null
      ? "Stable sleeve detected, treasury share unavailable"
      : `Tracked ${trackedPct.toFixed(1)}% of sleeve, treasury share unavailable`;
  }
  if (trackedPct == null) return "No stable sleeve detected";
  return `Tracked ${trackedPct.toFixed(1)}% of stable sleeve`;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function compareEntities(
  a: TreasuryStableExposureEntity,
  b: TreasuryStableExposureEntity,
  sortKey: TreasuryExposureSortKey,
): number {
  switch (sortKey) {
    case "decentralizedStablePctOfTreasury":
      return (b.decentralizedStablePctOfTreasury ?? -1) - (a.decentralizedStablePctOfTreasury ?? -1);
    case "decentralizedStablePctOfStableSleeve":
      return (b.decentralizedStablePctOfStableSleeve ?? -1) - (a.decentralizedStablePctOfStableSleeve ?? -1);
    case "trackedStableUsd":
      return b.trackedStableUsd - a.trackedStableUsd;
    case "weightedSafetyScore":
      return (b.weightedSafetyScore ?? -1) - (a.weightedSafetyScore ?? -1);
    case "decentralizedStableUsd":
    default:
      return b.decentralizedStableUsd - a.decentralizedStableUsd;
  }
}

export function sortTreasuryExposureEntities(
  entities: readonly TreasuryStableExposureEntity[],
  sortKey: TreasuryExposureSortKey,
): TreasuryStableExposureEntity[] {
  return [...entities].sort((a, b) => {
    const sortDiff = compareEntities(a, b, sortKey);
    if (sortDiff !== 0) return sortDiff;
    return a.name.localeCompare(b.name);
  });
}
