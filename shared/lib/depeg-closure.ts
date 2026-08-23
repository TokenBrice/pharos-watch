/**
 * Maximum gap between two consecutive observations that still counts as continuous
 * coverage of a depeg episode.
 *
 * Bounded from both sides, and both bounds are load-bearing:
 *
 * - **Above measured jitter.** `sync-stablecoins` nominally runs every 900s, but
 *   sampled production start gaps were 868, 907, 932, and 932 seconds. A 900s
 *   tolerance would treat three of those four ordinary runs as a coverage break,
 *   reset `first_seen_at`, and prevent the 15-minute continuity window from ever
 *   accumulating — suppressing legitimate depeg confirmations entirely.
 * - **Below two producer intervals.** At 1200s a fully missed run (~1800s gap)
 *   still resets the episode, which is the whole point: onset and recovery must
 *   not be claimed as continuously observed across a blind interval.
 */
export const DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC = 1_200;

export type DepegClosureClassification =
  | "open"
  | "recovered"
  | "superseded"
  | "coverage_lost"
  | "orphan"
  | "legacy_recovered"
  | "unknown_closed";

export interface DepegClosureInput {
  endedAt: number | null;
  closeReason?: string | null;
  recoveryPrice: number | null;
}

export function classifyDepegClosure(input: DepegClosureInput): DepegClosureClassification {
  if (input.endedAt == null) return "open";

  switch (input.closeReason) {
    case "recovered-primary":
    case "recovered-dex":
    case "recovered-native":
      return "recovered";
    case "superseded-direction":
      return "superseded";
    case "coverage-lost-supply":
      return "coverage_lost";
    case "orphan-tracking-removed":
      return "orphan";
    case null:
    case undefined:
      return input.recoveryPrice != null ? "legacy_recovered" : "unknown_closed";
    default:
      return "unknown_closed";
  }
}
