import type { D1Database } from "@cloudflare/workers-types";
import { getRuntimeActiveEnvKeys, getRuntimeEnvKeys } from "@shared/lib/env-contract";
import { getConfiguredValue } from "@shared/lib/env-utils";
import {
  OPS_UI_HOSTNAME,
  SITE_HOSTNAME,
  normalizeOrigin,
} from "@shared/lib/runtime-origins";

export interface SiteDataProxyEnv {
  DB?: D1Database;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
  SITE_API_ORIGIN?: string;
  SITE_API_SHARED_SECRET?: string;
}

export interface SiteDataProxyEnvIssue {
  code: "site-api-origin-missing" | "site-api-secret-missing" | "site-data-db-missing";
  message: string;
}

export const SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS = getRuntimeEnvKeys("pagesSiteData", "required");
export const SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS = getRuntimeEnvKeys("pagesSiteData", "optional");
export const SITE_DATA_FUNCTIONS_ACTIVE_ENV_KEYS = getRuntimeActiveEnvKeys("pagesSiteData");

export function isProductionSiteDataHostname(hostname: string): boolean {
  return hostname === SITE_HOSTNAME || hostname === OPS_UI_HOSTNAME;
}

export function resolveSiteApiOrigin(
  env: Pick<SiteDataProxyEnv, "SITE_API_ORIGIN">,
): string | null {
  const configuredOrigin = getConfiguredValue(env.SITE_API_ORIGIN);
  if (!configuredOrigin) {
    return null;
  }
  try {
    return normalizeOrigin(configuredOrigin);
  } catch {
    return null;
  }
}

export function validatePagesSiteDataProxyEnv(
  env: SiteDataProxyEnv,
): SiteDataProxyEnvIssue[] {
  const hasSecret = typeof env.SITE_API_SHARED_SECRET === "string" && env.SITE_API_SHARED_SECRET.trim().length > 0;
  const issues: SiteDataProxyEnvIssue[] = [];

  if (!getConfiguredValue(env.SITE_API_ORIGIN)) {
    issues.push({
      code: "site-api-origin-missing",
      message: "SITE_API_ORIGIN must be configured for the site-data proxy.",
    });
  }

  if (!hasSecret) {
    issues.push({
      code: "site-api-secret-missing",
      message: "SITE_API_SHARED_SECRET must be configured for the site-data proxy.",
    });
  }

  if (!env.DB) {
    issues.push({
      code: "site-data-db-missing",
      message: "DB is optional for the Pages site-data proxy, but attribution telemetry is disabled when it is not bound.",
    });
  }

  return issues;
}
