import { SOCIAL_PREVIEW_HEIGHT, SOCIAL_PREVIEW_WIDTH } from "./social-preview";
import { SOCIAL_PREVIEW_ASSET_OBJECT_PREFIX } from "./social-preview-storage";

export const SOCIAL_PREVIEW_ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const SOCIAL_PREVIEW_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const SHA256 = /^[a-f0-9]{64}$/;
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const SOURCE_KEY = "pharos-source-sha256\0";

export interface SocialPreviewAssetIdentity {
  filename: string;
  semanticHash: string;
  key: string;
}

export function socialPreviewAssetIdentity(pathname: string): SocialPreviewAssetIdentity | null {
  const match = /^\/og\/v2\/([a-z0-9-]{1,100})-([a-f0-9]{64})\.png$/.exec(pathname);
  if (!match || match[1].startsWith("-") || match[1].endsWith("-") || match[1].includes("--")) return null;
  const filename = `${match[1]}-${match[2]}.png`;
  return { filename, semanticHash: match[2], key: `${SOCIAL_PREVIEW_ASSET_OBJECT_PREFIX}${filename}` };
}

/** Inspect the actual PNG, never an HTML/error body accepted only by content type. */
export function readSocialPreviewPngSource(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 45 || bytes.byteLength > SOCIAL_PREVIEW_ASSET_MAX_BYTES
    || !PNG_MAGIC.every((byte, index) => bytes[index] === byte)) throw new Error("Invalid social preview PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let source: string | null = null;
  let hasImageData = false;
  for (let offset = 8; offset + 12 <= bytes.byteLength;) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.byteLength) throw new Error("Truncated social preview PNG");
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    if (offset === 8 && (type !== "IHDR" || length !== 13
      || view.getUint32(offset + 8) !== SOCIAL_PREVIEW_WIDTH || view.getUint32(offset + 12) !== SOCIAL_PREVIEW_HEIGHT)) {
      throw new Error("Invalid social preview dimensions");
    }
    if (type === "tEXt") {
      const text = decoder.decode(bytes.subarray(offset + 8, end - 4));
      if (text.startsWith(SOURCE_KEY)) {
        if (source !== null || !SHA256.test(text.slice(SOURCE_KEY.length))) throw new Error("Invalid social preview source stamp");
        source = text.slice(SOURCE_KEY.length);
      }
    }
    if (type === "IDAT" && length > 0) hasImageData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.byteLength || !hasImageData) throw new Error("Invalid social preview PNG ending");
      return source;
    }
    offset = end;
  }
  throw new Error("Incomplete social preview PNG");
}

/** Hash metadata binds the URL's semantic identity to the original source and bytes. */
export async function verifySocialPreviewAsset(
  bytes: Uint8Array,
  identity: SocialPreviewAssetIdentity,
  metadata: Record<string, string> | undefined,
): Promise<string> {
  const source = readSocialPreviewPngSource(bytes);
  if (!metadata || !SHA256.test(metadata["png-sha256"] ?? "") || !SHA256.test(metadata["source-fingerprint"] ?? "")
    || metadata["semantic-hash"] !== identity.semanticHash || (metadata.kind !== "rendered" && metadata.kind !== "authored")) {
    throw new Error("Invalid social preview hash metadata");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== metadata["png-sha256"] || (metadata.kind === "rendered" && source !== metadata["source-fingerprint"])
    || (metadata.kind === "authored" && (hash !== metadata["source-fingerprint"] || hash !== identity.semanticHash))) {
    throw new Error("Social preview integrity mismatch");
  }
  return hash;
}
