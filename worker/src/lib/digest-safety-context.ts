import { safetyScorePublicationIdentitiesMatch } from "@shared/lib/safety-score-publication";
import {
  DigestSafetyContextSchema,
  type DigestSafetyContext,
} from "@shared/types/digest";
import { SafetyScorePublicationIdentitySchema } from "@shared/types/safety-score-publication";
import {
  loadIdentifiedActiveSafetyScoreSource,
  type IdentifiedActiveSafetyScoreSource,
} from "./identified-active-safety-score-source";

export const LEGACY_UNBOUND_DIGEST_SAFETY_REASON = "legacy-unbound";

export interface DigestCopyFields {
  title?: string | null;
  text?: string | null;
  extended?: string | null;
}

const DIGEST_SAFETY_CLAIM_PATTERNS: readonly {
  marker: string;
  pattern: RegExp;
}[] = [
  { marker: "safety-score", pattern: /\bsafety[\s-]+(?:score|grade|rating)s?\b/i },
  { marker: "report-card", pattern: /\breport[\s-]+cards?\b/i },
  { marker: "grade-language", pattern: /\b(?:grade(?:d|s)?|ratings?|rated|upgraded|downgraded)\b/i },
  { marker: "v9-pillar", pattern: /\b(?:backing|exit|control)\s+(?:pillar|score)\b/i },
  { marker: "binding-cap", pattern: /\bbinding\s+cap\b/i },
  {
    marker: "symbol-grade",
    pattern:
      // eslint-disable-next-line security/detect-unsafe-regex -- Bounded symbol width and disjoint token branches make this expression linear.
      /\b[A-Z][A-Z0-9-]{1,14}\s+(?:is|was|remains?|holds?|sits?|moved|fell|rose|slipped|climbed)\s+(?:at\s+|an?\s+)?(?:A[+-]|B[+-]?|C[+-]?|D[+-]?|F|NR)\b/,
  },
];

export function findDigestSafetyClaimMarkers(copy: DigestCopyFields): string[] {
  const value = [copy.title, copy.text, copy.extended]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  if (!value) return [];
  return DIGEST_SAFETY_CLAIM_PATTERNS
    .filter(({ pattern }) => pattern.test(value))
    .map(({ marker }) => marker);
}

export function findUnboundDigestSafetyClaimMarkers(
  context: DigestSafetyContext | undefined,
  copy: DigestCopyFields,
): string[] {
  if (context?.status === "available") return [];
  return findDigestSafetyClaimMarkers(copy);
}

export function digestSafetyContextFromSource(
  source: IdentifiedActiveSafetyScoreSource,
): DigestSafetyContext {
  if (source.kind === "error") {
    return {
      status: "unavailable",
      expectedModel: source.expectedModel,
      identity: null,
      publishedAt: null,
      reason: source.reason,
    };
  }
  return {
    status: "available",
    expectedModel: source.expectedModel,
    identity: source.identity,
    publishedAt: source.publishedAtSec,
    reason: null,
  };
}

export async function loadDigestSafetyContext(
  db: D1Database,
  signal?: AbortSignal,
): Promise<DigestSafetyContext> {
  return digestSafetyContextFromSource(await loadIdentifiedActiveSafetyScoreSource(db, signal));
}

export function parseDigestSafetyContext(raw: unknown): DigestSafetyContext | null {
  return DigestSafetyContextSchema.safeParse(raw).data ?? null;
}

export function digestSafetyContextFromPersistedInput(input: unknown): DigestSafetyContext {
  if (input && typeof input === "object") {
    const record = input as {
      safetyContext?: unknown;
      safetyScores?: { provenance?: unknown };
    };
    const explicit = parseDigestSafetyContext(record.safetyContext);
    if (explicit) return explicit;

    const provenance = record.safetyScores?.provenance;
    if (provenance && typeof provenance === "object") {
      const { publishedAt, ...identityCandidate } = provenance as Record<string, unknown>;
      const identity = SafetyScorePublicationIdentitySchema.safeParse(identityCandidate).data;
      if (identity && typeof publishedAt === "number" && Number.isInteger(publishedAt) && publishedAt >= 0) {
        return {
          status: "available",
          expectedModel: identity.model,
          identity,
          publishedAt,
          reason: null,
        };
      }
    }
  }
  return {
    status: "unavailable",
    expectedModel: "v9",
    identity: null,
    publishedAt: null,
    reason: LEGACY_UNBOUND_DIGEST_SAFETY_REASON,
  };
}

export type DigestSafetyDeliveryCheck =
  | { kind: "ok" }
  | { kind: "stale"; reason: "legacy-unbound" | "identity-mismatch" }
  | { kind: "unavailable"; reason: string };

/**
 * Safety-free digests remain deliverable. Once copy was authored with a
 * concrete Safety Score publication, delivery requires that exact identity.
 */
export async function checkDigestSafetyContextForDelivery(
  db: D1Database,
  authored: DigestSafetyContext,
  signal?: AbortSignal,
): Promise<DigestSafetyDeliveryCheck> {
  if (authored.status === "unavailable") {
    return authored.reason === LEGACY_UNBOUND_DIGEST_SAFETY_REASON
      ? { kind: "stale", reason: "legacy-unbound" }
      : { kind: "ok" };
  }
  const current = await loadIdentifiedActiveSafetyScoreSource(db, signal);
  if (current.kind === "error") {
    return { kind: "unavailable", reason: current.reason };
  }
  return safetyScorePublicationIdentitiesMatch(authored.identity, current.identity)
    ? { kind: "ok" }
    : { kind: "stale", reason: "identity-mismatch" };
}
