import {
  OPS_UI_ORIGIN,
  SITE_ORIGIN,
  isPagesAppHostname,
  resolveOrigin,
} from "@shared/lib/runtime-origins";

export const DEFAULT_SITE_UI_ORIGIN = SITE_ORIGIN;
export const DEFAULT_OPS_UI_ORIGIN = OPS_UI_ORIGIN;

function resolveAllowedOrigins(env: { SITE_ORIGIN?: string; OPS_UI_ORIGIN?: string }): Set<string> {
  return new Set([
    resolveOrigin(env.SITE_ORIGIN, DEFAULT_SITE_UI_ORIGIN),
    resolveOrigin(env.OPS_UI_ORIGIN, DEFAULT_OPS_UI_ORIGIN),
  ]);
}

export function rejectIfNotSiteDataUiOrigin(
  request: Request,
  env: { SITE_ORIGIN?: string; OPS_UI_ORIGIN?: string },
  notFound: () => Response,
): Response | null {
  const url = new URL(request.url);
  if (isPagesAppHostname(url.hostname)) {
    return null;
  }
  return resolveAllowedOrigins(env).has(url.origin) ? null : notFound();
}
