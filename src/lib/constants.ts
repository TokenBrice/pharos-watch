export {
  SECONDS_PER_MINUTE,
  HOUR_SECONDS,
  DAY_SECONDS,
  DAY_MS,
} from "@shared/lib/time-constants";

// Derived constants unique to frontend (not worth sharing — no worker consumers)
import { DAY_MS as _DM, HOURS_PER_DAY } from "@shared/lib/time-constants";

export const DAY_HOURS = HOURS_PER_DAY;
export const YEAR_MS = 365.25 * _DM;
export const TABLE_PAGE_SIZE = 25;
