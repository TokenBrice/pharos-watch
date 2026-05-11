import { timingSafeCompare } from "./auth";
import {
  API_KEY_TOKEN_PATTERN,
  clearApiKeyCache,
  getCachedApiKeyByPrefix,
  getNowSec,
  hmacSha256Hex,
  lookupApiKeyByPrefix,
  mapRowToAuthenticatedKey,
  type ApiKeyAuthenticationResult,
  type ApiKeyRow,
  type ApiKeyDb,
  type ParsedApiKeyToken,
} from "./api-key-core";

export function parseApiKeyToken(token: string | null | undefined): ParsedApiKeyToken | null {
  const trimmed = token?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(API_KEY_TOKEN_PATTERN);
  if (!match) {
    return null;
  }

  return {
    token: trimmed,
    prefix: match[1] ?? "",
    secret: match[2] ?? "",
  };
}

async function authenticateLoadedApiKey(
  row: ApiKeyRow | null,
  parsed: ParsedApiKeyToken,
  db: ApiKeyDb,
  pepper: string,
  pepperPrevious: string | undefined,
  nowSec: number,
  allowPepperMigrationWrite: boolean,
): Promise<ApiKeyAuthenticationResult> {
  if (!row || row.is_active !== 1) {
    return { kind: "invalid" };
  }
  if (row.expires_at != null && row.expires_at <= nowSec) {
    return { kind: "invalid" };
  }

  const expectedHash = await hmacSha256Hex(pepper, parsed.secret);
  if (await timingSafeCompare(expectedHash, row.secret_hash)) {
    return {
      kind: "valid",
      key: mapRowToAuthenticatedKey(row),
    };
  }

  const effectivePreviousPepper = pepperPrevious?.trim();
  if (!effectivePreviousPepper) {
    return { kind: "invalid" };
  }

  const previousHash = await hmacSha256Hex(effectivePreviousPepper, parsed.secret);
  if (!(await timingSafeCompare(previousHash, row.secret_hash))) {
    return { kind: "invalid" };
  }

  if (allowPepperMigrationWrite) {
    try {
      await db.prepare(
        "UPDATE api_keys SET secret_hash = ?, pepper_version = pepper_version + 1, updated_at = ? WHERE id = ?",
      )
        .bind(expectedHash, nowSec, row.id)
        .run();
      clearApiKeyCache(parsed.prefix);
    } catch (err) {
      console.warn("[api-keys] API key pepper migration write unavailable; keeping previous hash until D1 recovers:", err);
    }
  }

  return {
    kind: "valid",
    key: mapRowToAuthenticatedKey(row),
  };
}

async function hasSelfServeRevocation(db: ApiKeyDb, row: ApiKeyRow): Promise<boolean> {
  if (row.tier !== "self-serve") {
    return false;
  }
  const marker = await db.prepare(
    "SELECT 1 AS revoked FROM api_key_self_serve_revocations WHERE key_prefix = ? LIMIT 1",
  )
    .bind(row.key_prefix)
    .first<{ revoked: number }>();
  return Boolean(marker);
}

export async function authenticateApiKey(
  db: ApiKeyDb,
  apiKeyHeader: string | null,
  pepper: string | undefined,
  pepperPrevious?: string,
  nowSec = getNowSec(),
): Promise<ApiKeyAuthenticationResult> {
  const parsed = parseApiKeyToken(apiKeyHeader);
  if (!parsed) {
    return apiKeyHeader?.trim() ? { kind: "invalid" } : { kind: "missing" };
  }

  const effectivePepper = pepper?.trim();
  if (!effectivePepper) {
    return { kind: "unavailable" };
  }

  try {
    const row = await lookupApiKeyByPrefix(db, parsed.prefix);
    if (row && await hasSelfServeRevocation(db, row)) {
      clearApiKeyCache(parsed.prefix);
      return { kind: "invalid" };
    }
    return authenticateLoadedApiKey(
      row,
      parsed,
      db,
      effectivePepper,
      pepperPrevious,
      nowSec,
      true,
    );
  } catch (err) {
    const staleRow = getCachedApiKeyByPrefix(parsed.prefix, { allowStale: true });
    if (staleRow) {
      if (staleRow.tier === "self-serve") {
        clearApiKeyCache(parsed.prefix);
        console.warn("[api-keys] API key lookup unavailable; refusing stale self-serve key cache:", err);
        return { kind: "unavailable" };
      }
      console.warn("[api-keys] API key lookup unavailable; using stale verified key cache:", err);
      return authenticateLoadedApiKey(
        staleRow,
        parsed,
        db,
        effectivePepper,
        pepperPrevious,
        nowSec,
        false,
      );
    }
    console.warn("[api-keys] API key authentication dependency unavailable:", err);
    return { kind: "unavailable" };
  }
}
