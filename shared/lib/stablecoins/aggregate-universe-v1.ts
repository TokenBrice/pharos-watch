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
 * current `listingStatusReview.changedAt` later advanced on a terminal lifecycle
 * transition (e.g. quarantined -> delisted), so historical v1 PSI replays do not
 * retroactively extend their pre-cutover eligibility window.
 */
export const CORE_AGGREGATE_V1_NON_ACTIVE_EXIT_DATES: Readonly<Record<string, string>> = {
  "benji-franklin-templeton": "2026-10-30",
};

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
