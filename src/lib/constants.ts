export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const MS_PER_SECOND = 1000;

export const HOUR_SECONDS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
export const DAY_SECONDS = HOURS_PER_DAY * HOUR_SECONDS;
export const DAY_HOURS = HOURS_PER_DAY;
export const HOUR_MS = HOUR_SECONDS * MS_PER_SECOND;
export const DAY_MS = DAY_SECONDS * MS_PER_SECOND;

export const WEEK_DAYS = 7;
export const WEEK_HOURS = WEEK_DAYS * DAY_HOURS;
export const WEEK_MS = WEEK_DAYS * DAY_MS;
export const YEAR_DAYS = 365.25;
export const YEAR_MS = YEAR_DAYS * DAY_MS;

export const THIRTY_DAYS_SECONDS = 30 * DAY_SECONDS;
export const THIRTY_DAYS_HOURS = 30 * DAY_HOURS;
export const NINETY_DAYS_HOURS = 90 * DAY_HOURS;
export const NINETY_DAYS_MS = 90 * DAY_MS;
export const THREE_DAYS_MS = 3 * DAY_MS;

export const CATEGORY_LINKS = [
  { href: "/stablecoins/usd/", param: "type", value: "usd", label: "USD Stablecoins" },
  { href: "/stablecoins/governance/cefi/", param: "type", value: "centralized", label: "CeFi Stablecoins" },
  {
    href: "/stablecoins/governance/cefi-dependent/",
    param: "type",
    value: "centralized-dependent",
    label: "CeFi-Dependent",
  },
  { href: "/stablecoins/governance/defi/", param: "type", value: "decentralized", label: "DeFi Stablecoins" },
  { href: "/stablecoins/backing/rwa/", param: "backing", value: "rwa-backed", label: "RWA-Backed" },
  { href: "/stablecoins/backing/crypto/", param: "backing", value: "crypto-backed", label: "Crypto-Backed" },
  { href: "/stablecoins/eur/", param: "peg", value: "eur-peg", label: "EUR Stablecoins" },
  { href: "/stablecoins/gold/", param: "peg", value: "gold-peg", label: "Gold-Backed" },
];
