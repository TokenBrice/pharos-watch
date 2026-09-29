import { API_ORIGIN, SITE_ORIGIN } from "./runtime-origins";

export const PUBLIC_API_HOST = API_ORIGIN;
export const PUBLIC_API_KEY_HEADER = "X-API-Key";
export const PUBLIC_API_RETRY_GUIDANCE =
  "Respect Retry-After on 429 responses and add jitter to polling intervals.";

/**
 * Donor (supporter) key claim switch. `false` makes `POST /api/donor-key-claims`
 * answer 403 before reading the body and replaces the `/api/` claim button with
 * a "claims are paused" notice. Keys already issued keep working. Apply the
 * migration before deploying this enabled release; verify a live claim before
 * announcing availability. Pause with this switch, not a pre-donor Worker rollback.
 */
export const DONOR_KEY_CLAIMS_OPEN: boolean = true;

export const PUBLIC_API_ARTIFACTS = {
  openApi: "/openapi.json",
  postmanCollection: "/postman/pharos-api.postman_collection.json",
  postmanEnvironment: "/postman/pharos-api.postman_environment.json",
} as const;

/** Section anchors on `/api/`; inbound links and Worker messages target them. */
export const API_PAGE_ANCHORS = {
  supporterKey: "supporter-key",
  partnerAccess: "partner-access",
  claim: "claim",
  developerResources: "developer-resources",
} as const;

export const API_PARTNER_ACCESS_URL = `${SITE_ORIGIN}/api/#${API_PAGE_ANCHORS.partnerAccess}`;

/**
 * Private channel for partner-key requests, lost supporter-key rotation, and
 * key-record removal. Never the feedback modal: it files public GitHub issues.
 */
export const API_ACCESS_TELEGRAM_HANDLE = "TokenBrice";
export const API_ACCESS_TELEGRAM_URL = `https://t.me/${API_ACCESS_TELEGRAM_HANDLE}`;
export const API_ACCESS_X_HANDLE = "PharosWatch";
export const API_ACCESS_X_URL = `https://x.com/${API_ACCESS_X_HANDLE}`;

/** Human reply window promised on the partner key offer; not a contractual SLA. */
export const PARTNER_KEY_REPLY_BUSINESS_DAYS = 2;

/** Copyable request text for the partner-key DM; fields mirror the ops key-create form. */
export const PARTNER_KEY_REQUEST_TEMPLATE = [
  "Pharos partner key request",
  "Contact (Telegram, X or email):",
  "Project / organization + URL:",
  "What you're building and which endpoints:",
  "Expected peak requests per minute (or polling cadence):",
  "Free to end users? (yes/no):",
  "Needed by (optional):",
].join("\n");

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
