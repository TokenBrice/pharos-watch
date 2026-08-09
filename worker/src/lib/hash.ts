import { fnv1a32Hex } from "@shared/lib/fnv1a";

/** FNV-1a 32-bit hash. Returns an 8-char lowercase hex string. */
export const fnv1aHash = fnv1a32Hex;

const textEncoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : Uint8Array.from(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}
