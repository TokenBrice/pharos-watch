import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { handleScorecardOg } from "./og-scorecard";
// Frozen once from the evergreen map in effect when the numerical families were
// retired (scripts/maintenance/state/social-preview-images.json at dfa0f3cf70).
// Never regenerate it: its targets are permanent, and later ids never had a legacy URL.
import LEGACY_OG_IMAGE_HASHES from "./og-legacy-redirects.json";

/** Retired families, plus their never-referenced `/api/og/v2/*` aliases. */
const LEGACY_OG_PATTERN = /^\/api\/og\/(?:v2\/)?(stablecoin\/.+|chain\/.+|page\/.+|depeg|safety-scores|stability-index)$/;
const SCORECARD_OG_PATTERN = /^\/api\/og\/v2\/scorecard\/([^/]+)$/;
const LEGACY_OG_IMAGES = new Map<string, string>(Object.entries(LEGACY_OG_IMAGE_HASHES));
const HOME_IMAGE_HASH = LEGACY_OG_IMAGES.get("page/home")!;

/** Old shares keep a preview: the destination's evergreen image, or the home image for an unknown id. */
function legacyOgRedirect(key: string): Response {
  return new Response(null, {
    status: 301,
    headers: {
      Location: `${SITE_ORIGIN}/og/v2/image-${LEGACY_OG_IMAGES.get(key) ?? HOME_IMAGE_HASH}.png`,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

function decodeOgCapture(raw: string): string | Response {
  try {
    const decoded = decodeURIComponent(raw);
    return encodeURIComponent(decoded) === raw ? decoded : new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  } catch {
    return new Response("Malformed URI", { status: 400, headers: { "Content-Type": "text/plain" } });
  }
}

export async function handleOg(db: D1Database, path: string): Promise<Response | null> {
  const legacy = LEGACY_OG_PATTERN.exec(path);
  if (legacy) return legacyOgRedirect(legacy[1]);
  const scorecard = SCORECARD_OG_PATTERN.exec(path);
  if (!scorecard) return null;
  const id = decodeOgCapture(scorecard[1]);
  // handleScorecardOg fails closed on its own source and render errors.
  return id instanceof Response ? id : handleScorecardOg(db, id);
}
