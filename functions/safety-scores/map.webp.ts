import {
  SAFETY_MAP_LATEST_CACHE_CONTROL,
  SAFETY_MAP_TEASER_KEY,
  getSafetyMapReadMethod,
  readSafetyMapKv,
  safetyMapTextError,
  withoutSafetyMapBody,
  type SafetyMapContext,
} from "../lib/safety-map";

/** The daily publisher's 800×450 WebP teaser; the full PNG stays on map.png. */
export const onRequest = async ({ request, env }: SafetyMapContext): Promise<Response> => {
  const method = getSafetyMapReadMethod(request);
  if (method === null) {
    return safetyMapTextError(405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  const respond = (response: Response): Response => method === "HEAD" ? withoutSafetyMapBody(response) : response;
  if (!env.SELECTOR_SNAPSHOTS) {
    return respond(safetyMapTextError(404, "Safety map is not available"));
  }
  const result = await readSafetyMapKv(() =>
    env.SELECTOR_SNAPSHOTS!.get(SAFETY_MAP_TEASER_KEY, { type: "arrayBuffer" }),
  );
  if (!result.ok) {
    return respond(safetyMapTextError(503, "Safety map store temporarily unavailable"));
  }
  if (result.value === null || result.value.byteLength === 0) {
    return respond(safetyMapTextError(404, "Safety map is not available"));
  }
  return respond(new Response(result.value, {
    headers: {
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": SAFETY_MAP_LATEST_CACHE_CONTROL,
      "Content-Length": String(result.value.byteLength),
    },
  }));
};
