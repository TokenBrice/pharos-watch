/**
 * Neutral base64url codec shared by API-key material and cursor encoding.
 * Kept dependency-free so callers (api-key-core, api-params,
 * api-key-requests) avoid a heavier reverse-coupled import graph.
 */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** UTF-8 string → base64url. For ASCII payloads this is byte-identical to a raw btoa-based codec. */
export function stringToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

/** base64url → UTF-8 string. Throws on invalid base64 (callers wrap in try/catch). */
export function base64UrlToString(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}
