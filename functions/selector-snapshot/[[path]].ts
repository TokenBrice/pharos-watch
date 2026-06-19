import type { KVNamespace } from "@cloudflare/workers-types";
import {
  SELECTOR_SNAPSHOT_MAX_PAYLOAD_BYTES,
  SELECTOR_SNAPSHOT_TTL_SECONDS,
  SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS,
  computeSelectorSnapshotSid,
  isSelectorSnapshotSid,
  validateSelectorSnapshot,
} from "@shared/lib/selector/snapshot";
import { NOINDEX_HEADER_VALUE } from "../lib/noindex";
import { jsonError } from "../lib/proxy-utils";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";

/**
 * Pages Function: `/selector-snapshot/*`
 *
 * - `POST /selector-snapshot` stores a SelectorOutput JSON under a content-addressed sid.
 * - `GET /selector-snapshot/:sid` returns the frozen SelectorOutput or 404.
 *
 * The shared selector snapshot module owns the replay contract, validation,
 * canonicalization, and sid computation. This function owns only origin/method
 * gates, body handling, KV persistence, and HTTP responses.
 */

const STANDARD_RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": NOINDEX_HEADER_VALUE,
} as const;
const SNAPSHOT_BODY_ENCODER = new TextEncoder();

/**
 * Per-isolate hashed-IP sliding-window limiter for unauthenticated POSTs.
 * The origin gate is spoofable and the zone WAF rate limits only cover
 * `api.pharos.watch/api/*`, so this path needs its own write throttle.
 * Isolate-local state is best-effort (resets on isolate recycle, not shared
 * across colos) but bounds the realistic single-source write-spam case.
 * Legitimate use is 1-2 snapshot creations per session.
 * Accepted residual risk and KV cost ceiling: see functions/AGENTS.md (S-062).
 */
const POST_RATE_LIMIT_WINDOW_MS = 60_000;
const POST_RATE_LIMIT_MAX_PER_WINDOW = 10;
const POST_RATE_LIMIT_MAX_TRACKED_IPS = 5_000;
const postTimestampsByIpHash = new Map<string, number[]>();

async function hashClientIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", SNAPSHOT_BODY_ENCODER.encode(ip));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function isPostRateLimited(request: Request): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return false;

  const key = await hashClientIp(ip);
  const now = Date.now();
  const cutoff = now - POST_RATE_LIMIT_WINDOW_MS;
  const recent = (postTimestampsByIpHash.get(key) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= POST_RATE_LIMIT_MAX_PER_WINDOW) {
    postTimestampsByIpHash.set(key, recent);
    return true;
  }

  recent.push(now);
  if (!postTimestampsByIpHash.has(key) && postTimestampsByIpHash.size >= POST_RATE_LIMIT_MAX_TRACKED_IPS) {
    const oldest = postTimestampsByIpHash.keys().next().value;
    if (oldest !== undefined) postTimestampsByIpHash.delete(oldest);
  }
  postTimestampsByIpHash.set(key, recent);
  return false;
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
  return isSelectorSnapshotSid(candidate) ? candidate : null;
}

function hasSnapshotSegments(params: SelectorSnapshotContext["params"]): boolean {
  const raw = params.path;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") return raw.length > 0;
  return raw.length > 0;
}

function oversizedContentLength(request: Request): boolean {
  const contentLengthHeader = request.headers.get("Content-Length");
  if (!contentLengthHeader) return false;
  const parsed = Number(contentLengthHeader);
  return Number.isFinite(parsed) && parsed > SELECTOR_SNAPSHOT_MAX_PAYLOAD_BYTES;
}

async function readSnapshotBody(request: Request): Promise<string | Response> {
  if (oversizedContentLength(request)) {
    return jsonError(413, "Payload too large");
  }

  try {
    const raw = await request.text();
    if (SNAPSHOT_BODY_ENCODER.encode(raw).byteLength > SELECTOR_SNAPSHOT_MAX_PAYLOAD_BYTES) {
      return jsonError(413, "Payload too large");
    }
    return raw;
  } catch {
    return jsonError(400, "Could not read request body");
  }
}

function responseForValidationFailure(error: "unsafe" | "shape"): Response {
  if (error === "unsafe") {
    return jsonError(400, "Payload nesting or reserved keys not permitted");
  }
  return jsonError(400, "Invalid selector output shape");
}

async function handlePost(context: SelectorSnapshotContext): Promise<Response> {
  const { request, env } = context;

  if (!env.SELECTOR_SNAPSHOTS) {
    return jsonError(500, "Selector snapshot store is not configured");
  }

  if (await isPostRateLimited(request)) {
    return jsonError(429, "Too many snapshot writes; retry later", { "Retry-After": "60" });
  }

  const raw = await readSnapshotBody(request);
  if (raw instanceof Response) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonError(400, "Invalid JSON payload");
  }

  const validation = validateSelectorSnapshot(parsed);
  if (!validation.ok) {
    return responseForValidationFailure(validation.error);
  }

  const sid = computeSelectorSnapshotSid(validation.snapshot);
  const kvKey = `s:${sid}`;

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
    // Unread snapshots expire on the short TTL; the first successful read
    // extends them to the full retention TTL (see handleGet).
    await env.SELECTOR_SNAPSHOTS.put(kvKey, JSON.stringify(validation.snapshot), {
      expirationTtl: SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS,
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

  const kvKey = `s:${sid}`;
  let stored: string | null;
  let retentionExtended = false;
  try {
    const result = await env.SELECTOR_SNAPSHOTS.getWithMetadata<{ extended?: boolean }>(kvKey, "text");
    stored = result.value;
    retentionExtended = result.metadata?.extended === true;
  } catch (error) {
    console.warn("[selector-snapshot] KV read failure", error);
    return jsonError(503, "Snapshot store temporarily unavailable");
  }
  if (stored === null || stored === "") {
    return jsonError(404, "Snapshot not found");
  }

  let responseBody = stored;
  let normalizedStored = stored;
  try {
    const decoded = JSON.parse(stored) as unknown;
    const validation = validateSelectorSnapshot(decoded);
    if (!validation.ok) {
      console.warn("[selector-snapshot] stored payload failed shape check", { sid });
      return jsonError(502, "Snapshot value is malformed");
    }

    const storedSid = computeSelectorSnapshotSid(validation.snapshot);
    if (storedSid !== sid) {
      console.warn("[selector-snapshot] stored payload sid mismatch", {
        requestedSid: sid,
        storedSid,
      });
      return jsonError(502, "Snapshot value is malformed");
    }

    normalizedStored = JSON.stringify(validation.snapshot);
    responseBody = normalizedStored;
  } catch (error) {
    console.warn("[selector-snapshot] stored payload decode failure", error);
    return jsonError(502, "Snapshot value is malformed");
  }

  if (!retentionExtended) {
    // First successful read: extend the unread TTL to the full retention TTL.
    // Re-put the normalized replay snapshot so legacy debug/prose fields are
    // removed while preserving the content-addressed sid contract.
    const extension = env.SELECTOR_SNAPSHOTS.put(kvKey, normalizedStored, {
      expirationTtl: SELECTOR_SNAPSHOT_TTL_SECONDS,
      metadata: { extended: true },
    }).catch((error) => {
      console.warn("[selector-snapshot] retention extension failure", error);
    });
    if (context.waitUntil) {
      context.waitUntil(extension);
    } else {
      await extension;
    }
  }

  return new Response(responseBody, {
    status: 200,
    headers: {
      ...STANDARD_RESPONSE_HEADERS,
      "Cache-Control": "private, no-store",
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
