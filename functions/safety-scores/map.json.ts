import {
  SAFETY_MAP_MANIFEST_KEY,
  SAFETY_MAP_MANIFEST_MAX_BYTES,
  getSafetyMapReadMethod,
  readSafetyMapKv,
  safetyMapJsonResponse,
  type SafetyMapContext,
} from "../lib/safety-map";

/**
 * Public readiness metadata for the daily Safety Score map. The digest reads
 * this commit marker before it references the dated image; the image itself
 * remains on the separate PNG route.
 */

export const onRequest = async ({ request, env }: SafetyMapContext): Promise<Response> => {
  const method = getSafetyMapReadMethod(request);
  if (method === null) {
    return safetyMapJsonResponse(405, { error: "Method not allowed" }, "GET", { Allow: "GET, HEAD" });
  }
  if (!env.SELECTOR_SNAPSHOTS) {
    return safetyMapJsonResponse(404, { error: "Safety map is not available" }, method);
  }

  const result = await readSafetyMapKv(() =>
    env.SELECTOR_SNAPSHOTS!.get(SAFETY_MAP_MANIFEST_KEY, "text"),
  );
  if (!result.ok) {
    return safetyMapJsonResponse(503, { error: "Safety map store temporarily unavailable" }, method);
  }
  if (!result.value) return safetyMapJsonResponse(404, { error: "Safety map is not available" }, method);
  if (new TextEncoder().encode(result.value).byteLength > SAFETY_MAP_MANIFEST_MAX_BYTES) {
    console.warn("[safety-map] Manifest exceeds the bounded public response size");
    return safetyMapJsonResponse(503, { error: "Safety map manifest is invalid" }, method);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(result.value);
  } catch {
    console.warn("[safety-map] Manifest is not valid JSON");
    return safetyMapJsonResponse(503, { error: "Safety map manifest is invalid" }, method);
  }

  return safetyMapJsonResponse(200, manifest, method);
};
