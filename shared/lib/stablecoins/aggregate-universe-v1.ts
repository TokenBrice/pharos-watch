import frozenV1Asset from "../../data/stablecoins/core-aggregate-v1-members.json";
import { CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1 } from "./aggregate-universe";

export interface FrozenCoreAggregateV1Members {
  schemaVersion: 1;
  universe: typeof CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1;
  frozenFromCommit: string;
  memberIds: readonly string[];
  nonActiveMemberIds: readonly string[];
}

export const CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT = frozenV1Asset as FrozenCoreAggregateV1Members;

/** Frozen sorted active core-aggregate member IDs under listing policy v1 (base 1b79da4cb). */
export const CORE_AGGREGATE_V1_MEMBER_LIST: readonly string[] = CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.memberIds;
export const CORE_AGGREGATE_V1_MEMBER_IDS: ReadonlySet<string> = new Set(CORE_AGGREGATE_V1_MEMBER_LIST);

/** Frozen sorted non-active (frozen/quarantined) v1 core-aggregate member IDs as of base 1b79da4cb. */
export const CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST: readonly string[] =
  CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.nonActiveMemberIds;
export const CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS: ReadonlySet<string> = new Set(
  CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST,
);

/**
 * Preserved v1 exit dates (YYYY-MM-DD UTC) for frozen v1 non-active members whose
 * current `listingStatusReview.changedAt` later advanced or cleared on a lifecycle
 * transition (e.g. quarantined -> delisted or quarantined -> active), so historical
 * v1 PSI replays do not lose or retroactively extend their pre-cutover eligibility window.
 */
export const CORE_AGGREGATE_V1_NON_ACTIVE_EXIT_DATES: Readonly<Record<string, string>> = {
  "benji-franklin-templeton": "2026-10-30",
  "wtgxx-wisdomtree": "2026-10-30",
  "tbill-openeden": "2026-10-30",
  "jltxx-jpmorgan": "2026-10-03",
  "cetes-etherfuse": "2026-11-10",
};

/**
 * Effective UTC admission dates (YYYY-MM-DD, inclusive at 00:00:00Z) for core
 * stablecoins promoted or newly admitted after `CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE`,
 * so Pharos-added structural chart overlays, non-USD share series, and PSI replays
 * do not backdate post-cutover admissions to the v2 cutover day (DefiLlama's own
 * provider-backed chart series retains upstream history for DefiLlama-listed coins).
 */
const CORE_AGGREGATE_V2_POST_CUTOVER_ENTRY_DATES: Readonly<Record<string, string>> = {
  "jpydf-deltaforesight": "2026-11-27",
  "xauh-herculis": "2026-11-27",
  "stt-silvertimes": "2026-11-27",
  "gdlr-doma": "2026-11-27",
  "sdlr-doma": "2026-11-27",
  "tmxn-tenbin": "2026-11-27",
  "tbrl-tenbin": "2026-11-27",
  "invusd-inverse-finance": "2026-11-27",
  "usdv-delpho": "2026-11-27",
  "bnbusd-sigma-money": "2026-11-27",
  "eusd-own": "2026-11-27",
};

export function getCoreAggregatePostCutoverEntrySec(stablecoinId: string): number | null {
  const date = CORE_AGGREGATE_V2_POST_CUTOVER_ENTRY_DATES[stablecoinId];
  if (!date) return null;
  const parsed = Date.parse(`${date}T00:00:00Z`) / 1000;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Effective UTC exclusion dates (YYYY-MM-DD, exclusive at 00:00:00Z) for v1 core
 * members reclassified out of `core-stablecoin` after `CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE`,
 * so historical charts, non-USD share series, and PSI replays do not backdate
 * post-cutover reclassifications to the v2 cutover day.
 */
export const CORE_AGGREGATE_V2_POST_CUTOVER_EXIT_DATES: Readonly<Record<string, string>> = {
  "usdcx-movement": "2026-11-27",
};

export function getCoreAggregatePostCutoverExitSec(stablecoinId: string): number | null {
  const date = CORE_AGGREGATE_V2_POST_CUTOVER_EXIT_DATES[stablecoinId];
  if (!date) return null;
  const parsed = Date.parse(`${date}T00:00:00Z`) / 1000;
  return Number.isFinite(parsed) ? parsed : null;
}
