import { errorResponse } from "./api-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";

interface IdempotencyRecord {
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: number;
}

const PENDING_RESPONSE_STATUS = -1;
const FAILED_RESPONSE_STATUS = -2;
const FAILED_RESPONSE_HTTP_STATUS = 500;
const FAILED_RESPONSE_MESSAGE = "Previous idempotent attempt failed before cleanup could be confirmed. Retry with a new Idempotency-Key.";

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

function buildStoredFailureBody(): string {
  return JSON.stringify({ error: FAILED_RESPONSE_MESSAGE });
}

function buildStoredFailureResponse(body = buildStoredFailureBody()): Response {
  return new Response(body, {
    status: FAILED_RESPONSE_HTTP_STATUS,
    headers: { "Content-Type": "application/json" },
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

async function loadIdempotencyRecord(
  db: D1Database,
  action: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  return db
    .prepare(
      "SELECT request_hash, response_status, response_body, created_at FROM admin_idempotency_keys WHERE action = ? AND idempotency_key = ?",
    )
    .bind(action, key)
    .first<IdempotencyRecord>();
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

  const existing = await loadIdempotencyRecord(db, action, key);

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

  if (existing.response_status === FAILED_RESPONSE_STATUS) {
    return withIdempotencyHeaders(
      buildStoredFailureResponse(existing.response_body),
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
    let pendingReservationCleared = false;

    try {
      const cleanupResult = await db
        .prepare(
          "DELETE FROM admin_idempotency_keys WHERE action = ? AND idempotency_key = ? AND request_hash = ? AND response_status = ?",
        )
        .bind(action, key, fingerprint, PENDING_RESPONSE_STATUS)
        .run();
      pendingReservationCleared = (cleanupResult.meta?.changes ?? 0) > 0;
    } catch (cleanupError) {
      console.warn("[idempotency] cleanup after execution error failed; attempting terminal failure replay:", cleanupError);
    }

    if (pendingReservationCleared) {
      throw err;
    }

    const remaining = await loadIdempotencyRecord(db, action, key).catch((loadError) => {
      console.error("[idempotency] failed to reload reservation after execution error:", loadError);
      return null;
    });

    if (!remaining || remaining.response_status !== PENDING_RESPONSE_STATUS) {
      throw err;
    }

    const failureBody = buildStoredFailureBody();

    try {
      const failureUpdate = await db
        .prepare(
          "UPDATE admin_idempotency_keys SET response_status = ?, response_body = ?, created_at = ? WHERE action = ? AND idempotency_key = ? AND request_hash = ? AND response_status = ?",
        )
        .bind(FAILED_RESPONSE_STATUS, failureBody, now, action, key, fingerprint, PENDING_RESPONSE_STATUS)
        .run();

      if ((failureUpdate.meta?.changes ?? 0) > 0) {
        return withIdempotencyHeaders(buildStoredFailureResponse(failureBody), key, false);
      }
    } catch (failureUpdateError) {
      console.error("[idempotency] failed to persist terminal failure replay after execution error:", failureUpdateError);
    }

    try {
      const finalCleanup = await db
        .prepare("DELETE FROM admin_idempotency_keys WHERE action = ? AND idempotency_key = ? AND request_hash = ?")
        .bind(action, key, fingerprint)
        .run();

      if ((finalCleanup.meta?.changes ?? 0) > 0) {
        throw err;
      }
    } catch (finalCleanupError) {
      console.error("[idempotency] final cleanup after execution error failed:", finalCleanupError);
    }

    console.error("[idempotency] reservation state after execution error could not be confirmed; propagating original error");
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
