/** Named durations in seconds — replaces magic numbers across the worker */

export const SECONDS = {
  ONE_MINUTE: 60,
  FIFTEEN_MINUTES: 900,
  THIRTY_MINUTES: 1800,
  ONE_HOUR: 3600,
  TWO_HOURS: 7200,
  SIX_HOURS: 21600,
  TWELVE_HOURS: 43200,
  ONE_DAY: 86400,
  TWO_DAYS: 172800,
  ONE_WEEK: 604800,
  THIRTY_DAYS: 2592000,
} as const;
