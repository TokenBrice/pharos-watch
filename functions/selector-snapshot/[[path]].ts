import type { D1Database, KVNamespace } from "@shared/types/cloudflare-runtime";
import {
  SELECTOR_SNAPSHOT_MAX_PAYLOAD_BYTES,
  SELECTOR_SNAPSHOT_TTL_SECONDS,
  SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS,
  computeSelectorSnapshotSid,
  isSelectorSnapshotSid,
  validateSelectorSnapshot,
  validateSelectorSnapshotInput,
  validateVerifiedSelectorSnapshot,
} from "@shared/lib/selector/snapshot";
import { SELECTOR_SNAPSHOT_VERIFICATION_KIND } from "@shared/lib/selector/types";
import { readBoundedRequestBody } from "../lib/bounded-request-body";
import { hashClientIp } from "../lib/client-ip-hash";
import { NOINDEX_HEADER_VALUE } from "../lib/noindex";
import { jsonError } from "../lib/proxy-utils";
import { recomputeVerifiedSelectorSnapshot } from "../lib/selector-canonical-snapshot";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";

/**
 * Pages Function: `/selector-snapshot/*`
 *
 * - `POST /selector-snapshot` recomputes SelectorOutput from canonical sources.
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
const SNAPSHOT_BODY_DECODER = new TextDecoder("utf-8", { fatal: true });

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: STANDARD_RESPONSE_HEADERS,
  });
}

/**
 * Per-isolate hashed-IP sliding-window limiter for unauthenticated POSTs.
 * The origin gate is spoofable and the zone WAF rate limits only cover
 * `api.pharos.watch/api/*`, so this path needs its own write throttle.
 * Isolate-local state is best-effort (resets on isolate recycle, not shared
 * across colos) but bounds the realistic single-source write-spam case.
 * Legitimate use is 1-2 snapshot creations per session.
 * The durable daily quota uses D1 conditional upsert semantics because KV
 * read-modify-write counters are not atomic across isolates/colos.
 * Accepted residual risk and KV cost ceiling: see docs/screener-picker-page.md.
 */
const POST_RATE_LIMIT_WINDOW_MS = 60_000;
const POST_RATE_LIMIT_MAX_PER_WINDOW = 10;
const POST_RATE_LIMIT_MAX_TRACKED_IPS = 5_000;
const POST_DAILY_QUOTA_MAX_PER_IP = 100;
const postTimestampsByIpHash = new Map<string, number[]>();

async function getClientIpHash(request: Request, env: SelectorSnapshotEnv): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return null;
  const secret = env.SELECTOR_SNAPSHOT_IP_HASH_SECRET?.trim();
  if (!secret) return null;
  return hashClientIp(ip, secret);
}

function dailyQuotaDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function isPostRateLimited(request: Request, env: SelectorSnapshotEnv): Promise<boolean> {
  const key = await getClientIpHash(request, env);
  if (!key) return false;
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

async function consumeDailyPostQuota(env: SelectorSnapshotEnv, request: Request): Promise<Response | null> {
  const ipHash = await getClientIpHash(request, env);
  if (!ipHash) return null;
  if (!env.DB) return jsonError(503, "Snapshot quota store is not configured");

  const bucketDate = dailyQuotaDate();
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    const result = await env.DB.prepare(
      `INSERT INTO selector_snapshot_daily_quota (
         quota_date,
         ip_hash,
         count,
         first_seen_at,
         last_seen_at
       )
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(quota_date, ip_hash) DO UPDATE SET
         count = count + 1,
         last_seen_at = excluded.last_seen_at
       WHERE selector_snapshot_daily_quota.count < ?`,
    )
      .bind(bucketDate, ipHash, nowSec, nowSec, POST_DAILY_QUOTA_MAX_PER_IP)
      .run();

    if ((result.meta?.changes ?? 0) === 0) {
      return jsonError(429, "Daily snapshot write quota exceeded", { "Retry-After": "86400" });
    }
  } catch (error) {
    console.warn("[selector-snapshot] quota write failure", error);
    return jsonError(503, "Snapshot quota store temporarily unavailable");
  }

  return null;
}

interface SelectorSnapshotEnv {
  SELECTOR_SNAPSHOTS?: KVNamespace;
  DB?: D1Database;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
  SITE_API_ORIGIN?: string;
  SITE_API_SHARED_SECRET?: string;
  SELECTOR_SNAPSHOT_IP_HASH_SECRET?: string;
}

