import { API_ORIGIN } from "./runtime-origins";
import { SOCIAL_PREVIEW_HEIGHT, SOCIAL_PREVIEW_WIDTH } from "./social-preview";
import { SOCIAL_PREVIEW_ASSET_OBJECT_PREFIX } from "./social-preview-storage";

export const SOCIAL_PREVIEW_ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const SOCIAL_PREVIEW_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

export interface SocialPreviewAssetIdentity {
  filename: string;
  key: string;
}

export function isEvergreenImageHash(value: string | null): value is string {
  return value !== null && /^[a-f0-9]{64}$/.test(value);
}

/**
 * The evergreen fallback of an API-hosted dossier preview (`API_PATHS.ogDossier`), or null.
 * Matched literally so the site-wide Share button does not bundle every API path.
 */
export function dossierOgFallbackPath(preview: URL, id: string): string | null {
  const hash = preview.searchParams.get("fallback");
  return isEvergreenImageHash(hash)
    && preview.href === `${API_ORIGIN}/api/og/v2/dossier/${encodeURIComponent(id)}?fallback=${hash}`
    ? `/og/v2/image-${hash}.png`
    : null;
}

export function socialPreviewAssetIdentity(pathname: string): SocialPreviewAssetIdentity | null {
  const match = /^\/og\/v2\/([a-z0-9-]{1,100})-([a-f0-9]{64})\.png$/.exec(pathname);
  if (!match || match[1].startsWith("-") || match[1].endsWith("-") || match[1].includes("--")) return null;
  const filename = `${match[1]}-${match[2]}.png`;
  return { filename, key: `${SOCIAL_PREVIEW_ASSET_OBJECT_PREFIX}${filename}` };
}

/** Inspect the actual PNG, never an HTML/error body accepted only by content type. */
export function assertSocialPreviewPng(bytes: Uint8Array): void {
  if (bytes.byteLength < 45 || bytes.byteLength > SOCIAL_PREVIEW_ASSET_MAX_BYTES
    || !PNG_MAGIC.every((byte, index) => bytes[index] === byte)) throw new Error("Invalid social preview PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
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
    if (type === "IDAT" && length > 0) hasImageData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.byteLength || !hasImageData) throw new Error("Invalid social preview PNG ending");
      return;
    }
    offset = end;
  }
  throw new Error("Incomplete social preview PNG");
}
