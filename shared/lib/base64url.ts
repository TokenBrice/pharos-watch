/**
 * Neutral base64url codec shared by frontend/runtime-neutral helpers and worker
 * wrappers. Depends only on Web Platform APIs available in both runtimes.
 */

import { bytesToBase64 } from "./base64";

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** UTF-8 string to base64url. For ASCII payloads this is byte-identical to a raw btoa-based codec. */
export function stringToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

/** base64url to UTF-8 string. Throws on invalid base64; callers wrap in try/catch. */
export function base64UrlToString(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}
