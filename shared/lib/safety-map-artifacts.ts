const SAFETY_MAP_KEY_PREFIX = "safety-map:";

export const SAFETY_MAP_MANIFEST_KEY = `${SAFETY_MAP_KEY_PREFIX}latest.json`;
export const SAFETY_MAP_LATEST_KEY = `${SAFETY_MAP_KEY_PREFIX}latest.png`;
export const SAFETY_MAP_TEASER_KEY = `${SAFETY_MAP_KEY_PREFIX}latest.webp`;
export const SAFETY_MAP_TEASER_MOBILE_KEY = `${SAFETY_MAP_KEY_PREFIX}latest-400.webp`;
export const SAFETY_MAP_TEASER_MOBILE_WIDTH = 400;
export const SAFETY_MAP_TEASER_MOBILE_HEIGHT = 225;
export const SAFETY_MAP_ALT_KEY = `${SAFETY_MAP_KEY_PREFIX}alt:latest`;
export const SAFETY_MAP_MANIFEST_MAX_BYTES = 16_384;

export function safetyMapArchiveKey(date: string): string {
  return `${SAFETY_MAP_KEY_PREFIX}${date}.png`;
}
