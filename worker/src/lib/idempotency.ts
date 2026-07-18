import { DAY_SECONDS } from "@shared/lib/time-constants";
import { errorResponse, withResponseHeaders } from "./api-response";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { sha256Hex } from "./hash";
import { logWorkerEvent } from "./structured-log";
import { DEFAULT_ADMIN_REQUEST_JSON_MAX_BYTES, readRequestTextBounded } from "./api-json-body";

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

export interface IdempotentActionOptions {
  /** Persist a secret-free replay body while leaving the first live response untouched. */
  sensitiveReplayBody?: (responseBody: string, responseStatus: number) => string;
  /** Body cap used while hashing the cloned request. */
  requestMaxBytes?: number;
  /** Override which returned responses have an unconfirmed execution outcome. */
  isExecutionOutcomeUnknown?: (response: Response) => boolean;
  /** Identify a retryable response returned before the protected action began. */
  isPreExecutionRetryable?: (response: Response) => boolean;
}

export type IdempotentAdminActionOptions = IdempotentActionOptions;

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

export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function isWellFormedIdempotencyKey(value: string | null): boolean {
  if (!value) return false;
  const key = value.trim();
  return key.length <= MAX_IDEMPOTENCY_KEY_LENGTH && IDEMPOTENCY_KEY_PATTERN.test(key);
}

export function getIdempotencyKey(request: Request | undefined): string | null {
  const raw = request?.headers.get("Idempotency-Key");
  if (!raw) return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) return null;
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
    headers: {
      "Content-Type": "application/json",
      "X-Execution-Certainty": "unknown",
    },
  });
}

function hasUnconfirmedExecutionOutcome(response: Response): boolean {
  return response.status >= 500 || response.headers.get("X-Execution-Certainty")?.trim().toLowerCase() === "unknown";
}

async function requestFingerprint(request: Request, maxBytes: number): Promise<string | Response> {
  const clone = request.clone();
  const body = await readRequestTextBounded(clone, maxBytes);
  if (body instanceof Response) return body;
  const url = new URL(request.url);
  const sortedSearchParams = new URLSearchParams(url.searchParams);
  sortedSearchParams.sort();
  const canonical = `${request.method}\n${url.pathname}\n${sortedSearchParams.toString()}\n${body}`;
  return sha256Hex(canonical);
}

async function loadIdempotencyRecord(db: D1Database, action: string, key: string): Promise<IdempotencyRecord | null> {
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
      .bind(owner, now, action, key, fingerprint, PENDING_RESPONSE_STATUS, existingGeneration, cutoff)
      .run();
    return (takeoverResult.meta?.changes ?? 0) === 1 ? { owner, generation: existingGeneration + 1 } : null;
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
        .bind(status, body, now, action, key, fingerprint, PENDING_RESPONSE_STATUS, token.owner, token.generation)
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

async function releasePreExecutionReservation(
  db: D1Database,
  action: string,
  key: string,
  fingerprint: string,
  token: ReservationToken,
): Promise<boolean> {
  try {
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `DELETE FROM admin_idempotency_keys
            WHERE action = ?
              AND idempotency_key = ?
              AND request_hash = ?
              AND response_status = ?
              AND reservation_owner = ?
              AND reservation_generation = ?
              AND execution_started_at IS NOT NULL`,
        )
        .bind(action, key, fingerprint, PENDING_RESPONSE_STATUS, token.owner, token.generation)
        .run(),
    );
    if ((result.meta?.changes ?? 0) === 1) return true;
  } catch (error) {
    logWorkerEvent({
      scope: "admin",
      level: "error",
      event: "idempotency_pre_execution_release_failed",
      route: action,
      source: "admin_idempotency_keys",
      message: "Failed to release a retryable pre-execution idempotency reservation",
      error,
    });
  }

  try {
    return (await loadIdempotencyRecord(db, action, key)) === null;
  } catch {
    return false;
  }
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

export async function runIdempotentAction(
  db: D1Database,
  action: string,
  request: Request | undefined,
  execute: () => Promise<Response>,
  options: IdempotentActionOptions = {},
): Promise<Response> {
  const key = getIdempotencyKey(request);
  if (!key || !request) return execute();

  const fingerprint = await requestFingerprint(
    request,
    options.requestMaxBytes ?? DEFAULT_ADMIN_REQUEST_JSON_MAX_BYTES,
  );
  if (fingerprint instanceof Response) return fingerprint;
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
    return withResponseHeaders(
      withIdempotencyHeaders(errorResponse(409, "Idempotency key reuse with different request payload"), key, true),
      { "X-Idempotency-Conflict": "request-mismatch" },
    );
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

  let token: ReservationToken | null = insertedReservation ? { owner, generation: 1 } : null;
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

  if (options.isPreExecutionRetryable?.(response)) {
    const released = await releasePreExecutionReservation(db, action, key, fingerprint, token);
    return withIdempotencyHeaders(released ? response : buildExecutionUnknownResponse(), key, false);
  }

  const executionOutcomeUnknown =
    options.isExecutionOutcomeUnknown?.(response) ?? hasUnconfirmedExecutionOutcome(response);
  if (executionOutcomeUnknown) {
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
        event: "idempotency_unconfirmed_response_unpersisted",
        route: action,
        source: "admin_idempotency_keys",
        message: "An unconfirmed admin response could not be persisted as execution_unknown",
      });
    }
    return withIdempotencyHeaders(buildExecutionUnknownResponse(failureBody), key, false);
  }

  const responseBody = await response.clone().text();
  let replayBody = responseBody;
  if (options.sensitiveReplayBody) {
    try {
      replayBody = options.sensitiveReplayBody(responseBody, response.status);
    } catch (error) {
      logWorkerEvent({
        scope: "admin",
        level: "error",
        event: "idempotency_sensitive_replay_redaction_failed",
        route: action,
        source: "admin_idempotency_keys",
        message: "Sensitive response redaction failed after execution; returning execution_unknown",
        error,
      });
      const failureBody = buildExecutionUnknownBody();
      await persistTerminalResponse(
        db,
        action,
        key,
        fingerprint,
        token,
        EXECUTION_UNKNOWN_RESPONSE_STATUS,
        failureBody,
        Math.floor(Date.now() / 1000),
      );
      return withIdempotencyHeaders(buildExecutionUnknownResponse(failureBody), key, false);
    }
  }
  const persisted = await persistTerminalResponse(
    db,
    action,
    key,
    fingerprint,
    token,
    response.status,
    replayBody,
    Math.floor(Date.now() / 1000),
  );
  if (!persisted) {
    return withIdempotencyHeaders(buildExecutionUnknownResponse(), key, false);
  }

  await pruneTerminalIdempotencyRecords(db, action, now);
  return withIdempotencyHeaders(response, key, false);
}

export function runIdempotentAdminAction(
  db: D1Database,
  action: string,
  request: Request | undefined,
  execute: () => Promise<Response>,
  options: IdempotentAdminActionOptions = {},
): Promise<Response> {
  return runIdempotentAction(db, action, request, execute, options);
}
