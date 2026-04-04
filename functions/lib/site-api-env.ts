import type { D1Database } from "@cloudflare/workers-types";
import { API_ORIGIN, resolveOrigin } from "@shared/lib/runtime-origins";
import type { SiteDataRequestUpstreamLane } from "@shared/types";

// Keep the website data lane functional until a dedicated site-api hostname is
// explicitly provisioned and wired into the Pages environment.
export const DEFAULT_SITE_API_ORIGIN = API_ORIGIN;

export interface SiteDataProxyEnv {
  DB?: D1Database;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
  SITE_API_ORIGIN?: string;
  SITE_API_SHARED_SECRET?: string;
}

export interface SiteDataProxyEnvIssue {
  code: "site-api-secret-missing" | "site-data-db-missing";
  message: string;
}

export const SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS = [
  "SITE_API_SHARED_SECRET",
] as const;

export const SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS = [
  "DB",
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

export function resolveSiteDataUpstreamLane(env: Pick<SiteDataProxyEnv, "SITE_API_ORIGIN">): SiteDataRequestUpstreamLane {
  return resolveSiteApiOrigin(env) === API_ORIGIN ? "public-api-fallback" : "site-api";
}

export function validatePagesSiteDataProxyEnv(env: SiteDataProxyEnv): SiteDataProxyEnvIssue[] {
  const hasSecret = typeof env.SITE_API_SHARED_SECRET === "string" && env.SITE_API_SHARED_SECRET.trim().length > 0;
  const issues: SiteDataProxyEnvIssue[] = [];

  if (!hasSecret) {
    issues.push({
      code: "site-api-secret-missing",
      message: "SITE_API_SHARED_SECRET must be configured for the site-data proxy.",
    });
  }

  if (!env.DB) {
    issues.push({
      code: "site-data-db-missing",
      message: "DB must be bound on the Pages project for durable site-data attribution telemetry.",
    });
  }

  return issues;
}
