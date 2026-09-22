import {
  HOUR_SECONDS,
  DAY_SECONDS,
  WEEK_SECONDS,
} from "@shared/lib/time-constants";

/** Named durations in seconds — worker convenience alias. */
export const SECONDS = {
  ONE_HOUR: HOUR_SECONDS,
  ONE_DAY: DAY_SECONDS,
  ONE_WEEK: WEEK_SECONDS,
} as const;
