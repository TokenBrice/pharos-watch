import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { SAFETY_SCORE_PUBLICATION_AGE_REASON } from "@pharos/contracts/api-meta";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import { addFreshnessHeaders } from "../api-freshness-headers";
import { jsonResponseWithHeaders, withRepresentationEtag, type ResponseRepresentationPolicy } from "../api-response";
import { isSafetyScoreV9SnapshotFresh, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "./consumer-freshness";

export function safetyScoreResponsePolicy(response: Response): ResponseRepresentationPolicy {
  const status = response.headers.get("X-Safety-Score-Status");
  return { cacheable: status !== "held", identity: status };
}

export function withSafetyScoreRepresentationEtag(response: Response, identity: unknown): Response {
  return withRepresentationEtag(response, identity, safetyScoreResponsePolicy(response));
}

interface SafetyScoreSnapshotResponseMetadata {
  publicationHealth: V9PublicationHealth;
  updatedAt: number;
}

export function jsonSafetyScoreSnapshotResponse(
  snapshot: SafetyScoreSnapshotResponseMetadata & {
    safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
    publicationHealth: V9PublicationHealth;
  },
  body: unknown,
  representation: string,
): Response {
  return withSafetyScoreRepresentationEtag(jsonResponseWithHeaders(body, safetyScoreSnapshotHeaders(
    snapshot, snapshot.safetyScoreIdentity.publicationGenerationId)), [representation, snapshot.safetyScoreIdentity, snapshot.publicationHealth]);
}

/**
 * Shared policy for object responses and admitted immutable byte streams.
 * The verdict uses the V9 consumer budget (one missed publication), not the
 * generic 8x endpoint runway: a stalled producer must read `stale`, and an
 * edge-cached `current` copy must not outlive that budget.
 */
export function safetyScoreSnapshotHeaders(
  snapshot: SafetyScoreSnapshotResponseMetadata,
  generationId: string,
): Record<string, string> {
  const nowSec = Date.now() / 1000;
  const held = snapshot.publicationHealth.status === "held";
  const status = held ? "held" : isSafetyScoreV9SnapshotFresh(snapshot, Math.floor(nowSec)) ? "current" : "stale";
  const headers = addFreshnessHeaders({
    "Content-Type": "application/json",
    "Cache-Control": status === "current" ? CACHE_PROFILES.standard : CACHE_PROFILES.noStore,
    "X-Safety-Score-Status": status,
    "X-Safety-Score-Generation": generationId,
    "X-Safety-Score-Freshness-Budget": String(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC),
  }, snapshot.updatedAt, API_FRESHNESS_MAX_AGE_SEC.reportCards, {
    assessedAt: nowSec, freshBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
  });
  if (status !== "stale") return headers;
  // The generic helper tolerates small future skew, but the safety verdict
  // does not; keep the generic freshness surface consistent with it.
  const future = !(snapshot.updatedAt <= nowSec);
  return {
    ...headers,
    "X-Data-Freshness": "stale",
    "X-Data-Freshness-Reason": future ? "future-timestamp" : SAFETY_SCORE_PUBLICATION_AGE_REASON,
    // A future-dated publication at any skew is still a stale safety verdict;
    // the generic 199 warning would hide it from freshness-warning consumers.
    Warning: headers.Warning?.startsWith("110 - ")
      ? headers.Warning
      : `110 - "Safety Score publication is ${future ? "future-dated" : "stale"} (consumer budget ${SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC}s)"`,
  };
}
