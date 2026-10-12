import { DigestLlmProfileSchema, type DigestKind, type DigestLlmProfile } from "@shared/types/digest";
import { throwIfAborted } from "./abort";
import { getCache } from "./db-cache";
import { logWorkerEventArgs } from "./structured-log";

export type DigestLlmProfiles = Record<DigestKind, DigestLlmProfile>;

export const DIGEST_LLM_PROFILE_CACHE_KEYS: Record<DigestKind, string> = {
  daily: "digest:llm-profile:daily",
  weekly: "digest:llm-profile:weekly",
};
const DEFAULT_DIGEST_LLM_PROFILE: DigestLlmProfile = "standard";

export function parseDigestLlmProfile(value: unknown): DigestLlmProfile | null {
  const parsed = DigestLlmProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve the mutable generation profile inside an active scheduled context.
 * `heavy` is an optional extra spend on top of the proven path, so a missing,
 * invalid, or unreadable value falls back to `standard` instead of failing the
 * edition. Cancellation still propagates.
 */
export async function resolveDigestLlmProfile(
  db: D1Database,
  kind: DigestKind,
  signal?: AbortSignal,
): Promise<DigestLlmProfile> {
  try {
    return await readDigestLlmProfile(db, kind, signal);
  } catch (error) {
    throwIfAborted(signal);
    logWorkerEventArgs("handler", "warn",
      `[digest-llm-profile] ${kind} profile read failed; using ${DEFAULT_DIGEST_LLM_PROFILE}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return DEFAULT_DIGEST_LLM_PROFILE;
  }
}

async function readDigestLlmProfile(
  db: D1Database,
  kind: DigestKind,
  signal?: AbortSignal,
): Promise<DigestLlmProfile> {
  const stored = await getCache(db, DIGEST_LLM_PROFILE_CACHE_KEYS[kind], signal);
  return parseDigestLlmProfile(stored?.value) ?? DEFAULT_DIGEST_LLM_PROFILE;
}

/**
 * Effective profiles for the admin response. A read failure propagates: after
 * a committed write, reporting a guessed `standard` would misstate production.
 */
export async function readDigestLlmProfiles(db: D1Database): Promise<DigestLlmProfiles> {
  const [daily, weekly] = await Promise.all([
    readDigestLlmProfile(db, "daily"),
    readDigestLlmProfile(db, "weekly"),
  ]);
  return { daily, weekly };
}
