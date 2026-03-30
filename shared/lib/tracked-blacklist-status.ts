import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "./stablecoins";
import {
  resolveBlacklistStatuses,
  type BlacklistStatus,
} from "./report-card-blacklist-risk";

const TRACKED_BLACKLIST_STATUS_BY_ID = resolveBlacklistStatuses(
  TRACKED_STABLECOINS,
  { trackedMetaById: TRACKED_META_BY_ID },
);

export function getTrackedBlacklistStatus(id: string): BlacklistStatus | null {
  return TRACKED_BLACKLIST_STATUS_BY_ID.get(id) ?? null;
}
