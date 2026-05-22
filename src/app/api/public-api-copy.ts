export const PUBLIC_API_HOST = "https://api.pharos.watch";
export const PUBLIC_API_KEY_HEADER = "X-API-Key";
export const SELF_SERVE_API_KEY_RATE_LIMIT_RPM = 30;
export const SELF_SERVE_API_KEY_EXPIRY_DAYS = 60;

export const PUBLIC_API_ARTIFACTS = {
  openApi: "/openapi.json",
  postmanCollection: "/postman/pharos-api.postman_collection.json",
  postmanEnvironment: "/postman/pharos-api.postman_environment.json",
} as const;

export const SELF_SERVE_API_KEY_SUMMARY =
  `email-verified, limited to ${SELF_SERVE_API_KEY_RATE_LIMIT_RPM} requests per minute, and expires after ${SELF_SERVE_API_KEY_EXPIRY_DAYS} days`;
