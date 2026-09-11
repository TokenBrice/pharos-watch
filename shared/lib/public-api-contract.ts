import {
  DONOR_API_KEY_MIN_USD,
  DONOR_API_KEY_RATE_LIMIT_PER_MINUTE,
  SELF_SERVE_API_KEY_EXPIRY_SEC,
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
} from "./ops-limits";
import { API_ORIGIN } from "./runtime-origins";
import { DAY_SECONDS } from "./time-constants";

export const PUBLIC_API_HOST = API_ORIGIN;
export const PUBLIC_API_KEY_HEADER = "X-API-Key";
export const PUBLIC_API_RETRY_GUIDANCE =
  "Respect Retry-After on 429 responses and add jitter to polling intervals.";

/**
 * Public self-serve key issuance switch. `false` closes `POST /api/api-key-requests`
 * and replaces the `/api/` request form with a closed notice; verification of
 * already-sent links keeps working so in-flight claims can finish. Existing
 * self-serve keys drain through their 60-day expiry. Keys are operator-issued
 * until the paid tier ships.
 */
export const SELF_SERVE_ISSUANCE_OPEN: boolean = false;

/**
 * Donor (supporter) key claim switch. `false` makes `POST /api/donor-key-claims`
 * answer 403 before reading the body and replaces the `/api/` claim button with
 * a "claims are paused" notice. Keys already issued keep working. Apply the
 * migration before deploying this enabled release; verify a live claim before
 * announcing availability. Pause with this switch, not a pre-donor Worker rollback.
 */
export const DONOR_KEY_CLAIMS_OPEN: boolean = true;

export const DONOR_API_KEY_SUMMARY =
  `one key per wallet with at least $${DONOR_API_KEY_MIN_USD} in donations of stablecoins graded A or B (including +/−) at claim time, no expiry, ${DONOR_API_KEY_RATE_LIMIT_PER_MINUTE} requests per minute`;

export const SELF_SERVE_API_KEY_RATE_LIMIT_RPM = SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE;
export const SELF_SERVE_API_KEY_EXPIRY_DAYS = Math.round(SELF_SERVE_API_KEY_EXPIRY_SEC / DAY_SECONDS);

export const PUBLIC_API_ARTIFACTS = {
  openApi: "/openapi.json",
  postmanCollection: "/postman/pharos-api.postman_collection.json",
  postmanEnvironment: "/postman/pharos-api.postman_environment.json",
} as const;

export const SELF_SERVE_API_KEY_SUMMARY =
  `email-verified, limited to ${SELF_SERVE_API_KEY_RATE_LIMIT_RPM} requests per minute, and expires after ${SELF_SERVE_API_KEY_EXPIRY_DAYS} days`;

export function buildPublicApiCurlCommand({
  tokenReference = "$PHAROS_API_KEY",
  path = "/api/stablecoins",
  includeAcceptHeader = false,
}: {
  tokenReference?: string;
  path?: string;
  includeAcceptHeader?: boolean;
} = {}): string {
  const lines = [
    `curl ${PUBLIC_API_HOST}${path} \\`,
    `  -H "${PUBLIC_API_KEY_HEADER}: ${tokenReference}"`,
  ];
  if (includeAcceptHeader) {
    lines[1] += " \\";
    lines.push("  -H \"Accept: application/json\"");
  }
  return lines.join("\n");
}
