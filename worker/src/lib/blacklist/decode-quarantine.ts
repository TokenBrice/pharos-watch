export type BlacklistDecodeFailureReason = "invalid-log-identity" | "invalid-address" | "invalid-direction-bool" | "invalid-address-array";

export class BlacklistDecodeError extends Error {
  constructor(readonly reason: BlacklistDecodeFailureReason) {
    super(reason);
    this.name = "BlacklistDecodeError";
  }
}

/** Three distinct scan observations, matching mint/burn's decode retry bound. */
const BLACKLIST_DECODE_RETRY_LIMIT = 3;

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
    const evidenceId = reason === "invalid-log-identity"
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
    // This prefix has no TTL/retention sweep. Keep the source payload and cause
    // after advancing the frontier so a repair never depends on provider retention.
    await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, JSON.stringify({ attempts, observation, quarantined, reason,
        disposition: quarantined ? "decode-retry-exhausted" : "decode-retry", evidence }), Math.floor(Date.now() / 1000))
      .run();
    return quarantined;
  } catch {
    // A failed durable write is not permission to consume the malformed log.
    return false;
  }
}
