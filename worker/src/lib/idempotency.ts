import { errorResponse } from "./api-utils";

interface IdempotencyRecord {
  request_hash: string;
  response_status: number;
  response_body: string;
}

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
  const canonical = `${request.method}\n${url.pathname}\n${url.searchParams.toString()}\n${body}`;
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
  const existing = await db
    .prepare(
      "SELECT request_hash, response_status, response_body FROM admin_idempotency_keys WHERE action = ? AND idempotency_key = ?",
    )
    .bind(action, key)
    .first<IdempotencyRecord>();

  if (existing) {
    if (existing.request_hash !== fingerprint) {
      return errorResponse(409, "Idempotency key reuse with different request payload");
    }
    return withIdempotencyHeaders(
      new Response(existing.response_body, {
        status: existing.response_status,
        headers: { "Content-Type": "application/json" },
      }),
      key,
      true,
    );
  }

  const response = await execute();
  const responseBody = await response.clone().text();
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      "INSERT OR IGNORE INTO admin_idempotency_keys (action, idempotency_key, request_hash, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(action, key, fingerprint, response.status, responseBody, now)
    .run();

  // Keep table bounded.
  await db
    .prepare("DELETE FROM admin_idempotency_keys WHERE created_at < ?")
    .bind(now - 7 * 86400)
    .run()
    .catch(() => {});

  return withIdempotencyHeaders(response, key, false);
}
