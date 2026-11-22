import {
  SAFETY_MAP_TEASER_KEY,
  SAFETY_MAP_TEASER_MOBILE_KEY,
  SAFETY_MAP_TEASER_MOBILE_WIDTH,
} from "@shared/lib/safety-map-artifacts";
import {
  SAFETY_MAP_LATEST_CACHE_CONTROL,
  getSafetyMapReadMethod,
  readSafetyMapKv,
  safetyMapTextError,
  withoutSafetyMapBody,
  type SafetyMapContext,
} from "../lib/safety-map";

const MOBILE_WIDTH_PARAM = String(SAFETY_MAP_TEASER_MOBILE_WIDTH);

/**
 * The daily publisher's WebP teasers; the full PNG stays on map.png.
 * Supports `?w=400` for the 400×225 mobile teaser, gracefully falling back to
 * `safety-map:latest.webp` until the first refresh populates the mobile key.
 */
export const onRequest = async ({ request, env }: SafetyMapContext): Promise<Response> => {
  const method = getSafetyMapReadMethod(request);
  if (method === null) {
    return safetyMapTextError(405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  const respond = (response: Response): Response => method === "HEAD" ? withoutSafetyMapBody(response) : response;
  const width = new URL(request.url).searchParams.get("w");
  if (width !== null && width !== MOBILE_WIDTH_PARAM) {
    return respond(safetyMapTextError(400, `Invalid width; expected ${MOBILE_WIDTH_PARAM}`));
  }
  if (!env.SELECTOR_SNAPSHOTS) {
    return respond(safetyMapTextError(404, "Safety map is not available"));
  }

  let bytes: ArrayBuffer | null = null;
  if (width === MOBILE_WIDTH_PARAM) {
    const mobileResult = await readSafetyMapKv(() =>
      env.SELECTOR_SNAPSHOTS!.get(SAFETY_MAP_TEASER_MOBILE_KEY, { type: "arrayBuffer" }),
    );
    if (!mobileResult.ok) {
      return respond(safetyMapTextError(503, "Safety map store temporarily unavailable"));
    }
    if (mobileResult.value !== null && mobileResult.value.byteLength > 0) {
      bytes = mobileResult.value;
    }
  }

  if (bytes === null) {
    const result = await readSafetyMapKv(() =>
      env.SELECTOR_SNAPSHOTS!.get(SAFETY_MAP_TEASER_KEY, { type: "arrayBuffer" }),
    );
    if (!result.ok) {
      return respond(safetyMapTextError(503, "Safety map store temporarily unavailable"));
    }
    if (result.value === null || result.value.byteLength === 0) {
      return respond(safetyMapTextError(404, "Safety map is not available"));
    }
    bytes = result.value;
  }

  return respond(new Response(bytes, {
    headers: {
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": SAFETY_MAP_LATEST_CACHE_CONTROL,
      "Content-Length": String(bytes.byteLength),
    },
  }));
};
