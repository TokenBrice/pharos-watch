import {
  mintSiteSessionToken,
  SITE_SESSION_AUTOMATION_TTL_SEC,
  SITE_SESSION_COOKIE_NAME,
  SITE_SESSION_HEADER,
} from "@shared/lib/site-session-token";
import { SITE_ORIGIN, OPS_UI_ORIGIN, SITE_API_ORIGIN, isPagesAppHostname } from "@shared/lib/runtime-origins";

export function isTrustedSiteSessionUrl(target: string | URL): boolean {
  try {
    const url = new URL(target);
    if (url.username || url.password) return false;
    if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "https:" && (
      [SITE_ORIGIN, OPS_UI_ORIGIN, SITE_API_ORIGIN].includes(url.origin)
      || (!url.port && isPagesAppHostname(url.hostname))
    );
  } catch {
    return false;
  }
}

let cached: { key: string; expires: number; token: Promise<string> } | undefined;

export async function siteSessionHeaders(
  target: string | URL,
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const key = env.SITE_SESSION_SIGNING_KEY;
  if (!key || !isTrustedSiteSessionUrl(target)) return {};
  if (!cached || cached.key !== key || cached.expires - nowSec < 120) {
    cached = {
      key,
      expires: nowSec + SITE_SESSION_AUTOMATION_TTL_SEC,
      token: mintSiteSessionToken({ key, kind: "automation", nowSec }),
    };
  }
  const token = await cached.token;
  return token ? { [SITE_SESSION_HEADER]: token } : {};
}

export async function siteSessionCookie(target: string | URL, env: Readonly<Record<string, string | undefined>> = process.env, nowSec = Math.floor(Date.now() / 1000)) {
  const headers = await siteSessionHeaders(target, env, nowSec);
  const value = headers[SITE_SESSION_HEADER];
  return value ? {
    name: SITE_SESSION_COOKIE_NAME,
    value,
    path: "/_site-data",
    secure: true,
    httpOnly: true,
    sameSite: "Strict" as const,
    expires: nowSec + SITE_SESSION_AUTOMATION_TTL_SEC,
  } : null;
}

/** The Pages proxy accepts the cookie and discards client-supplied session headers. */
export async function siteDataSessionHeaders(target: string | URL): Promise<Record<string, string>> {
  const headers = await siteSessionHeaders(target);
  const cookie = await siteSessionCookie(target);
  return { ...headers, ...(cookie ? { Cookie: `${cookie.name}=${cookie.value}` } : {}) };
}
