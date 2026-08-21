import type { KVNamespace } from "@cloudflare/workers-types";

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

const KEY_PREFIX = "safety-map:";
const LATEST_KEY = `${KEY_PREFIX}latest.png`;
const ARCHIVE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Short edge TTL with a long grace window: the producer runs once a day. */
const LATEST_CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
/** Dated keys are write-once, so they can be cached forever. */
const ARCHIVE_CACHE_CONTROL = "public, max-age=31536000, s-maxage=31536000, immutable";

const IMAGE_HEADERS = {
  "Content-Type": "image/png",
  "X-Content-Type-Options": "nosniff",
} as const;

const ERROR_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

interface SafetyMapEnv {
  SELECTOR_SNAPSHOTS?: KVNamespace;
}

interface SafetyMapContext {
  request: Request;
  env: SafetyMapEnv;
}

function textError(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { ...ERROR_HEADERS, ...headers },
  });
}

/**
 * Resolve the KV key for this request, or a rejection response. Never lists the
 * namespace and never accepts a caller-supplied key fragment beyond a strict
 * `YYYY-MM-DD` date.
 */
function resolveKey(request: Request): { key: string; cacheControl: string } | Response {
  const date = new URL(request.url).searchParams.get("date");
  if (date === null) {
    return { key: LATEST_KEY, cacheControl: LATEST_CACHE_CONTROL };
  }
  if (!ARCHIVE_DATE_PATTERN.test(date)) {
    return textError(400, "Invalid date; expected YYYY-MM-DD");
  }
  return { key: `${KEY_PREFIX}${date}.png`, cacheControl: ARCHIVE_CACHE_CONTROL };
}

/**
 * HEAD answers exactly as GET does, minus the body. Several social platforms
 * probe an image URL with HEAD before fetching it, so a 405 there would defeat
 * the poster's whole purpose.
 */
function withoutBody(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const onRequest = async ({ request, env }: SafetyMapContext): Promise<Response> => {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return textError(405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  const bodyless = method === "HEAD";
  const respond = (response: Response): Response => (bodyless ? withoutBody(response) : response);

  const resolved = resolveKey(request);
  if (resolved instanceof Response) return respond(resolved);

  // An unbound namespace is the same observable state as an unpublished map:
  // the poster is not available, and the digest must omit it.
  if (!env.SELECTOR_SNAPSHOTS) {
    return respond(textError(404, "Safety map is not available"));
  }

  let bytes: ArrayBuffer | null;
  try {
    bytes = await env.SELECTOR_SNAPSHOTS.get(resolved.key, { type: "arrayBuffer" });
  } catch (error) {
    console.warn("[safety-map] KV read failure", error);
    return respond(textError(503, "Safety map store temporarily unavailable"));
  }

  if (bytes === null || bytes.byteLength === 0) {
    return respond(textError(404, "Safety map is not available"));
  }

  // `Content-Length` is set explicitly so a HEAD probe learns the poster's size
  // without transferring it.
  return respond(
    new Response(bytes, {
      status: 200,
      headers: {
        ...IMAGE_HEADERS,
        "Cache-Control": resolved.cacheControl,
        "Content-Length": String(bytes.byteLength),
      },
    }),
  );
};
