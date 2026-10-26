import { SafetyScoreCohortSchema, type SafetyScoreCohort, type SafetyScoreCohortCard } from "@shared/types/safety-score-cohort";
import { SafetyScoreIndexSchema } from "@shared/types/safety-score-index";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import { safetyScorePublicationIdentitiesMatch } from "@shared/lib/safety-score-publication";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { throwIfAborted } from "./abort";
import { publicationIdentityFromStorageEnvelope, SafetyScoreV9SchemaCutoverPendingError } from "./safety-score-v9/publication-codec";
import { SAFETY_SCORE_V9_CACHE_KEYS, parseSafetyScoreV9PublicationHealthCache, resolveSafetyScoreV9EffectivePublicationHealth } from "./safety-score-v9/publication-health";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { loadPublishedReportCardsV9Snapshot } from "./report-cards-v9-cache";
import { loadActiveSafetyScoreIndex } from "./safety-score-index";
import { SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, reassembleSafetyScoreV9CohortStoredValue } from "./safety-score-v9/publication-chunks";

/**
 * The canonical Safety Score source in one union. `v9` is the only usable
 * state; `held` still carries the last verified snapshot (consumers that may
 * surface held ratings read it, consumers bound to live ratings must not), and
 * `error` carries no snapshot at all.
 *
 * "Publication unusable" is defined here once: `kind !== "v9"`.
 */
export type ActiveSafetyScoreSource =
  | {
      kind: "v9";
      snapshot: ReportCardsV9CurrentResponse;
    }
  | {
      kind: "held";
      reason: "v9-publication-held";
      detail: string;
      snapshot: ReportCardsV9CurrentResponse;
    }
  | {
      kind: "error";
      reason: "v9-snapshot-unavailable" | "publication-schema-cutover-pending";
      detail: string;
      snapshot: null;
    };

/**
 * Resolves the canonical Safety Score source. V9 is the only live model;
 * unavailable or incompatible state fails closed and never selects V8.
 */
