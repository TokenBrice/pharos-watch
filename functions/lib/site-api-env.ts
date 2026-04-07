import type { D1Database } from "@cloudflare/workers-types";
import { getConfiguredValue } from "@shared/lib/env-utils";
import {
  API_ORIGIN,
  OPS_UI_HOSTNAME,
  SITE_HOSTNAME,
  normalizeOrigin,
} from "@shared/lib/runtime-origins";
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
  code: "site-api-origin-missing" | "site-api-secret-missing" | "site-data-db-missing";
  message: string;
}

export interface SiteDataProxyRuntimePolicy {
  allowPublicApiFallback: boolean;
  hostKind: "production" | "preview-or-local";
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

export function isProductionSiteDataHostname(hostname: string): boolean {
  return hostname === SITE_HOSTNAME || hostname === OPS_UI_HOSTNAME;
}

export function resolveSiteDataProxyRuntimePolicy(url: URL): SiteDataProxyRuntimePolicy {
  if (isProductionSiteDataHostname(url.hostname)) {
    return {
      allowPublicApiFallback: false,
      hostKind: "production",
    };
  }

  return {
    allowPublicApiFallback: true,
    hostKind: "preview-or-local",
  };
}

export function resolveSiteApiOrigin(
  env: Pick<SiteDataProxyEnv, "SITE_API_ORIGIN">,
  options: { allowPublicApiFallback?: boolean } = {},
): string | null {
  const configuredOrigin = getConfiguredValue(env.SITE_API_ORIGIN);
  if (!configuredOrigin) {
    return options.allowPublicApiFallback === false ? null : DEFAULT_SITE_API_ORIGIN;
  }

  try {
    return normalizeOrigin(configuredOrigin);
  } catch {
    return options.allowPublicApiFallback === false ? null : DEFAULT_SITE_API_ORIGIN;
  }
}

export function resolveSiteDataUpstreamLane(
  env: Pick<SiteDataProxyEnv, "SITE_API_ORIGIN">,
  options: { allowPublicApiFallback?: boolean } = {},
): SiteDataRequestUpstreamLane {
  return resolveSiteApiOrigin(env, options) === API_ORIGIN ? "public-api-fallback" : "site-api";
}

export function validatePagesSiteDataProxyEnv(
  env: SiteDataProxyEnv,
  options: { requireSiteApiOrigin?: boolean } = {},
): SiteDataProxyEnvIssue[] {
  const hasSecret = typeof env.SITE_API_SHARED_SECRET === "string" && env.SITE_API_SHARED_SECRET.trim().length > 0;
  const issues: SiteDataProxyEnvIssue[] = [];

  if (options.requireSiteApiOrigin && !getConfiguredValue(env.SITE_API_ORIGIN)) {
    issues.push({
      code: "site-api-origin-missing",
      message: "SITE_API_ORIGIN must be configured for production site-data proxy traffic.",
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
      message: "DB must be bound on the Pages project for durable site-data attribution telemetry.",
    });
  }

  return issues;
}
