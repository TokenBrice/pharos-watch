/**
 * Canonical link builder for cross-tracker hatnotes.
 *
 * Each tracker is keyed by `TrackerKind`. The helper encodes which URL pattern
 * a given tracker expects so callers (e.g. `CoinCrossTrackerHatnote`) don't
 * have to know per-surface filter conventions. Trackers that don't yet support
 * coin filtering fall back to the canonical stablecoin profile route, so the
 * lateral graph stays unbroken.
 */
import { getBlacklistLedgerStablecoinById } from "@shared/lib/blacklist-contract-specs";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { hasStaticYieldWorkbench } from "@shared/lib/yield-auto-lending";

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
 * - `safety-score` → `/stablecoin/<id>/#overview`
 * - `liquidity` → `/stablecoin/<id>/#liquidity`
 * - `depeg-history` → `/stablecoin/<id>/#history`
 * - `yield` → `/stablecoin/<id>/yield/` when the coin exports a yield workbench, otherwise `/yield/`
 * - `flows` → `/flows/`
 * - `freezewatch` → `/freezewatch/?stablecoin=<SYMBOL>` when the coin has FreezeWatch tracking or archived ledger history, otherwise `/freezewatch/`
 * - `timeline` → `/timeline/?coin=<id>`
 */
export function buildCoinTrackerLink(
  coinId: string,
  tracker: TrackerKind,
  _coinSymbol?: string,
): CoinTrackerLink {
  const label = TRACKER_LABELS[tracker];
  const profileHref = buildStablecoinUrl(coinId);

  switch (tracker) {
    case "stablecoin-profile":
      return { tracker, label, href: profileHref };
    case "freezewatch": {
      const symbol = getBlacklistLedgerStablecoinById(coinId);
      return {
        tracker,
        label,
        href: symbol ? `/freezewatch/?stablecoin=${encodeURIComponent(symbol)}` : "/freezewatch/",
      };
    }
    case "timeline":
      return { tracker, label, href: `/timeline/?coin=${encodeURIComponent(coinId)}` };
    case "safety-score":
      return { tracker, label, href: `${profileHref}#overview` };
    case "liquidity":
      return { tracker, label, href: `${profileHref}#liquidity` };
    case "depeg-history":
      return { tracker, label, href: `${profileHref}#history` };
    case "yield": {
      const coin = CLIENT_TRACKED_META_BY_ID.get(coinId);
      const href = coin && hasStaticYieldWorkbench(coin) ? buildStablecoinUrl(coinId, "yield/") : "/yield/";
      return { tracker, label, href };
    }
    case "flows":
      return { tracker, label, href: "/flows/" };
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
