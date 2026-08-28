import {
  SAFETY_MAP_ARCHIVE_CACHE_CONTROL,
  SAFETY_MAP_ARCHIVE_DATE_PATTERN,
  SAFETY_MAP_IMAGE_HEADERS,
  SAFETY_MAP_KEY_PREFIX,
  SAFETY_MAP_LATEST_CACHE_CONTROL,
  SAFETY_MAP_LATEST_KEY,
  getSafetyMapReadMethod,
  readSafetyMapKv,
  safetyMapTextError,
  withoutSafetyMapBody,
  type SafetyMapContext,
} from "../lib/safety-map";

/**
 * Pages Function: `GET`/`HEAD` `/safety-scores/map.png`
 *
 * Serves the Safety Score map poster from the KV namespace the daily
 * `safety-map-refresh` workflow publishes into. The image cadence is
 * deliberately decoupled from Pages deploys, so the bytes cannot ride the
 * static export — see the map plan's hosting section.
 *
 * Two resources share this route:
 *
 * - `/safety-scores/map.png` — the live poster (`safety-map:latest.png`).
 * - `/safety-scores/map.png?date=YYYY-MM-DD` — an immutable dated archive
 *   (`safety-map:YYYY-MM-DD.png`). The daily digest embeds the dated URL, never
 *   `latest`, so Telegram/X CDNs can never serve yesterday's bytes off a stable
 *   URL and a bad poster is superseded rather than recalled.
 *
 * The archive lives on a query parameter rather than a nested path segment on
 * purpose: a `functions/safety-scores/map/[date].ts` route would sit directly
 * under the static `/safety-scores/map/` page and risks shadowing it. Cloudflare
 * includes the query string in the default cache key, so `?date=` is still a
 * distinct cache entry for both the edge and social scrapers.
 *
 * **A missing binding or a missing object is a 404 with `no-store`, not a 500.**
 * That is the map's kill switch: deleting the published keys must make this
 * route go quiet immediately and trip the digest's omit rule, without a Pages
 * release. This diverges from the `selector-snapshot` precedent, which treats an
 * absent binding as a misconfiguration.
 */

/**
 * Resolve the KV key for this request, or a rejection response. Never lists the
 * namespace and never accepts a caller-supplied key fragment beyond a strict
 * `YYYY-MM-DD` date.
 */
function resolveKey(request: Request): { key: string; cacheControl: string } | Response {
  const date = new URL(request.url).searchParams.get("date");
  if (date === null) {
    return { key: SAFETY_MAP_LATEST_KEY, cacheControl: SAFETY_MAP_LATEST_CACHE_CONTROL };
  }
  if (!SAFETY_MAP_ARCHIVE_DATE_PATTERN.test(date)) {
    return safetyMapTextError(400, "Invalid date; expected YYYY-MM-DD");
  }
  return { key: `${SAFETY_MAP_KEY_PREFIX}${date}.png`, cacheControl: SAFETY_MAP_ARCHIVE_CACHE_CONTROL };
}

export const onRequest = async ({ request, env }: SafetyMapContext): Promise<Response> => {
  const method = getSafetyMapReadMethod(request);
  if (method === null) {
    return safetyMapTextError(405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  const bodyless = method === "HEAD";
  const respond = (response: Response): Response => (bodyless ? withoutSafetyMapBody(response) : response);

  const resolved = resolveKey(request);
  if (resolved instanceof Response) return respond(resolved);

  // An unbound namespace is the same observable state as an unpublished map:
  // the poster is not available, and the digest must omit it.
  if (!env.SELECTOR_SNAPSHOTS) {
    return respond(safetyMapTextError(404, "Safety map is not available"));
  }

  const result = await readSafetyMapKv(() =>
    env.SELECTOR_SNAPSHOTS!.get(resolved.key, { type: "arrayBuffer" }),
  );
  if (!result.ok) {
    return respond(safetyMapTextError(503, "Safety map store temporarily unavailable"));
  }

  const bytes = result.value;
  if (bytes === null || bytes.byteLength === 0) {
    return respond(safetyMapTextError(404, "Safety map is not available"));
  }

  // `Content-Length` is set explicitly so a HEAD probe learns the poster's size
  // without transferring it.
  return respond(
    new Response(bytes, {
      status: 200,
      headers: {
        ...SAFETY_MAP_IMAGE_HEADERS,
        "Cache-Control": resolved.cacheControl,
        "Content-Length": String(bytes.byteLength),
      },
    }),
  );
};
