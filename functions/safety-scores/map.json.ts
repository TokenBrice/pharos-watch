import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * Public readiness metadata for the daily Safety Score map. The digest reads
 * this commit marker before it references the dated image; the image itself
 * remains on the separate PNG route.
 */

const MANIFEST_KEY = "safety-map:latest.json";
const MANIFEST_MAX_BYTES = 16_384;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
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

function jsonResponse(status: number, body: unknown, method: string, headers?: HeadersInit): Response {
  return new Response(method === "HEAD" ? null : `${JSON.stringify(body)}\n`, {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export const onRequest = async ({ request, env }: SafetyMapContext): Promise<Response> => {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return jsonResponse(405, { error: "Method not allowed" }, method, { Allow: "GET, HEAD" });
  }
  if (!env.SELECTOR_SNAPSHOTS) {
    return jsonResponse(404, { error: "Safety map is not available" }, method);
  }

  let raw: string | null;
  try {
    raw = await env.SELECTOR_SNAPSHOTS.get(MANIFEST_KEY, "text");
  } catch (error) {
    console.warn("[safety-map] KV manifest read failure", error);
    return jsonResponse(503, { error: "Safety map store temporarily unavailable" }, method);
  }
  if (!raw) return jsonResponse(404, { error: "Safety map is not available" }, method);
  if (new TextEncoder().encode(raw).byteLength > MANIFEST_MAX_BYTES) {
    console.warn("[safety-map] Manifest exceeds the bounded public response size");
    return jsonResponse(503, { error: "Safety map manifest is invalid" }, method);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    console.warn("[safety-map] Manifest is not valid JSON");
    return jsonResponse(503, { error: "Safety map manifest is invalid" }, method);
  }

  return jsonResponse(200, manifest, method);
};
