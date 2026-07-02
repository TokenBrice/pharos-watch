import { errorResponse, withResponseHeaders } from "./api-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { sha256Hex } from "./hash";
import { logWorkerEvent } from "./structured-log";

interface IdempotencyRecord {
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: number;
}

const PENDING_RESPONSE_STATUS = -1;
const FAILED_RESPONSE_STATUS = -2;
const FAILED_RESPONSE_HTTP_STATUS = 500;
const PENDING_TAKEOVER_AFTER_SECONDS = 20 * 60;
const FAILED_RESPONSE_MESSAGE =
  "Previous idempotent attempt failed before cleanup could be confirmed. Retry with a new Idempotency-Key.";

function getIdempotencyKey(request: Request | undefined): string | null {
  const raw = request?.headers.get("Idempotency-Key");
  if (!raw) return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > 128) return null;
  return key;
}

function withIdempotencyHeaders(response: Response, key: string, replayed: boolean): Response {
  return withResponseHeaders(response, {
    "Idempotency-Key": key,
    "X-Idempotent-Replay": replayed ? "true" : "false",
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

async function loadIdempotencyRecord(db: D1Database, action: string, key: string): Promise<IdempotencyRecord | null> {
  return db
    .prepare(
      "SELECT request_hash, response_status, response_body, created_at FROM admin_idempotency_keys WHERE action = ? AND idempotency_key = ?",
    )
    .bind(action, key)
    .first<IdempotencyRecord>();
}

async function takeOverAbandonedPendingReservation(
  db: D1Database,
  action: string,
  key: string,
  fingerprint: string,
  now: number,
): Promise<boolean> {
  const cutoff = now - PENDING_TAKEOVER_AFTER_SECONDS;

  try {
    const takeoverResult = await db
      .prepare(
        "UPDATE admin_idempotency_keys SET request_hash = ?, response_status = ?, response_body = ?, created_at = ? WHERE action = ? AND idempotency_key = ? AND response_status = ? AND created_at < ?",
      )
      .bind(fingerprint, PENDING_RESPONSE_STATUS, "", now, action, key, PENDING_RESPONSE_STATUS, cutoff)
      .run();

    return (takeoverResult.meta?.changes ?? 0) > 0;
  } catch (e) {
    logWorkerEvent({
      scope: "admin",
      level: "warn",
      event: "idempotency_pending_takeover_failed",
      route: action,
      source: "admin_idempotency_keys",
      message: "Idempotency pending reservation takeover failed",
      error: e,
    });
    return false;
  }
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

  let ownsReservation = insertedReservation;
  if (existing.response_status === PENDING_RESPONSE_STATUS && !ownsReservation) {
    ownsReservation = await takeOverAbandonedPendingReservation(db, action, key, fingerprint, now);
    if (ownsReservation) {
      existing.request_hash = fingerprint;
      existing.response_body = "";
      existing.created_at = now;
    }
  }

  if (existing.request_hash !== fingerprint) {
    if (insertedReservation) {
      await db
        .prepare("DELETE FROM admin_idempotency_keys WHERE action = ? AND idempotency_key = ? AND response_status = ?")
        .bind(action, key, PENDING_RESPONSE_STATUS)
        .run()
        .catch((e) => {
          logWorkerEvent({
            scope: "admin",
            level: "warn",
            event: "idempotency_key_reuse_cleanup_failed",
            route: action,
            source: "admin_idempotency_keys",
            message: "Idempotency cleanup after key reuse failed",
            error: e,
          });
        });
    }
    return errorResponse(409, "Idempotency key reuse with different request payload");
  }

  if (existing.response_status === PENDING_RESPONSE_STATUS && !ownsReservation) {
    return withIdempotencyHeaders(errorResponse(409, "Idempotency key is currently in progress"), key, true);
  }

  if (existing.response_status === FAILED_RESPONSE_STATUS) {
    return withIdempotencyHeaders(buildStoredFailureResponse(existing.response_body), key, true);
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
      logWorkerEvent({
        scope: "admin",
        level: "warn",
        event: "idempotency_execution_cleanup_failed",
        route: action,
        source: "admin_idempotency_keys",
        message: "Idempotency cleanup after execution error failed; attempting terminal failure replay",
        error: cleanupError,
      });
    }

    if (pendingReservationCleared) {
      throw err;
    }

    const remaining = await loadIdempotencyRecord(db, action, key).catch((loadError) => {
      logWorkerEvent({
        scope: "admin",
        level: "error",
        event: "idempotency_reservation_reload_failed",
        route: action,
        source: "admin_idempotency_keys",
        message: "Failed to reload idempotency reservation after execution error",
        error: loadError,
      });
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
      logWorkerEvent({
        scope: "admin",
        level: "error",
        event: "idempotency_terminal_failure_replay_persist_failed",
        route: action,
        source: "admin_idempotency_keys",
        message: "Failed to persist terminal failure replay after execution error",
        error: failureUpdateError,
      });
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
      logWorkerEvent({
        scope: "admin",
        level: "error",
        event: "idempotency_final_cleanup_failed",
        route: action,
        source: "admin_idempotency_keys",
        message: "Final idempotency cleanup after execution error failed",
        error: finalCleanupError,
      });
    }

    logWorkerEvent({
      scope: "admin",
      level: "error",
      event: "idempotency_reservation_state_unconfirmed",
      route: action,
      source: "admin_idempotency_keys",
      message: "Idempotency reservation state after execution error could not be confirmed; propagating original error",
    });
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
    .catch((e) => {
      logWorkerEvent({
        scope: "admin",
        level: "warn",
        event: "idempotency_ttl_prune_failed",
        route: action,
        source: "admin_idempotency_keys",
        message: "Idempotency TTL prune failed",
        error: e,
      });
    });

  return withIdempotencyHeaders(response, key, false);
}
