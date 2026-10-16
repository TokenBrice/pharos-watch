import { safetyScorePublicationIdentitiesMatch } from "@shared/lib/safety-score-publication";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import { logWorkerEvent } from "../structured-log";
import {
  parseSafetyScoreV9AcceptedBaselineProjection,
  parseSafetyScoreV9LenderCollateralProjection,
  type AcceptedProjectionHeaderV1,
  type AcceptedProjectionUnavailableReason,
  type SafetyScoreV9AcceptedBaselineProjectionV1,
  type SafetyScoreV9LenderCollateralProjectionV1,
} from "./accepted-projections";
import {
  publicationIdentityFromStorageEnvelope,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY,
} from "./publication-codec";
import { parseSafetyScoreV9PublicationHealthCache, SAFETY_SCORE_V9_CACHE_KEYS } from "./publication-store";

export type SafetyScoreV9AcceptedProjectionState<T> =
  | { kind: "accepted"; projection: T; health: V9PublicationHealth }
  | { kind: "bootstrap"; health: V9PublicationHealth | null }
  | { kind: "unavailable"; reason: AcceptedProjectionUnavailableReason };

interface AcceptedProjectionRow {
  projection: string | null;
  projection_updated_at: number | null;
  health: string | null;
  health_updated_at: number | null;
  publication_identity: string | null;
  publication_updated_at: number | null;
  sibling_present: number;
  index_present: number;
  replay_present: number;
  replay_base_present: number;
  published_attempt_present: number | null;
}

async function loadAcceptedProjectionRow(
  db: D1Database,
  projectionKey: string,
  siblingKey: string,
  signal?: AbortSignal,
): Promise<AcceptedProjectionRow | null> {
  throwIfAborted(signal);
  const row = await db.prepare(`SELECT
    r.value AS projection, r.updated_at AS projection_updated_at,
    h.value AS health, h.updated_at AS health_updated_at,
    CASE WHEN json_valid(p.value) THEN json_extract(p.value, '$.identity') END AS publication_identity,
    p.updated_at AS publication_updated_at,
    s.key IS NOT NULL AS sibling_present, i.key IS NOT NULL AS index_present,
    d.key IS NOT NULL AS replay_present, b.key IS NOT NULL AS replay_base_present,
    COALESCE(CASE WHEN json_valid(a.value) THEN
      json_extract(a.value, '$.outcome') IN ('published-clean', 'published-partial')
      END, 0) AS published_attempt_present
    FROM (SELECT 1) singleton
    LEFT JOIN cache r ON r.key = ?
    LEFT JOIN cache h ON h.key = ?
    LEFT JOIN cache p ON p.key = ?
    LEFT JOIN cache s ON s.key = ?
    LEFT JOIN cache i ON i.key = ?
    LEFT JOIN cache d ON d.key = ?
    LEFT JOIN cache b ON b.key = ?
    LEFT JOIN cache a ON a.key = ?`).bind(
    projectionKey, SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
    SAFETY_SCORE_V9_CACHE_KEYS.publication, siblingKey,
    SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex,
    SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY,
    SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY,
    SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt,
  ).first<AcceptedProjectionRow>();
  throwIfAborted(signal);
  return row;
}

function admitAcceptedProjection<T extends AcceptedProjectionHeaderV1>(
  row: AcceptedProjectionRow | null,
  parseProjection: (row: { value: string; updatedAt: number }) => T,
): SafetyScoreV9AcceptedProjectionState<T> {
  const unavailable = (reason: AcceptedProjectionUnavailableReason): SafetyScoreV9AcceptedProjectionState<T> =>
    ({ kind: "unavailable", reason });
  // A singleton-rooted SELECT always returns a row; a missing result is not absence.
  if (row === null) return unavailable("read-failed");
  let health: V9PublicationHealth | null = null;
  if (row.health !== null) {
    try {
      if (row.health_updated_at === null) return unavailable("health-unavailable");
      health = parseSafetyScoreV9PublicationHealthCache({ value: row.health, updatedAt: row.health_updated_at });
    } catch {
      return unavailable("health-unavailable");
    }
  }
  const hasAcceptedWitness = row.publication_updated_at !== null || row.projection !== null ||
    row.sibling_present || row.index_present || row.replay_present || row.replay_base_present ||
    (row.published_attempt_present ?? 0);
  if (!hasAcceptedWitness) {
    if (health === null || (health.status === "held" && health.acceptedPublicationGenerationId === null &&
        health.acceptedAtSec === null)) return { kind: "bootstrap", health };
    return unavailable("health-mismatch");
  }
  if (row.projection === null) return unavailable("projection-missing");
  let projection: T;
  try {
    if (row.projection_updated_at === null) return unavailable("projection-invalid");
    projection = parseProjection({ value: row.projection, updatedAt: row.projection_updated_at });
  } catch {
    return unavailable("projection-invalid");
  }
  let envelopeIdentity: unknown;
  try {
    envelopeIdentity = row.publication_identity === null ? null : JSON.parse(row.publication_identity);
  } catch {
    return unavailable("publication-invalid");
  }
  const identity = publicationIdentityFromStorageEnvelope(envelopeIdentity);
  if (identity === null) return unavailable("publication-invalid");
  if (!safetyScorePublicationIdentitiesMatch(identity, projection.safetyScoreIdentity) ||
      envelopeIdentity === null || typeof envelopeIdentity !== "object" || !("resultDigest" in envelopeIdentity) ||
      envelopeIdentity.resultDigest !== projection.publicationResultDigest ||
      row.publication_updated_at !== projection.publishedAtSec) return unavailable("publication-mismatch");
  if (health === null) return unavailable("health-unavailable");
  if (health.acceptedPublicationGenerationId !== identity.publicationGenerationId ||
      health.acceptedAtSec !== projection.publishedAtSec) return unavailable("health-mismatch");
  return { kind: "accepted", projection, health };
}

export async function loadSafetyScoreV9AcceptedBaselineState(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9AcceptedProjectionState<SafetyScoreV9AcceptedBaselineProjectionV1>> {
  try {
    const row = await loadAcceptedProjectionRow(
      db, SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline, SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral, signal,
    );
    const state = admitAcceptedProjection(row, parseSafetyScoreV9AcceptedBaselineProjection);
    return state;
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEvent({
      scope: "lib", level: "error", event: "safety_score_v9_accepted_projection_read_failed",
      message: "Accepted Safety Score v9 baseline projection read failed",
      source: SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline, error,
    });
    return { kind: "unavailable", reason: "read-failed" };
  }
}

export async function loadSafetyScoreV9LenderCollateralState(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9AcceptedProjectionState<SafetyScoreV9LenderCollateralProjectionV1>> {
  try {
    const row = await loadAcceptedProjectionRow(
      db, SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral, SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline, signal,
    );
    const state = admitAcceptedProjection(row, parseSafetyScoreV9LenderCollateralProjection);
    return state;
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEvent({
      scope: "lib", level: "error", event: "safety_score_v9_accepted_projection_read_failed",
      message: "Accepted Safety Score v9 lender collateral projection read failed",
      source: SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral, error,
    });
    return { kind: "unavailable", reason: "read-failed" };
  }
}
