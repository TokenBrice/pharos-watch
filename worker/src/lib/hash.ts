import { createHash } from "node:crypto";
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

/** Native, bounded-memory counterpart of the runtime-neutral chunk digest. */
export function sha256HexFromUtf8Chunks(chunks: Iterable<string>): string {
  const hash = createHash("sha256");
  let pendingHighSurrogate = "";
  for (const chunk of chunks) {
    if (typeof chunk !== "string") throw new TypeError("SHA-256 text chunks must be strings");
    let text = pendingHighSurrogate + chunk;
    pendingHighSurrogate = "";
    const finalCodeUnit = text.charCodeAt(text.length - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
      pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (text.length > 0) hash.update(text);
  }
  if (pendingHighSurrogate.length > 0) hash.update(pendingHighSurrogate);
  return hash.digest("hex");
}
