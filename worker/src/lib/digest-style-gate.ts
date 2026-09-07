import { getCache } from "./db-cache";

export type DigestStyleGateMode = "shadow" | "enforce";
export type DigestStyleGateKind = "daily" | "weekly";
export type DigestStyleGateModes = Record<DigestStyleGateKind, DigestStyleGateMode>;

export const DIGEST_STYLE_GATE_MODE_CACHE_KEYS: Record<DigestStyleGateKind, string> = {
  daily: "digest:style-gate-mode:daily",
  weekly: "digest:style-gate-mode:weekly",
};
export const DEFAULT_DIGEST_STYLE_GATE_MODE: DigestStyleGateMode = "shadow";

export function parseDigestStyleGateMode(value: unknown): DigestStyleGateMode | null {
  return value === "shadow" || value === "enforce" ? value : null;
}

/** Resolve the mutable gate inside an active request/scheduled context. */
export async function resolveDigestStyleGateMode(
  db: D1Database,
  kind: DigestStyleGateKind,
  signal?: AbortSignal,
): Promise<DigestStyleGateMode> {
  const stored = await getCache(db, DIGEST_STYLE_GATE_MODE_CACHE_KEYS[kind], signal);
  return parseDigestStyleGateMode(stored?.value) ?? DEFAULT_DIGEST_STYLE_GATE_MODE;
}

export async function resolveDigestStyleGateModes(
  db: D1Database,
): Promise<DigestStyleGateModes> {
  const [daily, weekly] = await Promise.all([
    resolveDigestStyleGateMode(db, "daily"),
    resolveDigestStyleGateMode(db, "weekly"),
  ]);
  return { daily, weekly };
}
