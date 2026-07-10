import { DAY_SECONDS } from "@shared/lib/time-constants";
import { errorResponse, withResponseHeaders } from "./api-utils";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { sha256Hex } from "./hash";
import { logWorkerEvent } from "./structured-log";

interface IdempotencyRecord {
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: number;
  reservation_owner: string | null;
  reservation_generation: number;
  execution_started_at: number | null;
}

interface ReservationToken {
  owner: string;
  generation: number;
}

const PENDING_RESPONSE_STATUS = -1;
const EXECUTION_UNKNOWN_RESPONSE_STATUS = -2;
const EXECUTION_UNKNOWN_HTTP_STATUS = 503;
const PENDING_TAKEOVER_AFTER_SECONDS = 20 * 60;
const EXECUTION_UNKNOWN_MESSAGE =
  "The prior idempotent action started, but its terminal response is unconfirmed. Operator reconciliation is required before retrying.";

function createReservationOwner(action: string): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const suffix = cryptoObj?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `admin-idempotency:${action}:${suffix}`;
}

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

function buildExecutionUnknownBody(): string {
  return JSON.stringify({
    error: "execution_unknown",
    message: EXECUTION_UNKNOWN_MESSAGE,
  });
}

function buildExecutionUnknownResponse(body = buildExecutionUnknownBody()): Response {
  return new Response(body, {
    status: EXECUTION_UNKNOWN_HTTP_STATUS,
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
      `SELECT request_hash, response_status, response_body, created_at,
              reservation_owner, reservation_generation, execution_started_at
         FROM admin_idempotency_keys
        WHERE action = ? AND idempotency_key = ?`,
    )
    .bind(action, key)
    .first<IdempotencyRecord>();
}

async function takeOverAbandonedUnstartedReservation(
  db: D1Database,
  action: string,
  key: string,
  fingerprint: string,
  owner: string,
  existingGeneration: number,
  now: number,
): Promise<ReservationToken | null> {
  const cutoff = now - PENDING_TAKEOVER_AFTER_SECONDS;
  try {
    const takeoverResult = await db
      .prepare(
        `UPDATE admin_idempotency_keys
            SET reservation_owner = ?,
                reservation_generation = reservation_generation + 1,
                response_body = '',
                created_at = ?
          WHERE action = ?
            AND idempotency_key = ?
            AND request_hash = ?
            AND response_status = ?
            AND execution_started_at IS NULL
            AND reservation_generation = ?
            AND created_at < ?`,
      )
      .bind(
        owner,
        now,
        action,
        key,
        fingerprint,
        PENDING_RESPONSE_STATUS,
        existingGeneration,
        cutoff,
      )
      .run();
    return (takeoverResult.meta?.changes ?? 0) === 1
      ? { owner, generation: existingGeneration + 1 }
      : null;
  } catch (error) {
    logWorkerEvent({
      scope: "admin",
      level: "warn",
      event: "idempotency_unstarted_takeover_failed",
      route: action,
      source: "admin_idempotency_keys",
      message: "Idempotency reservation takeover failed",
      error,
    });
    return null;
  }
}

async function beginReservationExecution(
  db: D1Database,
  action: string,
  key: string,
  fingerprint: string,
  token: ReservationToken,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE admin_idempotency_keys
          SET execution_started_at = ?
        WHERE action = ?
          AND idempotency_key = ?
          AND request_hash = ?
          AND response_status = ?
          AND execution_started_at IS NULL
          AND reservation_owner = ?
          AND reservation_generation = ?`,
    )
    .bind(now, action, key, fingerprint, PENDING_RESPONSE_STATUS, token.owner, token.generation)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

async function persistTerminalResponse(
  db: D1Database,
  action: string,
  key: string,
  fingerprint: string,
  token: ReservationToken,
  status: number,
  body: string,
  now: number,
): Promise<boolean> {
  try {
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE admin_idempotency_keys
              SET response_status = ?, response_body = ?, created_at = ?
            WHERE action = ?
              AND idempotency_key = ?
              AND request_hash = ?
              AND response_status = ?
              AND reservation_owner = ?
              AND reservation_generation = ?
              AND execution_started_at IS NOT NULL`,
        )
        .bind(
          status,
          body,
          now,
          action,
          key,
          fingerprint,
          PENDING_RESPONSE_STATUS,
          token.owner,
          token.generation,
        )
        .run(),
    );
    if ((result.meta?.changes ?? 0) === 1) return true;
  } catch (error) {
    logWorkerEvent({
      scope: "admin",
      level: "error",
      event: "idempotency_terminal_response_persist_failed",
      route: action,
      source: "admin_idempotency_keys",
      message: "Failed to persist terminal idempotency response",
      error,
    });
  }

  const record = await loadIdempotencyRecord(db, action, key).catch(() => null);
  return record?.response_status === status && record.response_body === body;
}

