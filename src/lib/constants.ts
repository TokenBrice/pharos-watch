export {
  SECONDS_PER_MINUTE,
  HOUR_SECONDS,
  DAY_SECONDS,
  HOUR_MS,
  DAY_MS,
  WEEK_MS,
  THIRTY_DAYS_SECONDS,
} from "@shared/lib/time-constants";

// Derived constants unique to frontend (not worth sharing — no worker consumers)
import { DAY_MS as _DM, HOURS_PER_DAY } from "@shared/lib/time-constants";

export const DAY_HOURS = HOURS_PER_DAY;
export const WEEK_HOURS = 7 * DAY_HOURS;
export const THIRTY_DAYS_HOURS = 30 * DAY_HOURS;
export const NINETY_DAYS_HOURS = 90 * DAY_HOURS;
export const NINETY_DAYS_MS = 90 * _DM;
export const THREE_DAYS_MS = 3 * _DM;
export const YEAR_MS = 365.25 * _DM;
export const TABLE_PAGE_SIZE = 25;

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
