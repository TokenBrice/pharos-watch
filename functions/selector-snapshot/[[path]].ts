import type { KVNamespace } from "@cloudflare/workers-types";
import { canonicalizeForSid } from "@shared/lib/selector/canonicalize";
import { jsonError } from "../lib/proxy-utils";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";

/**
 * Pages Function: `/selector-snapshot/*`
 *
 * - `POST /selector-snapshot`  -> stores a SelectorOutput JSON under a content-addressed sid; returns `{ sid }`.
 * - `GET  /selector-snapshot/:sid` -> returns the previously stored SelectorOutput, or 404.
 *
 * Origin-gated via the existing same-origin allowlist; no write secret (R0 revision — browser CORS
 * blocks cross-origin POST, and origin gating is the sole write auth on top of that).
 *
 * `sid` is content-addressed: SHA-256 of the lexicographically-canonicalized JSON output with
 * freshness-derived fields stripped. The first 16 bytes (32 hex chars) are the sid. The function
 * recomputes the sid on every POST — clients cannot forge sid -> payload pairs.
 *
 * KV namespace: `SELECTOR_SNAPSHOTS` (declared in `shared/lib/env-contract/registry.ts`).
 * Retention: 5 years (`expirationTtl`).
 */

const SID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_PAYLOAD_BYTES = 100 * 1024;
const SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;
const MAX_JSON_DEPTH = 12;

/**
 * Defensive shared response headers for both POST (200) and GET (200) so the
 * snapshot endpoint cannot be mis-rendered, indexed, or pivoted off.
 */
const STANDARD_RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

/**
 * Defensive depth + prototype-pollution guard on parsed JSON. Cloudflare KV
 * tolerates arbitrary payloads; we keep the engine's invariants intact by
 * refusing pathological nesting and reserved keys before we hash or store.
 */
function isStructurallySafe(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) {
    return value.every((item) => isStructurallySafe(item, depth + 1));
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return false;
    }
    if (!isStructurallySafe((value as Record<string, unknown>)[key], depth + 1)) {
      return false;
    }
  }
  return true;
}

interface SelectorSnapshotEnv {
  SELECTOR_SNAPSHOTS?: KVNamespace;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
}

interface SelectorSnapshotContext {
  request: Request;
  env: SelectorSnapshotEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
  params: {
    path?: string | string[];
  };
}

function resolveSidFromParams(params: SelectorSnapshotContext["params"]): string | null {
  const raw = params.path;
  if (raw === undefined || raw === null) return null;
  const segments = Array.isArray(raw) ? raw : [raw];
  if (segments.length !== 1) return null;
  const candidate = (segments[0] ?? "").trim().toLowerCase();
  if (candidate.length === 0) return null;
  return SID_PATTERN.test(candidate) ? candidate : null;
}

function hasSnapshotSegments(params: SelectorSnapshotContext["params"]): boolean {
  const raw = params.path;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") return raw.length > 0;
  return raw.length > 0;
}

/**
 * Lightweight shape check on the incoming POST payload. The engine package owns full validation;
 * this proxy-thin function asserts only the top-level structure so that obvious garbage cannot
 * reach KV. Tamper evidence comes from the sid recomputation rather than schema enforcement.
 */
function isSelectorOutputShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.profile === "string"
    && typeof candidate.engineVersion === "string"
    && typeof candidate.datasetHash === "string"
    && typeof candidate.timestamp === "number"
    && Array.isArray(candidate.recommended)
    && Array.isArray(candidate.lowerRanked)
    && candidate.input !== null
    && typeof candidate.input === "object"
    && candidate.coverageWarnings !== null
    && typeof candidate.coverageWarnings === "object"
    && candidate.methodologyVersions !== null
    && typeof candidate.methodologyVersions === "object"
  );
}

/**
 * Snapshot id is computed via `canonicalizeForSid` from
 * `@shared/lib/selector/canonicalize` (engine-authoritative). Client and server
 * apply the same canonicalization rules so the recomputed sid matches.
 */
