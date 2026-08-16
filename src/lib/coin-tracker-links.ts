/**
 * Canonical link builder for cross-tracker hatnotes.
 *
 * Each tracker is keyed by `TrackerKind`. The helper encodes which URL pattern
 * a given tracker expects so callers (e.g. `CoinCrossTrackerHatnote`) don't
 * have to know per-surface filter conventions. Trackers that don't yet support
 * coin filtering fall back to the canonical stablecoin profile route, so the
 * lateral graph stays unbroken.
 */
import { buildStablecoinUrl } from "@shared/lib/urls";

export type TrackerKind =
  | "stablecoin-profile"
  | "safety-score"
  | "liquidity"
  | "depeg-history"
  | "yield"
  | "flows"
  | "freezewatch"
  | "timeline";

export interface CoinTrackerLink {
  tracker: TrackerKind;
  label: string;
  href: string;
}

const TRACKER_LABELS: Record<TrackerKind, string> = {
  "stablecoin-profile": "Stablecoin profile",
  "safety-score": "Safety Score",
  liquidity: "Liquidity",
  "depeg-history": "Depeg history",
  yield: "Yield",
  flows: "Flows",
  freezewatch: "FreezeWatch",
  timeline: "Tape",
};

/**
 * Build the canonical link for a coin in a given tracker.
 *
 * URL patterns:
 * - `stablecoin-profile` → `/stablecoin/<id>/`
 * - `freezewatch` → `/freezewatch/?stablecoin=<SYMBOL>` (uppercased symbol)
 * - `timeline` → `/timeline/?coin=<id>`
 * - `safety-score`, `liquidity`, `depeg-history`, `yield`, `flows` → fall back
 *   to the stablecoin profile route because those surfaces do not yet expose a
 *   URL-driven single-coin filter.
 */
export function buildCoinTrackerLink(
  coinId: string,
  tracker: TrackerKind,
  coinSymbol?: string,
): CoinTrackerLink {
  const label = TRACKER_LABELS[tracker];
  const profileHref = buildStablecoinUrl(coinId);

  switch (tracker) {
    case "stablecoin-profile":
      return { tracker, label, href: profileHref };
    case "freezewatch": {
      const symbol = (coinSymbol ?? coinId).toUpperCase();
      return { tracker, label, href: `/freezewatch/?stablecoin=${encodeURIComponent(symbol)}` };
    }
    case "timeline":
      return { tracker, label, href: `/timeline/?coin=${encodeURIComponent(coinId)}` };
    case "safety-score":
    case "liquidity":
    case "depeg-history":
    case "yield":
    case "flows":
      // These surfaces do not yet expose a URL-driven single-coin filter;
      // point researchers at the stablecoin profile so the hatnote still
      // delivers them to coin-scoped context.
      return { tracker, label, href: profileHref };
  }
}

const ALL_TRACKERS: readonly TrackerKind[] = [
  "stablecoin-profile",
  "safety-score",
  "liquidity",
  "depeg-history",
  "yield",
  "flows",
  "freezewatch",
  "timeline",
] as const;

export function buildAllCoinTrackerLinks(
  coinId: string,
  excludeCurrent?: TrackerKind,
  coinSymbol?: string,
): CoinTrackerLink[] {
  return ALL_TRACKERS.filter((t) => t !== excludeCurrent).map((t) =>
    buildCoinTrackerLink(coinId, t, coinSymbol),
  );
}
