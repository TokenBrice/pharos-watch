import { OPS_API_ORIGIN, resolveOrigin } from "@shared/lib/runtime-origins";

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
  code: "ops-service-token-incomplete" | "ops-access-ui-partial-config";
  message: string;
}

export const PAGES_FUNCTIONS_REQUIRED_ENV_KEYS = [
  "OPS_API_SERVICE_TOKEN_ID",
  "OPS_API_SERVICE_TOKEN_SECRET",
] as const;

export const PAGES_FUNCTIONS_OPTIONAL_ENV_KEYS = [
  "OPS_UI_ORIGIN",
  "OPS_API_ORIGIN",
] as const;

export const PAGES_FUNCTIONS_RESERVED_ENV_KEYS = [
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_OPS_UI_AUD",
] as const;

export const PAGES_FUNCTIONS_ACTIVE_ENV_KEYS = [
  ...PAGES_FUNCTIONS_REQUIRED_ENV_KEYS,
  ...PAGES_FUNCTIONS_OPTIONAL_ENV_KEYS,
] as const;

export function resolveOpsApiOrigin(env: Pick<OpsAdminProxyEnv, "OPS_API_ORIGIN">): string {
  return resolveOrigin(env.OPS_API_ORIGIN, DEFAULT_OPS_API_ORIGIN);
}

export function validatePagesOpsProxyEnv(env: OpsAdminProxyEnv): OpsProxyEnvIssue[] {
  const issues: OpsProxyEnvIssue[] = [];
  const hasTokenId = typeof env.OPS_API_SERVICE_TOKEN_ID === "string" && env.OPS_API_SERVICE_TOKEN_ID.trim().length > 0;
  const hasTokenSecret = typeof env.OPS_API_SERVICE_TOKEN_SECRET === "string" && env.OPS_API_SERVICE_TOKEN_SECRET.trim().length > 0;

  if (hasTokenId !== hasTokenSecret) {
    issues.push({
      code: "ops-service-token-incomplete",
      message: "OPS_API_SERVICE_TOKEN_ID and OPS_API_SERVICE_TOKEN_SECRET must be configured together.",
    });
  }

  const hasAccessTeamDomain = typeof env.CF_ACCESS_TEAM_DOMAIN === "string" && env.CF_ACCESS_TEAM_DOMAIN.trim().length > 0;
  const hasOpsUiAud = typeof env.CF_ACCESS_OPS_UI_AUD === "string" && env.CF_ACCESS_OPS_UI_AUD.trim().length > 0;
  if (hasAccessTeamDomain !== hasOpsUiAud) {
    issues.push({
      code: "ops-access-ui-partial-config",
      message: "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_OPS_UI_AUD are reserved together for future Pages-side Access validation.",
    });
  }

  return issues;
}