async function computeSid(canon: string): Promise<string> {
  const bytes = new TextEncoder().encode(canon);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 16; i += 1) {
    const byte = view[i];
    if (byte === undefined) break;
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function handlePost(context: SelectorSnapshotContext): Promise<Response> {
  const { request, env } = context;

  if (!env.SELECTOR_SNAPSHOTS) {
    return jsonError(500, "Selector snapshot store is not configured");
  }

  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader) {
    const parsed = Number(contentLengthHeader);
    if (Number.isFinite(parsed) && parsed > MAX_PAYLOAD_BYTES) {
      return jsonError(413, "Payload too large");
    }
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonError(400, "Could not read request body");
  }
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return jsonError(413, "Payload too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonError(400, "Invalid JSON payload");
  }
  if (!isSelectorOutputShape(parsed)) {
    return jsonError(400, "Invalid selector output shape");
  }
  if (!isStructurallySafe(parsed)) {
    return jsonError(400, "Payload nesting or reserved keys not permitted");
  }

  const canon = canonicalizeForSid(parsed);
  const sid = await computeSid(canon);
  const kvKey = `s:${sid}`;

  // Write-once idempotency (Security P1-5a): if the snapshot already exists,
  // skip the put. Same sid implies byte-identical canonicalized content, so a
  // republished payload that differs only on the (stripped) `timestamp` field
  // cannot mutate the stored value. This prevents the timestamp-spoof
  // overwrite attack where a client re-POSTs different *non-stripped* content
  // colliding under the same sid (impossible by canonicalization, defended
  // here for belt-and-suspenders).
  try {
    const existing = await env.SELECTOR_SNAPSHOTS.get(kvKey, "text");
    if (existing !== null && existing !== "") {
      return new Response(JSON.stringify({ sid }), {
        status: 200,
        headers: STANDARD_RESPONSE_HEADERS,
      });
    }
  } catch {
    // Treat read failure as best-effort; proceed to write.
  }

  try {
    await env.SELECTOR_SNAPSHOTS.put(kvKey, JSON.stringify(parsed), {
      expirationTtl: SNAPSHOT_TTL_SECONDS,
    });
  } catch (error) {
    console.warn("[selector-snapshot] KV write failure", error);
    return jsonError(503, "Snapshot store temporarily unavailable");
  }

  return new Response(JSON.stringify({ sid }), {
    status: 200,
    headers: STANDARD_RESPONSE_HEADERS,
  });
}

async function handleGet(context: SelectorSnapshotContext, sid: string): Promise<Response> {
  const { env } = context;
  if (!env.SELECTOR_SNAPSHOTS) {
    return jsonError(500, "Selector snapshot store is not configured");
  }

  let stored: string | null;
  try {
    stored = await env.SELECTOR_SNAPSHOTS.get(`s:${sid}`, "text");
  } catch (error) {
    console.warn("[selector-snapshot] KV read failure", error);
    return jsonError(503, "Snapshot store temporarily unavailable");
  }
  if (stored === null || stored === "") {
    return jsonError(404, "Snapshot not found");
  }

  // Defensive: confirm the stored payload still parses. Tamper-evidence (sid mismatch) is
  // already guaranteed at write time via server-side sid computation, but a corrupt KV value
  // should surface as a clean failure rather than a 200 with garbage.
  try {
    const decoded = JSON.parse(stored);
    if (!isSelectorOutputShape(decoded)) {
      console.warn("[selector-snapshot] stored payload failed shape check", { sid });
      return jsonError(502, "Snapshot value is malformed");
    }
  } catch {
    return jsonError(502, "Snapshot value is malformed");
  }

  return new Response(stored, {
    status: 200,
    headers: {
      ...STANDARD_RESPONSE_HEADERS,
      // GET is cache-friendly (snapshots are content-addressed; same sid →
      // same content). Drop `immutable` since Cloudflare's CDN respects
      // s-maxage just fine without it, and `immutable` plus shared caches
      // create awkward debugging when KV is purged.
      "Cache-Control": "public, max-age=300, s-maxage=86400",
    },
  });
}

export const onRequest = async (context: SelectorSnapshotContext): Promise<Response> => {
  const { request, env } = context;
  const rejected = rejectIfNotSiteDataUiOrigin(request, env, () => jsonError(404, "Not found"));
  if (rejected) {
    return rejected;
  }

  const method = request.method.toUpperCase();
  if (method === "POST") {
    if (hasSnapshotSegments(context.params)) {
      return jsonError(405, "Method not allowed", { Allow: "GET" });
    }
    return handlePost(context);
  }
  if (method === "GET") {
    const sid = resolveSidFromParams(context.params);
    if (!sid) return jsonError(404, "Not found");
    return handleGet(context, sid);
  }
  return jsonError(405, "Method not allowed", { Allow: "GET, POST" });
};
