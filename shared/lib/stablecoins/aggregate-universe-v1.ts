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

/** Frozen sorted active core-aggregate member IDs under listing policy v1 (base 92c90ca72). */
export const CORE_AGGREGATE_V1_MEMBER_LIST: readonly string[] = CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.memberIds;
export const CORE_AGGREGATE_V1_MEMBER_IDS: ReadonlySet<string> = new Set(CORE_AGGREGATE_V1_MEMBER_LIST);

/** Frozen sorted non-active (frozen/quarantined) v1 core-aggregate member IDs as of base 92c90ca72. */
export const CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST: readonly string[] =
  CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.nonActiveMemberIds;
export const CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS: ReadonlySet<string> = new Set(
  CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST,
);

export function isCoreAggregateV1MemberId(stablecoinId: string): boolean {
  return CORE_AGGREGATE_V1_MEMBER_IDS.has(stablecoinId);
}