interface SelectorSnapshotKvMetadata {
  extended?: boolean;
  legacySid?: string;
  trust?: typeof SELECTOR_SNAPSHOT_VERIFICATION_KIND;
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

async function readSnapshotBody(request: Request): Promise<string | Response> {
  const result = await readBoundedRequestBody(request, SELECTOR_SNAPSHOT_MAX_PAYLOAD_BYTES);
  if (result.status === "too-large") {
    return jsonError(413, "Payload too large");
  }
  if (result.status === "unreadable") {
    return jsonError(400, "Could not read request body");
  }
  try {
    return SNAPSHOT_BODY_DECODER.decode(result.bytes);
  } catch {
    return jsonError(400, "Could not read request body");
  }
}

function responseForValidationFailure(error: "unsafe" | "shape"): Response {
  if (error === "unsafe") {
    return jsonError(400, "Payload nesting or reserved keys not permitted");
  }
  return jsonError(400, "Invalid selector input shape");
}

async function handlePost(context: SelectorSnapshotContext): Promise<Response> {
  const { request, env } = context;

  if (!env.SELECTOR_SNAPSHOTS) {
    return jsonError(500, "Selector snapshot store is not configured");
  }

  if (!env.SELECTOR_SNAPSHOT_IP_HASH_SECRET?.trim()) {
    return jsonError(500, "Snapshot write limiter is not configured");
  }

  if (await isPostRateLimited(request, env)) {
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

  const inputValidation = validateSelectorSnapshotInput(parsed);
  if (!inputValidation.ok) {
    return responseForValidationFailure(inputValidation.error);
  }

  const quotaRejected = await consumeDailyPostQuota(env, request);
  if (quotaRejected) return quotaRejected;

  let snapshot: Awaited<ReturnType<typeof recomputeVerifiedSelectorSnapshot>>;
  try {
    snapshot = await recomputeVerifiedSelectorSnapshot(inputValidation.input, request, env);
  } catch (error) {
    console.warn("[selector-snapshot] canonical recomputation failure", error);
    return jsonError(503, "Canonical selector data temporarily unavailable");
  }

  const sid = computeSelectorSnapshotSid(snapshot);
  const kvKey = `s:${sid}`;

  try {
    const existing = await env.SELECTOR_SNAPSHOTS.getWithMetadata<SelectorSnapshotKvMetadata>(kvKey, "text");
    if (
      existing.value !== null &&
      existing.value !== "" &&
      existing.metadata?.trust === SELECTOR_SNAPSHOT_VERIFICATION_KIND
    ) {
      const validation = validateVerifiedSelectorSnapshot(JSON.parse(existing.value) as unknown);
      if (validation.ok && computeSelectorSnapshotSid(validation.snapshot) === sid) {
        return jsonOk({ sid, ev: SELECTOR_SNAPSHOT_VERIFICATION_KIND });
      }
    }
  } catch {
    // Treat malformed values or read failures as best-effort; overwrite with
    // the freshly recomputed, trusted snapshot below.
  }

  try {
    // Unread snapshots expire on the short TTL; the first successful read
    // extends them to the full retention TTL (see handleGet).
    await env.SELECTOR_SNAPSHOTS.put(kvKey, JSON.stringify(snapshot), {
      expirationTtl: SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS,
      metadata: { trust: SELECTOR_SNAPSHOT_VERIFICATION_KIND },
    });
  } catch (error) {
    console.warn("[selector-snapshot] KV write failure", error);
    return jsonError(503, "Snapshot store temporarily unavailable");
  }

  return jsonOk({ sid, ev: SELECTOR_SNAPSHOT_VERIFICATION_KIND });
}

async function handleGet(context: SelectorSnapshotContext, sid: string): Promise<Response> {
  const { env } = context;
  if (!env.SELECTOR_SNAPSHOTS) {
    return jsonError(500, "Selector snapshot store is not configured");
  }

  const kvKey = `s:${sid}`;
  let stored: string | null;
  let retentionExtended = false;
  let recordedLegacySid: string | undefined;
  let trust: SelectorSnapshotKvMetadata["trust"];
  let normalizedSid = sid;
  try {
    const result = await env.SELECTOR_SNAPSHOTS.getWithMetadata<SelectorSnapshotKvMetadata>(kvKey, "text");
    stored = result.value;
    retentionExtended = result.metadata?.extended === true;
    recordedLegacySid = result.metadata?.legacySid;
    trust = result.metadata?.trust;
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
    const validation =
      trust === SELECTOR_SNAPSHOT_VERIFICATION_KIND
        ? validateVerifiedSelectorSnapshot(decoded)
        : validateSelectorSnapshot(decoded);
    if (!validation.ok) {
      console.warn("[selector-snapshot] stored payload failed shape check", { sid });
      return jsonError(502, "Snapshot value is malformed");
    }

    const storedSid = computeSelectorSnapshotSid(validation.snapshot);
    normalizedSid = storedSid;
    const legacyStoredSid = trust === SELECTOR_SNAPSHOT_VERIFICATION_KIND ? null : computeSelectorSnapshotSid(decoded);
    const isRecognizedLegacySnapshot = recordedLegacySid === sid || legacyStoredSid === sid;
    if (storedSid !== sid && !isRecognizedLegacySnapshot) {
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
    try {
      await env.SELECTOR_SNAPSHOTS.put(kvKey, normalizedStored, {
        expirationTtl: SELECTOR_SNAPSHOT_TTL_SECONDS,
        metadata: {
          extended: true,
          ...(trust ? { trust } : {}),
          ...(normalizedSid === sid ? {} : { legacySid: sid }),
        },
      });
    } catch (error) {
      console.warn("[selector-snapshot] retention extension failure", error);
      return jsonError(503, "Snapshot retention could not be extended");
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
