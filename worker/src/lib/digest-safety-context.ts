import {
  assessSafetyScoreAcceptedEvidence,
  safetyScorePublicationIdentitiesMatch,
} from "@shared/lib/safety-score-publication";
import {
  DigestSafetyContextSchema,
  type DigestSafetyContext,
} from "@shared/types/digest";
import { SafetyScorePublicationIdentitySchema } from "@shared/types/safety-score-publication";
import {
  loadActiveSafetyScoreIndex,
  type ActiveSafetyScoreIndex,
} from "./safety-score-index";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "./safety-score-v9/consumer-freshness";

export const LEGACY_UNBOUND_DIGEST_SAFETY_REASON = "legacy-unbound";
const STALE_DIGEST_SAFETY_REASON = "v9-snapshot-stale";

/** Digests are current-only consumers: an accepted generation past budget is unavailable. */
function acceptedSnapshotWithinBudget(
  snapshot: { updatedAt: number; safetyScoreIdentity: { publicationGenerationId: string } },
  nowSec: number,
): boolean {
  return assessSafetyScoreAcceptedEvidence({
    acceptedGenerationId: snapshot.safetyScoreIdentity.publicationGenerationId,
    acceptedAtSec: snapshot.updatedAt,
    nowSec,
    maxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
  }).withinBudget;
}

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
      /\b[A-Z][A-Z0-9-]{1,14}\s+(?:is|was|remains?|holds?|held|sits?|moved|fell|rose|slipped|climbed|dropped|declined)\s+(?:at\s+|an?\s+|to\s+|from\s+)?(?:A[+-]?|B[+-]?|C[+-]?|D[+-]?|F|NR)(?![A-Za-z0-9])/,
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
  source: ActiveSafetyScoreIndex,
  nowSec = Math.floor(Date.now() / 1000),
): DigestSafetyContext {
  if (source.kind !== "v9" || !acceptedSnapshotWithinBudget(source.snapshot, nowSec)) {
    return {
      status: "unavailable",
      expectedModel: "v9",
      identity: null,
      publishedAt: null,
      reason: source.kind !== "v9" ? source.reason : STALE_DIGEST_SAFETY_REASON,
    };
  }
  return {
    status: "available",
    expectedModel: source.snapshot.safetyScoreIdentity.model,
    identity: source.snapshot.safetyScoreIdentity,
    publishedAt: source.snapshot.updatedAt,
    reason: null,
  };
}

export async function loadDigestSafetyContext(
  db: D1Database,
  signal?: AbortSignal,
): Promise<DigestSafetyContext> {
  return digestSafetyContextFromSource(await loadActiveSafetyScoreIndex(db, signal));
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
 * concrete Safety Score publication, delivery requires that exact identity
 * still inside the consumer budget; an expired match is retried, not sent.
 */
export async function checkDigestSafetyContextForDelivery(
  db: D1Database,
  authored: DigestSafetyContext,
  signal?: AbortSignal,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<DigestSafetyDeliveryCheck> {
  if (authored.status === "unavailable") {
    return authored.reason === LEGACY_UNBOUND_DIGEST_SAFETY_REASON
      ? { kind: "stale", reason: "legacy-unbound" }
      : { kind: "ok" };
  }
  const current = await loadActiveSafetyScoreIndex(db, signal);
  if (current.kind !== "v9") {
    return { kind: "unavailable", reason: current.reason };
  }
  if (!safetyScorePublicationIdentitiesMatch(authored.identity, current.snapshot.safetyScoreIdentity)) {
    return { kind: "stale", reason: "identity-mismatch" };
  }
  return acceptedSnapshotWithinBudget(current.snapshot, nowSec)
    ? { kind: "ok" }
    : { kind: "unavailable", reason: STALE_DIGEST_SAFETY_REASON };
}
