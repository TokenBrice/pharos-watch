import { normalizeTeamDomain } from "@shared/lib/cloudflare-access-jwt";
import { getRuntimeActiveEnvKeys, getRuntimeEnvKeys } from "@shared/lib/env-contract";
import { getConfiguredValue, hasConfiguredValue } from "@shared/lib/env-utils";
import { OPS_API_ORIGIN } from "@shared/lib/runtime-origins";
import { resolveTrustedHttpsOrigin } from "./trusted-upstream-origin";

export const DEFAULT_OPS_API_ORIGIN = OPS_API_ORIGIN;

export interface OpsAdminProxyEnv {
  OPS_UI_ORIGIN?: string;
  OPS_API_ORIGIN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_OPS_UI_AUD?: string;
  OPS_API_SERVICE_TOKEN_ID?: string;
  OPS_API_SERVICE_TOKEN_SECRET?: string;
}

export interface OpsProxyEnvIssue {
  code: "ops-service-token-incomplete" | "ops-access-ui-incomplete" | "ops-api-origin-invalid";
  message: string;
}

export interface ResolvedPagesOpsUiAccessConfig {
  teamDomain: string;
  aud: string;
}

export const PAGES_FUNCTIONS_REQUIRED_ENV_KEYS = getRuntimeEnvKeys("pagesOps", "required");

export const PAGES_FUNCTIONS_OPTIONAL_ENV_KEYS = getRuntimeEnvKeys("pagesOps", "optional");

export const PAGES_FUNCTIONS_RESERVED_ENV_KEYS = getRuntimeEnvKeys("pagesOps", "reserved");

export const PAGES_FUNCTIONS_ACTIVE_ENV_KEYS = getRuntimeActiveEnvKeys("pagesOps");

export function resolveOpsApiOrigin(env: Pick<OpsAdminProxyEnv, "OPS_API_ORIGIN">): string | null {
  return resolveTrustedHttpsOrigin(env.OPS_API_ORIGIN ?? DEFAULT_OPS_API_ORIGIN, [DEFAULT_OPS_API_ORIGIN]);
}

export function resolvePagesOpsUiAccessConfig(
  env: Pick<OpsAdminProxyEnv, "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_OPS_UI_AUD">,
): ResolvedPagesOpsUiAccessConfig | null {
  const rawTeamDomain = getConfiguredValue(env.CF_ACCESS_TEAM_DOMAIN);
  const aud = getConfiguredValue(env.CF_ACCESS_OPS_UI_AUD);
  if (!rawTeamDomain || !aud) {
    return null;
  }
  return { teamDomain: normalizeTeamDomain(rawTeamDomain), aud };
}

export function validatePagesOpsProxyEnv(env: OpsAdminProxyEnv): OpsProxyEnvIssue[] {
  const issues: OpsProxyEnvIssue[] = [];
  if (!resolveOpsApiOrigin(env)) {
    issues.push({
      code: "ops-api-origin-invalid",
      message: `OPS_API_ORIGIN must be the canonical HTTPS origin ${DEFAULT_OPS_API_ORIGIN}.`,
    });
  }
  const hasTokenId = hasConfiguredValue(env.OPS_API_SERVICE_TOKEN_ID);
  const hasTokenSecret = hasConfiguredValue(env.OPS_API_SERVICE_TOKEN_SECRET);

  if (hasTokenId !== hasTokenSecret) {
    issues.push({
      code: "ops-service-token-incomplete",
      message: "OPS_API_SERVICE_TOKEN_ID and OPS_API_SERVICE_TOKEN_SECRET must be configured together.",
    });
  }

  const hasAccessTeamDomain = hasConfiguredValue(env.CF_ACCESS_TEAM_DOMAIN);
  const hasOpsUiAud = hasConfiguredValue(env.CF_ACCESS_OPS_UI_AUD);
  if (!hasAccessTeamDomain || !hasOpsUiAud) {
    issues.push({
      code: "ops-access-ui-incomplete",
      message: "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_OPS_UI_AUD must be configured together for Pages-side Access JWT verification.",
    });
  }

  return issues;
}
