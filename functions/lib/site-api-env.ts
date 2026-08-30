import type { D1Database } from "@shared/types/cloudflare-runtime";
import { getRuntimeActiveEnvKeys, getRuntimeEnvKeys } from "@shared/lib/env-contract";
import { getConfiguredValue, hasConfiguredValue } from "@shared/lib/env-utils";
import { SITE_API_ORIGIN as CANONICAL_SITE_API_ORIGIN } from "@shared/lib/runtime-origins";
import { resolveTrustedHttpsOrigin } from "./trusted-upstream-origin";

export interface SiteDataProxyEnv {
  DB?: D1Database;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
  SITE_API_ORIGIN?: string;
  SITE_API_SHARED_SECRET?: string;
}

export interface SiteDataProxyEnvIssue {
  code: "site-api-origin-missing" | "site-api-origin-invalid" | "site-api-secret-missing" | "site-data-db-missing";
  message: string;
}

export const SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS = getRuntimeEnvKeys("pagesSiteData", "required");
export const SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS = getRuntimeEnvKeys("pagesSiteData", "optional");
export const SITE_DATA_FUNCTIONS_ACTIVE_ENV_KEYS = getRuntimeActiveEnvKeys("pagesSiteData");

export function resolveSiteApiOrigin(
  env: Pick<SiteDataProxyEnv, "SITE_API_ORIGIN">,
): string | null {
  const configuredOrigin = getConfiguredValue(env.SITE_API_ORIGIN);
  if (!configuredOrigin) {
    return null;
  }
  return resolveTrustedHttpsOrigin(configuredOrigin, [CANONICAL_SITE_API_ORIGIN]);
}

export function validatePagesSiteDataProxyEnv(
  env: SiteDataProxyEnv,
): SiteDataProxyEnvIssue[] {
  const hasSecret = hasConfiguredValue(env.SITE_API_SHARED_SECRET);
  const issues: SiteDataProxyEnvIssue[] = [];

  const configuredOrigin = getConfiguredValue(env.SITE_API_ORIGIN);
  if (!configuredOrigin) {
    issues.push({
      code: "site-api-origin-missing",
      message: "SITE_API_ORIGIN must be configured for the site-data proxy.",
    });
  } else if (!resolveSiteApiOrigin(env)) {
    issues.push({
      code: "site-api-origin-invalid",
      message: `SITE_API_ORIGIN must be the canonical HTTPS origin ${CANONICAL_SITE_API_ORIGIN}.`,
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