export async function loadActiveSafetyScoreSource(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ActiveSafetyScoreSource> {
  return loadPublishedReportCardsV9Snapshot(db, signal).then(
    (snapshot): ActiveSafetyScoreSource => {
      return (
      snapshot.publicationHealth.status === "held"
        ? {
            kind: "held",
            reason: "v9-publication-held",
            detail:
              "Canonical Safety Score V9 ratings are held at the last verified snapshot",
            snapshot,
          }
        : {
            kind: "v9",
            snapshot,
          });
    },
    (error): ActiveSafetyScoreSource => ({
      kind: "error",
      reason: error instanceof Error && error.message.includes("publication-schema-cutover-pending")
        ? "publication-schema-cutover-pending" : "v9-snapshot-unavailable",
      detail:
        error instanceof Error
          ? error.message
          : "Canonical V9 publication is unavailable",
      snapshot: null,
    }),
  );
}

/**
 * Identity-only view of {@link ActiveSafetyScoreSource}. Same three states,
 * decided from the same publication and effective health, without the cards.
 */
export type ActiveSafetyScoreIdentity =
  | {
      kind: "v9";
      safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
    }
  | {
      kind: "held";
      safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
    }
  | {
      kind: "error";
      safetyScoreIdentity: null;
    };

/**
 * Resolves identity from the generation-bound index without inflating cards.
 * Missing or mismatched sidecars fail closed during rollout as well as at rest.
 */
export async function loadActiveSafetyScoreIdentity(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ActiveSafetyScoreIdentity> {
  const active = await loadActiveSafetyScoreIndex(db, signal);
  return active.kind === "error"
    ? { kind: "error", safetyScoreIdentity: null }
    : { kind: active.kind, safetyScoreIdentity: active.snapshot.safetyScoreIdentity };
}

export type SafetyScoreCohortSnapshot = Pick<SafetyScoreCohort,
  "safetyScoreIdentity" | "asOfSec" | "dependencyGraph" | "commonModeGroups"> & {
  cards: SafetyScoreCohortCard[];
  completeness: ReportCardsV9CurrentResponse["completeness"];
  lifecycle: "active";
  methodology: { version: string };
  updatedAt: number;
  publicationHealth: V9PublicationHealth;
};

export type ActiveSafetyScoreCohort =
  | { kind: "v9"; snapshot: SafetyScoreCohortSnapshot }
  | { kind: "held"; reason: "v9-publication-held"; detail: string; snapshot: SafetyScoreCohortSnapshot }
  | { kind: "error"; reason: string; detail: string; snapshot: null };

/** Bind metadata and chunks in one atomic read batch without repeating metadata per chunk. */
export async function loadActiveSafetyScoreCohort(db: D1Database, signal?: AbortSignal): Promise<ActiveSafetyScoreCohort> {
  const unavailable = (reason: string): ActiveSafetyScoreCohort => ({
    kind: "error", reason, detail: `Canonical Safety Score cohort unavailable: ${reason}`, snapshot: null,
  });
  const available = (snapshot: SafetyScoreCohortSnapshot): ActiveSafetyScoreCohort =>
    snapshot.publicationHealth.status === "held"
      ? { kind: "held", reason: "v9-publication-held", detail: "Canonical Safety Score V9 ratings are held at the last verified snapshot", snapshot }
      : { kind: "v9", snapshot };
  try {
    throwIfAborted(signal);
    const [metadata, chunks] = await db.batch([
      db.prepare(`SELECT c.value AS cohort, c.updated_at AS cohort_updated_at,
        i.value AS score_index, i.updated_at AS index_updated_at,
        h.value AS health, h.updated_at AS health_updated_at,
        json_extract(p.value, '$.identity') AS publication_identity,
        json_extract(p.value, '$.identity.resultDigest') AS result_digest,
        p.updated_at AS publication_updated_at
        FROM cache p
        LEFT JOIN cache c ON c.key = ?
        LEFT JOIN cache h ON h.key = ?
        LEFT JOIN cache i ON i.key = ?
        WHERE p.key = ?`).bind(SAFETY_SCORE_V9_CACHE_KEYS.cohort, SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
        SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex, SAFETY_SCORE_V9_CACHE_KEYS.publication),
      db.prepare(`SELECT k.key AS chunk_key, k.value AS chunk FROM cache c
        JOIN cache k ON json_valid(c.value)
          AND k.key >= ? || json_extract(c.value, '$.payloadSha256') || ':'
          AND k.key < ? || json_extract(c.value, '$.payloadSha256') || ';'
        WHERE c.key = ? ORDER BY k.key LIMIT 10`).bind(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX,
        SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, SAFETY_SCORE_V9_CACHE_KEYS.cohort),
    ]);
    throwIfAborted(signal);
    const row = metadata!.results[0] as {
      cohort: string | null; cohort_updated_at: number | null;
      score_index: string | null; index_updated_at: number | null;
      health: string | null; health_updated_at: number | null;
      publication_identity: string | null; result_digest: string | null; publication_updated_at: number;
    } | undefined;
    const rows = chunks!.results as { chunk_key: string; chunk: string }[];
    if (!row) return unavailable("v9-snapshot-unavailable");
    const identity = row.publication_identity === null ? null
      : publicationIdentityFromStorageEnvelope(JSON.parse(row.publication_identity));
    if (identity === null) return unavailable("safety-cohort-publication-invalid");
    if (row.health === null || row.health_updated_at === null) return unavailable("safety-cohort-health-unavailable");
    let health;
    try {
      health = parseSafetyScoreV9PublicationHealthCache({ value: row.health, updatedAt: row.health_updated_at });
    } catch (error) {
      return unavailable(error instanceof SafetyScoreV9SchemaCutoverPendingError ? "publication-schema-cutover-pending" : "safety-cohort-health-unavailable");
    }
    if (health.acceptedPublicationGenerationId !== identity.publicationGenerationId) return unavailable("safety-cohort-health-mismatch");
    if (row.score_index === null) return unavailable("safety-cohort-index-missing");
    let index;
    try {
      const storedIndex: unknown = JSON.parse(row.score_index);
      if (storedIndex && typeof storedIndex === "object" && "schemaVersion" in storedIndex && storedIndex.schemaVersion === 1) return unavailable("publication-schema-cutover-pending");
      index = SafetyScoreIndexSchema.parse(storedIndex);
      if (stableJsonStringifyV1(index) !== row.score_index) return unavailable("safety-cohort-index-invalid");
    } catch {
      return unavailable("safety-cohort-index-invalid");
    }
    if (!safetyScorePublicationIdentitiesMatch(index.safetyScoreIdentity, identity) ||
        index.publicationResultDigest !== row.result_digest || index.publishedAtSec !== row.publication_updated_at ||
        row.index_updated_at !== index.publishedAtSec) return unavailable("safety-cohort-index-mismatch");
    let cohort: SafetyScoreCohort | null = null;
    if (row.cohort !== null) {
      try {
        const stored = reassembleSafetyScoreV9CohortStoredValue(row.cohort,
          rows.map((part) => ({ key: part.chunk_key, value: part.chunk })));
        cohort = SafetyScoreCohortSchema.parse(JSON.parse(stored));
        if (stableJsonStringifyV1(cohort) !== stored || row.cohort_updated_at !== cohort.publishedAtSec) return unavailable("safety-cohort-invalid");
      } catch {
        return unavailable("safety-cohort-invalid");
      }
    }
    if (cohort === null) return unavailable("safety-cohort-missing");
    if (!safetyScorePublicationIdentitiesMatch(identity, cohort.safetyScoreIdentity) ||
        row.result_digest !== cohort.publicationResultDigest || row.publication_updated_at !== cohort.publishedAtSec ||
        index.asOfSec !== cohort.asOfSec) {
      return unavailable("safety-cohort-publication-mismatch");
    }
    if (cohort.cards.length !== index.expectedCount || cohort.cards.some((card) => !Object.prototype.hasOwnProperty.call(index.scores, card.id))) {
      return unavailable("safety-cohort-index-membership-mismatch");
    }
    const serialById = new Map<string, { upstreamAssetId: string }[]>();
    for (const edge of cohort.dependencyGraph.edges) {
      if (edge.kind !== "serial") continue;
      const serial = serialById.get(edge.to) ?? [];
      serial.push({ upstreamAssetId: edge.from });
      serialById.set(edge.to, serial);
    }
    const cards = cohort.cards.map((card): SafetyScoreCohortCard => ({
      ...card, ...index.scores[card.id]!,
      bindingCap: card.caps.find((cap) => cap.binding) ?? null,
      dependencies: { ...card.dependencies, serial: serialById.get(card.id) ?? [] },
    }));
    const notRatedIds = cards.filter((card) => card.ratingStatus === "not-rated").map((card) => card.id);
    const pipelineGapIds = cards.filter((card) => card.ratingStatus === "pipeline-gap").map((card) => card.id);
    return available({
      lifecycle: "active", safetyScoreIdentity: cohort.safetyScoreIdentity,
      methodology: { version: cohort.safetyScoreIdentity.methodologyVersion },
      asOfSec: cohort.asOfSec, updatedAt: cohort.publishedAtSec,
      publicationHealth: resolveSafetyScoreV9EffectivePublicationHealth({
        publicationGenerationId: identity.publicationGenerationId, publishedAtSec: cohort.publishedAtSec,
      }, health),
      completeness: { expectedCount: index.expectedCount, ratedCount: cards.length - notRatedIds.length - pipelineGapIds.length,
        notRatedCount: notRatedIds.length, notRatedIds, pipelineGapCount: pipelineGapIds.length, pipelineGapIds },
      dependencyGraph: cohort.dependencyGraph, cards,
      ...(cohort.commonModeGroups === undefined ? {} : { commonModeGroups: cohort.commonModeGroups }),
    });
  } catch {
    return unavailable("safety-cohort-read-failed");
  }
}
