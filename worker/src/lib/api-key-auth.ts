import { timingSafeCompare } from "./auth";
import {
  API_KEY_TOKEN_PATTERN,
  clearApiKeyCache,
  getNowSec,
  hmacSha256Hex,
  lookupApiKeyByPrefix,
  mapRowToAuthenticatedKey,
  type ApiKeyAuthenticationResult,
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
    if (!row || row.is_active !== 1) {
      return { kind: "invalid" };
    }
    if (row.expires_at != null && row.expires_at <= nowSec) {
      return { kind: "invalid" };
    }

    const expectedHash = await hmacSha256Hex(effectivePepper, parsed.secret);
    if (await timingSafeCompare(expectedHash, row.secret_hash)) {
      return {
        kind: "valid",
        key: mapRowToAuthenticatedKey(row),
      };
    }

    const effectivePreviousPepper = pepperPrevious?.trim();
    if (effectivePreviousPepper) {
      const previousHash = await hmacSha256Hex(effectivePreviousPepper, parsed.secret);
      if (await timingSafeCompare(previousHash, row.secret_hash)) {
        await db.prepare(
          "UPDATE api_keys SET secret_hash = ?, pepper_version = pepper_version + 1, updated_at = ? WHERE id = ?",
        )
          .bind(expectedHash, nowSec, row.id)
          .run();
        clearApiKeyCache(parsed.prefix);
        return {
          kind: "valid",
          key: mapRowToAuthenticatedKey(row),
        };
      }
    }

    return { kind: "invalid" };
  } catch (err) {
    console.warn("[api-keys] API key authentication dependency unavailable:", err);
    clearApiKeyCache(parsed.prefix);
    return { kind: "unavailable" };
  }
}
