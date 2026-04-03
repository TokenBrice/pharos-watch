import { SITE_API_ORIGIN, resolveOrigin } from "@shared/lib/runtime-origins";

export const DEFAULT_SITE_API_ORIGIN = SITE_API_ORIGIN;

export interface SiteDataProxyEnv {
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
  SITE_API_ORIGIN?: string;
  SITE_API_SHARED_SECRET?: string;
}

export interface SiteDataProxyEnvIssue {
  code: "site-api-secret-missing";
  message: string;
}

export const SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS = [
  "SITE_API_SHARED_SECRET",
] as const;

export const SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS = [
  "SITE_ORIGIN",
  "OPS_UI_ORIGIN",
  "SITE_API_ORIGIN",
] as const;

export const SITE_DATA_FUNCTIONS_ACTIVE_ENV_KEYS = [
  ...SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS,
  ...SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS,
] as const;

export function resolveSiteApiOrigin(env: Pick<SiteDataProxyEnv, "SITE_API_ORIGIN">): string {
  return resolveOrigin(env.SITE_API_ORIGIN, DEFAULT_SITE_API_ORIGIN);
}

export function validatePagesSiteDataProxyEnv(env: SiteDataProxyEnv): SiteDataProxyEnvIssue[] {
  const hasSecret = typeof env.SITE_API_SHARED_SECRET === "string" && env.SITE_API_SHARED_SECRET.trim().length > 0;
  return hasSecret ? [] : [{
    code: "site-api-secret-missing",
    message: "SITE_API_SHARED_SECRET must be configured for the site-data proxy.",
  }];
}
