import { errorResponse } from "./api-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";

interface IdempotencyRecord {
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: number;
}

const PENDING_RESPONSE_STATUS = -1;

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getIdempotencyKey(request: Request | undefined): string | null {
  const raw = request?.headers.get("Idempotency-Key");
  if (!raw) return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > 128) return null;
  return key;
}

function withIdempotencyHeaders(response: Response, key: string, replayed: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("Idempotency-Key", key);
  headers.set("X-Idempotent-Replay", replayed ? "true" : "false");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function requestFingerprint(request: Request): Promise<string> {
  const clone = request.clone();
  const body = await clone.text().catch(() => "");
  const url = new URL(request.url);
  const sortedSearchParams = new URLSearchParams(url.searchParams);
  sortedSearchParams.sort();
  const canonical = `${request.method}\n${url.pathname}\n${sortedSearchParams.toString()}\n${body}`;
  return sha256Hex(canonical);
}

export async function runIdempotentAdminAction(
  db: D1Database,
  action: string,
  request: Request | undefined,
  execute: () => Promise<Response>,
): Promise<Response> {
  const key = getIdempotencyKey(request);
  if (!key || !request) {
    return execute();
  }

  const fingerprint = await requestFingerprint(request);
  const now = Math.floor(Date.now() / 1000);
  const reserveResult = await db
    .prepare(
      "INSERT OR IGNORE INTO admin_idempotency_keys (action, idempotency_key, request_hash, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(action, key, fingerprint, PENDING_RESPONSE_STATUS, "", now)
    .run();
  const insertedReservation = (reserveResult.meta?.changes ?? 0) > 0;

  const existing = await db
    .prepare(
      "SELECT request_hash, response_status, response_body, created_at FROM admin_idempotency_keys WHERE action = ? AND idempotency_key = ?",
    )
    .bind(action, key)
    .first<IdempotencyRecord>();

  if (!existing) {
    return errorResponse(500, "Failed to reserve idempotency key");
  }

  if (existing.request_hash !== fingerprint) {
    if (insertedReservation) {
      await db
        .prepare("DELETE FROM admin_idempotency_keys WHERE action = ? AND idempotency_key = ? AND response_status = ?")
        .bind(action, key, PENDING_RESPONSE_STATUS)
        .run()
        .catch((e) => { console.warn("[idempotency] cleanup after key-reuse failed:", e); });
    }
    return errorResponse(409, "Idempotency key reuse with different request payload");
  }

  if (existing.response_status === PENDING_RESPONSE_STATUS && !insertedReservation) {
    return withIdempotencyHeaders(
      errorResponse(409, "Idempotency key is currently in progress"),
      key,
      true,
    );
  }

  if (existing.response_status !== PENDING_RESPONSE_STATUS) {
    return withIdempotencyHeaders(
      new Response(existing.response_body, {
        status: existing.response_status,
        headers: { "Content-Type": "application/json" },
      }),
      key,
      true,
    );
  }

  let response: Response;
  try {
    response = await execute();
  } catch (err) {
    await db
      .prepare(
        "DELETE FROM admin_idempotency_keys WHERE action = ? AND idempotency_key = ? AND request_hash = ? AND response_status = ?",
      )
      .bind(action, key, fingerprint, PENDING_RESPONSE_STATUS)
      .run()
      .catch((e) => { console.warn("[idempotency] cleanup after execution error failed — key may be stuck in PENDING:", e); });
    throw err;
  }
  const responseBody = await response.clone().text();

  await db
    .prepare(
      "UPDATE admin_idempotency_keys SET response_status = ?, response_body = ?, created_at = ? WHERE action = ? AND idempotency_key = ? AND request_hash = ?",
    )
    .bind(response.status, responseBody, now, action, key, fingerprint)
    .run();

  // Keep table bounded.
  await db
    .prepare("DELETE FROM admin_idempotency_keys WHERE created_at < ?")
    .bind(now - 7 * DAY_SECONDS)
    .run()
    .catch((e) => { console.warn("[idempotency] TTL prune failed:", e); });

  return withIdempotencyHeaders(response, key, false);
}
