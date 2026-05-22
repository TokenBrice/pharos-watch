import {
  SELF_SERVE_API_KEY_EXPIRY_SEC,
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
} from "./ops-limits";
import { API_ORIGIN } from "./runtime-origins";
import { DAY_SECONDS } from "./time-constants";

export const PUBLIC_API_HOST = API_ORIGIN;
export const PUBLIC_API_KEY_HEADER = "X-API-Key";
export const PUBLIC_API_RETRY_GUIDANCE =
  "Respect Retry-After on 429 responses and add jitter to polling intervals.";

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
