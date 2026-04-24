import {
  OPS_UI_ORIGIN,
  SITE_ORIGIN,
  isPagesAppHostname,
  resolveOrigin,
} from "@shared/lib/runtime-origins";

export const DEFAULT_SITE_UI_ORIGIN = SITE_ORIGIN;
export const DEFAULT_OPS_UI_ORIGIN = OPS_UI_ORIGIN;

function resolveAllowedHostnames(env: { SITE_ORIGIN?: string; OPS_UI_ORIGIN?: string }): Set<string> {
  return new Set([
    new URL(resolveOrigin(env.SITE_ORIGIN, DEFAULT_SITE_UI_ORIGIN)).hostname,
    new URL(resolveOrigin(env.OPS_UI_ORIGIN, DEFAULT_OPS_UI_ORIGIN)).hostname,
  ]);
}

function hostnameOfHeader(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    return new URL(trimmed).hostname;
  } catch {
    return null;
  }
}

function isAllowedHostname(hostname: string, allowed: Set<string>): boolean {
  return allowed.has(hostname) || isPagesAppHostname(hostname);
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

  const allowed = resolveAllowedHostnames(env);
  const originHost = hostnameOfHeader(request.headers.get("Origin"));
  if (originHost !== null) {
    return isAllowedHostname(originHost, allowed) ? null : notFound();
  }

  const refererHost = hostnameOfHeader(request.headers.get("Referer"));
  if (refererHost !== null) {
    return isAllowedHostname(refererHost, allowed) ? null : notFound();
  }

  return notFound();
}
