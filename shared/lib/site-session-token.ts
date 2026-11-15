import { base64UrlToBytes, bytesToBase64Url } from "./base64url";

export const SITE_SESSION_COOKIE_NAME = "__Secure-pharos-session";
export const SITE_SESSION_HEADER = "X-Pharos-Site-Session";
export const SITE_SESSION_HINT_HEADER = "X-Pharos-Session";
export const SITE_SESSION_EXPIRES_HEADER = "X-Pharos-Session-Expires";
export const SITE_SESSION_BROWSER_TTL_SEC = 43200;
export const SITE_SESSION_AUTOMATION_TTL_SEC = 900;
export const SITE_SESSION_CLOCK_LEEWAY_SEC = 60;

export type SiteSessionKind = "browser" | "automation";
export interface SiteSessionPayload {
  v: 1;
  sid: string;
  kind: SiteSessionKind;
  iat: number;
  exp: number;
}

const ENCODER = new TextEncoder();
const normalizeSigningKey = (key: string | null | undefined): string => key?.trim() ?? "";

export function hasSiteSessionSigningKey(key: string | null | undefined): key is string {
  return normalizeSigningKey(key).length > 0;
}

function isPayload(value: unknown): value is SiteSessionPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return Object.keys(payload).length === 5
    && payload.v === 1
    && typeof payload.sid === "string" && payload.sid.length > 0
    && (payload.kind === "browser" || payload.kind === "automation")
    && typeof payload.iat === "number" && Number.isInteger(payload.iat)
    && typeof payload.exp === "number" && Number.isInteger(payload.exp)
    && payload.exp > payload.iat
    && payload.exp - payload.iat <= (payload.kind === "browser" ? SITE_SESSION_BROWSER_TTL_SEC : SITE_SESSION_AUTOMATION_TTL_SEC);
}

function importKey(key: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ENCODER.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function mintSiteSessionToken(input: {
  key: string;
  kind: SiteSessionKind;
  nowSec: number;
  ttlSec?: number;
  sid?: string;
}): Promise<string> {
  const key = normalizeSigningKey(input.key);
  if (!key) return "";
  const ttl = input.ttlSec ?? (input.kind === "browser" ? SITE_SESSION_BROWSER_TTL_SEC : SITE_SESSION_AUTOMATION_TTL_SEC);
  const payload: SiteSessionPayload = {
    v: 1,
    sid: input.sid ?? bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12))),
    kind: input.kind,
    iat: input.nowSec,
    exp: input.nowSec + ttl,
  };
  if (!isPayload(payload)) throw new Error("Invalid site session mint input");
  const bytes = ENCODER.encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", await importKey(key, "sign"), bytes);
  const token = `${bytesToBase64Url(bytes)}.${bytesToBase64Url(new Uint8Array(signature))}`;
  if (token.length > 512) throw new Error("Site session token exceeds 512 characters");
  return token;
}

export async function verifySiteSessionToken(input: {
  token: string | null | undefined;
  keys: readonly (string | null | undefined)[];
  nowSec: number;
}): Promise<
  | { ok: true; payload: SiteSessionPayload }
  | { ok: false; reason: "missing" | "malformed" | "bad-signature" | "expired" | "not-yet-valid" }
> {
  try {
    const { token, keys, nowSec } = input;
    if (!token) return { ok: false, reason: "missing" };
    if (token.length > 512 || !Number.isInteger(nowSec)) return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      return { ok: false, reason: "malformed" };
    }
    const bytes = new Uint8Array(base64UrlToBytes(parts[0]));
    const signature = new Uint8Array(base64UrlToBytes(parts[1]));
    if (bytesToBase64Url(bytes) !== parts[0] || bytesToBase64Url(signature) !== parts[1] || signature.length !== 32) {
      return { ok: false, reason: "malformed" };
    }
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!isPayload(payload)) return { ok: false, reason: "malformed" };
    let verified = false;
    for (const rawKey of keys) {
      const key = normalizeSigningKey(rawKey);
      if (!key) continue;
      try {
        if (await crypto.subtle.verify("HMAC", await importKey(key, "verify"), signature, bytes)) {
          verified = true;
          break;
        }
      } catch {
        // A failed key must not prevent checking the remaining rotation keys.
      }
    }
    if (!verified) return { ok: false, reason: "bad-signature" };
    if (nowSec >= payload.exp + SITE_SESSION_CLOCK_LEEWAY_SEC) return { ok: false, reason: "expired" };
    if (payload.iat > nowSec + SITE_SESSION_CLOCK_LEEWAY_SEC) return { ok: false, reason: "not-yet-valid" };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export function readSiteSessionCookie(cookieHeader: string | null | undefined): string | null {
  for (const cookie of cookieHeader?.split(";") ?? []) {
    const separator = cookie.indexOf("=");
    if (separator !== -1 && cookie.slice(0, separator).trim() === SITE_SESSION_COOKIE_NAME) {
      return cookie.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

export function buildSiteSessionCookie(token: string, maxAgeSec: number): string {
  return `${SITE_SESSION_COOKIE_NAME}=${token}; Path=/_site-data; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