async function pruneTerminalIdempotencyRecords(db: D1Database, action: string, now: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM admin_idempotency_keys
        WHERE created_at < ?
          AND response_status <> ?`,
    )
    .bind(now - 7 * DAY_SECONDS, PENDING_RESPONSE_STATUS)
    .run()
    .catch((error) => {
      logWorkerEvent({
        scope: "admin",
        level: "warn",
        event: "idempotency_ttl_prune_failed",
        route: action,
        source: "admin_idempotency_keys",
        message: "Idempotency TTL prune failed",
        error,
      });
    });
}

export async function runIdempotentAdminAction(
  db: D1Database,
  action: string,
  request: Request | undefined,
  execute: () => Promise<Response>,
): Promise<Response> {
  const key = getIdempotencyKey(request);
  if (!key || !request) return execute();

  const fingerprint = await requestFingerprint(request);
  const now = Math.floor(Date.now() / 1000);
  const owner = createReservationOwner(action);
  const reserveResult = await db
    .prepare(
      `INSERT OR IGNORE INTO admin_idempotency_keys
         (action, idempotency_key, request_hash, response_status, response_body, created_at,
          reservation_owner, reservation_generation, execution_started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)`,
    )
    .bind(action, key, fingerprint, PENDING_RESPONSE_STATUS, "", now, owner)
    .run();
  const insertedReservation = (reserveResult.meta?.changes ?? 0) === 1;
  const existing = await loadIdempotencyRecord(db, action, key);
  if (!existing) return errorResponse(500, "Failed to reserve idempotency key");

  if (existing.request_hash !== fingerprint) {
    return errorResponse(409, "Idempotency key reuse with different request payload");
  }
  if (existing.response_status === EXECUTION_UNKNOWN_RESPONSE_STATUS) {
    return withIdempotencyHeaders(buildExecutionUnknownResponse(existing.response_body), key, true);
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
  if (existing.execution_started_at != null) {
    return withIdempotencyHeaders(buildExecutionUnknownResponse(), key, true);
  }

  let token: ReservationToken | null = insertedReservation
    ? { owner, generation: 1 }
    : null;
  if (!token) {
    token = await takeOverAbandonedUnstartedReservation(
      db,
      action,
      key,
      fingerprint,
      owner,
      existing.reservation_generation,
      now,
    );
  }
  if (!token) {
    return withIdempotencyHeaders(errorResponse(409, "Idempotency key is currently reserved"), key, true);
  }

  const executionStarted = await beginReservationExecution(db, action, key, fingerprint, token, now);
  if (!executionStarted) {
    return withIdempotencyHeaders(errorResponse(409, "Idempotency reservation ownership was lost"), key, true);
  }

  let response: Response;
  try {
    response = await execute();
  } catch (error) {
    const failureBody = buildExecutionUnknownBody();
    const persisted = await persistTerminalResponse(
      db,
      action,
      key,
      fingerprint,
      token,
      EXECUTION_UNKNOWN_RESPONSE_STATUS,
      failureBody,
      Math.floor(Date.now() / 1000),
    );
    if (!persisted) {
      logWorkerEvent({
        scope: "admin",
        level: "error",
        event: "idempotency_execution_unknown_unpersisted",
        route: action,
        source: "admin_idempotency_keys",
        message: "Admin action failed after execution started and its unknown outcome could not be persisted",
        error,
      });
    }
    return withIdempotencyHeaders(buildExecutionUnknownResponse(failureBody), key, false);
  }

  const responseBody = await response.clone().text();
  const persisted = await persistTerminalResponse(
    db,
    action,
    key,
    fingerprint,
    token,
    response.status,
    responseBody,
    Math.floor(Date.now() / 1000),
  );
  if (!persisted) {
    return withIdempotencyHeaders(buildExecutionUnknownResponse(), key, false);
  }

  await pruneTerminalIdempotencyRecords(db, action, now);
  return withIdempotencyHeaders(response, key, false);
}
