import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { handleDepegBriefingOg } from "./og-depeg";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { isEvergreenImageHash } from "@shared/lib/social-preview-asset";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { handleScorecardOg } from "./og-scorecard";
// Frozen once from the evergreen map in effect when the numerical families were
// retired (scripts/maintenance/state/social-preview-images.json at dfa0f3cf70).
// Never regenerate it: its targets are permanent, and later ids never had a legacy URL.
import LEGACY_OG_IMAGE_HASHES from "./og-legacy-redirects.json";

/** Retired families, plus their never-referenced `/api/og/v2/*` aliases. */
const LEGACY_OG_PATTERN = /^\/api\/og\/(?:v2\/)?(stablecoin\/.+|chain\/.+|page\/.+|depeg|safety-scores|stability-index)$/;
const DATED_OG_PATTERN = /^\/api\/og\/v2\/(scorecard|dossier)\/([^/]+)$/;
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

export async function handleOg(db: D1Database, path: string, fallback: string | null = null): Promise<Response | null> {
  if (path === API_PATHS.ogDepegBriefing()) return handleDepegBriefingOg(db);
  const legacy = LEGACY_OG_PATTERN.exec(path);
  if (legacy) return legacyOgRedirect(legacy[1]);
  const dated = DATED_OG_PATTERN.exec(path);
  if (!dated) return null;
  const id = decodeOgCapture(dated[2]);
  if (id instanceof Response) return id;
  if (dated[1] === "scorecard") return handleScorecardOg(db, id);
  if (ACTIVE_IDS.has(id)) {
    const scorecard = await handleScorecardOg(db, id);
    if (scorecard.ok) return scorecard;
  }
  // The Worker edge cache ignores OG queries and admits only 200 responses.
  const hash = isEvergreenImageHash(fallback) ? fallback : HOME_IMAGE_HASH;
  return new Response(null, {
    status: 302,
    headers: { Location: `${SITE_ORIGIN}/og/v2/image-${hash}.png`, "Cache-Control": "public, max-age=180" },
  });
}
