import origins from "./runtime-origins.json";

export const SITE_ORIGIN = origins.siteOrigin;
export const API_ORIGIN = origins.apiOrigin;
export const SITE_API_ORIGIN = origins.siteApiOrigin;
export const OPS_UI_ORIGIN = origins.opsUiOrigin;
export const OPS_API_ORIGIN = origins.opsApiOrigin;
export const PAGES_APP_ORIGIN = origins.pagesAppOrigin;

export const SITE_HOSTNAME = new URL(SITE_ORIGIN).hostname;
export const API_HOSTNAME = new URL(API_ORIGIN).hostname;
export const SITE_API_HOSTNAME = new URL(SITE_API_ORIGIN).hostname;
export const OPS_UI_HOSTNAME = new URL(OPS_UI_ORIGIN).hostname;
export const OPS_API_HOSTNAME = new URL(OPS_API_ORIGIN).hostname;
export const PAGES_APP_HOSTNAME = new URL(PAGES_APP_ORIGIN).hostname;

/** Normalizes a string to a proper URL origin (protocol + host, no path). */
export function normalizeOrigin(input: string): string {
  const normalized = input.includes("://") ? input : `https://${input}`;
  return new URL(normalized).origin;
}

export function resolveOrigin(
  input: string | null | undefined,
  fallbackOrigin: string,
): string {
  const trimmed = input?.trim();
  if (!trimmed) {
    return fallbackOrigin;
  }

  try {
    return normalizeOrigin(trimmed);
  } catch {
    return fallbackOrigin;
  }
}

export function resolvePublicApiBase(
  hostname?: string | null,
  envBase?: string | null,
): string {
  const explicit = (envBase ?? "").trim();
  if (explicit) {
    return explicit;
  }
  if (!hostname) {
    return "";
  }
  return isCanonicalSiteHostname(hostname) ? API_ORIGIN : "";
}

export function isCanonicalSiteHostname(hostname: string): boolean {
  return hostname === SITE_HOSTNAME ||
    hostname.endsWith(`.${SITE_HOSTNAME}`) ||
    hostname === PAGES_APP_HOSTNAME ||
    hostname.endsWith(`.${PAGES_APP_HOSTNAME}`);
}

export function isPagesAppHostname(hostname: string): boolean {
  return hostname === PAGES_APP_HOSTNAME || hostname.endsWith(`.${PAGES_APP_HOSTNAME}`);
}

export function isSiteDataUiHostname(hostname: string): boolean {
  return hostname === SITE_HOSTNAME ||
    hostname === OPS_UI_HOSTNAME ||
    isPagesAppHostname(hostname);
}
