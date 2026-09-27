export type BlacklistDecodeFailureReason = "invalid-log-identity" | "invalid-address" | "invalid-direction-bool" | "invalid-address-array";

export class BlacklistDecodeError extends Error {
  constructor(readonly reason: BlacklistDecodeFailureReason) {
    super(reason);
    this.name = "BlacklistDecodeError";
  }
}

/** Three distinct scan observations, matching mint/burn's decode retry bound. */
const BLACKLIST_DECODE_RETRY_LIMIT = 3;

function boundedEvidence(evidence: unknown): { fields: Record<string, string | number | boolean>; truncated: boolean } {
  const fields: Record<string, string | number | boolean> = {};
  let truncated = false;
  if (evidence == null || typeof evidence !== "object") return { fields, truncated: evidence != null };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  for (const key of [
    "address", "blockHash", "blockNumber", "transactionHash", "transactionIndex", "logIndex",
    "block_number", "block_timestamp", "transaction_id", "event_index", "event_name", "contract_address",
    "data", "result",
  ]) {
    if (!(key in evidence)) continue;
    const value: unknown = Reflect.get(evidence, key);
    if (typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
    } else if (value != null) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const bytes = encoder.encode(text);
      const limit = key === "data" || key === "result" ? 4096 : 256;
      fields[key] = bytes.length > limit ? decoder.decode(bytes.subarray(0, limit), { stream: true }) : text;
      if (bytes.length > limit) truncated = true;
    }
  }
  return { fields, truncated };
}

export async function quarantineBlacklistDecodeFailure(
  db: D1Database,
  configKey: string,
  identity: string,
  reason: BlacklistDecodeFailureReason,
  evidence: unknown,
  observation: number,
): Promise<boolean> {
  try {
    // Without a valid log identity, distinguish different malformed payloads
    // rather than letting one quarantine admission consume another source row.
    const evidenceId = reason === "invalid-log-identity" || identity.length > 512
      ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(evidence)))),
        (byte) => byte.toString(16).padStart(2, "0")).join("")
      : identity;
    const key = `blacklist:decode-retry:${configKey}:${evidenceId}`;
    const prior = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>();
    const state = prior ? JSON.parse(prior.value) : null;
    if (state?.quarantined === true) return true;
    const attempts = (Number.isSafeInteger(state?.attempts) ? state.attempts : 0)
      + (state?.observation === observation ? 0 : 1);
    const quarantined = attempts >= BLACKLIST_DECODE_RETRY_LIMIT;
    // Retain bounded identity/payload evidence indefinitely for repair, without
    // letting a corrupt provider payload exceed D1's row limit and hold the frontier.
    const retained = boundedEvidence(evidence);
    await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, JSON.stringify({ attempts, observation, quarantined, reason,
        disposition: quarantined ? "decode-retry-exhausted" : "decode-retry",
        evidence: retained.fields, evidenceTruncated: retained.truncated }), Math.floor(Date.now() / 1000))
      .run();
    return quarantined;
  } catch {
    // A failed durable write is not permission to consume the malformed log.
    return false;
  }
}
