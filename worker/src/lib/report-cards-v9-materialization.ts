import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { stableJsonStringifyChunksV1, stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { safetyScorePublicationIdentitiesMatch } from "@shared/lib/safety-score-publication";
import {
  V9PublicRepresentationManifestSchema, V9_PUBLIC_FRAGMENT_MAX_BYTES,
  V9_PUBLIC_REPRESENTATION_MAX_BYTES, V9_PUBLIC_REPRESENTATION_MAX_FRAGMENTS,
  V9_PUBLIC_REPRESENTATION_VERSION, V9_PUBLIC_READ_GRACE_SEC,
  type V9PublicRepresentationManifest,
} from "@shared/types/report-cards-v9-materialization";
import { SafetyScoreV9ResolvedCurrentCardSchema, type SafetyScoreV9CurrentCard, type SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { buildReportCardsV9DependencyGraph, ReportCardsV9DependencyGraphSchema, type V9PublicationHealth } from "@shared/types/report-cards-v9";
import { resolveV9PublicWitnessTexts } from "@shared/types/safety-score-v9-public-witness-texts";
import { projectSafetyScoreV9PublicationForMaterialization } from "./report-cards-v9-cache";
import { SafetyScoreV9StorageMetadataSchema, SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES, parseSafetyScoreV9Publication, publicationIdentityFromStorageEnvelope } from "./safety-score-v9/publication-codec";
import { SAFETY_SCORE_V9_CACHE_KEYS, parseSafetyScoreV9PublicationHealthCache, resolveSafetyScoreV9EffectivePublicationHealth } from "./safety-score-v9/publication-health";
import { D1_MAX_BOUND_PARAMETERS, executeAtomicBatch, prepareMultiRowInsertStatements } from "./db";
import { D1_BATCH_SIZE } from "./constants";
import { sha256HexFromUtf8Chunks } from "./hash";
import { loadSafetyScoreV9PublicationStoredRow } from "./safety-score-v9/publication-chunks";
import { projectV9Table, projectV9Detail } from "@shared/lib/report-cards-v9-projections";
import type { ReportCardsV9ProjectionSource, ReportCardsV9TableResponse, ReportCardsV9DetailResponse } from "@shared/types/report-cards-v9-projections";
import { acquireCronLease, releaseCronLease } from "./cron-lease-primitives";
import { loadActiveSafetyScoreIndex } from "./safety-score-index";
import { throwIfAborted } from "./abort";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";

type SiteMaterialization = { key: string; artifact: V9PublicMaterialization };

export interface V9PublicMaterialization {
  manifest: V9PublicRepresentationManifest;
  fragments: string[];
}

export interface V9StagedPublicMaterialization {
  manifest: V9PublicRepresentationManifest;
  siteCount: number;
}

export class V9PublicMaterializationUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Canonical Safety Score V9 representation unavailable: ${reason}`);
  }
}
const unavailable = (reason: string): never => { throw new V9PublicMaterializationUnavailableError(reason); };
const V9_MATERIALIZATION_REPAIR_LEASE_SEC = 60;
/** Marker naming the generation whose public representations are selected. */
export const V9_PUBLIC_MATERIALIZATION_CACHE_KEY = "report-cards:v9:public-materialization";
/**
 * Acceptance commits before the public representations are materialized. For
 * one publication cadence readers keep serving the previously selected
 * generation as that generation's accepted snapshot; afterwards the lagging
 * generation is served as held, never as current.
 */
const V9_PUBLIC_MATERIALIZATION_LAG_BUDGET_SEC = CRON_SCHEDULE_CADENCES.v9PublicationOffset.intervalSec;
// Read budget only: staging retains its independent four-fragment write envelope.
const V9_PUBLIC_FRAGMENT_READ_MAX_BYTES = 4 * 1024 * 1024;

/** Admit the cohort once, then expand/serialize only one representation at a time. */
function* buildV9PublicMaterializations(
  publication: SafetyScoreV9CurrentResponse,
  health: V9PublicationHealth,
  payloadSha256: string,
): Generator<V9PublicMaterialization> {
  const snapshot = projectSafetyScoreV9PublicationForMaterialization(publication, health);
  yield buildMaterialization(snapshot, publication, payloadSha256);
  const table = projectV9Table(snapshot);
  let siteBytes = 0;
  const boundedSite = (artifact: V9PublicMaterialization) => {
    siteBytes += artifact.manifest.bytes;
    if (siteBytes > 64 * 1024 * 1024) throw new Error("v9-site-materializations-oversized");
    return artifact;
  };
  yield boundedSite(buildMaterialization(table, publication, payloadSha256));
  for (const card of snapshot.cards) {
    yield boundedSite(buildMaterialization(projectV9Detail(snapshot, card.id, table.dependencyGraph), publication, payloadSha256));
  }
}

/**
 * Generate one artifact at a time, but coalesce its rows with consecutive small
 * representations. Per-representation IO makes the cohort exceed the lane
 * deadline. Bound each serial write to the old four-fragment byte envelope,
 * including manifests, other bindings and SQL, without retaining all details.
 * Only the final canonical-pointer transaction makes staged rows readable.
 */
export async function stageV9PublicMaterialization(
  db: D1Database,
  publication: SafetyScoreV9CurrentResponse,
  health: V9PublicationHealth,
  payloadSha256: string,
  signal?: AbortSignal,
): Promise<V9StagedPublicMaterialization> {
  let manifest: V9PublicRepresentationManifest | undefined;
  let siteCount = 0;
  const groups = [
    { sql: `INSERT OR IGNORE INTO safety_score_public_manifests
      (generation_id, projection_version, payload_sha256, manifest, created_at, retired_at)`, columns: 6, rows: [] as (string | number)[][] },
    { sql: `INSERT OR IGNORE INTO safety_score_public_fragments
      (generation_id, projection_version, payload_sha256, ordinal, body)`, columns: 5, rows: [] as (string | number)[][] },
    { sql: `INSERT OR IGNORE INTO safety_score_site_manifests
      (generation_id, projection_version, payload_sha256, representation_key, manifest, created_at, retired_at)`, columns: 7, rows: [] as (string | number)[][] },
    { sql: `INSERT OR IGNORE INTO safety_score_site_fragments
      (generation_id, projection_version, payload_sha256, representation_key, ordinal, body)`, columns: 6, rows: [] as (string | number)[][] },
  ];
  const maxBatchBytes = 4 * V9_PUBLIC_FRAGMENT_MAX_BYTES;
  let batchBytes = 0;
  let statementCount = 0;
  const flush = async () => {
    throwIfAborted(signal);
    if (statementCount === 0) return;
    await executeAtomicBatch(db, groups.flatMap(group =>
      prepareMultiRowInsertStatements(db, group.sql, group.rows)), { signal });
    for (const group of groups) group.rows.length = 0;
    batchBytes = 0;
    statementCount = 0;
  };
  const appendRow = async (group: typeof groups[number], row: (string | number)[], bodyBytes?: number) => {
    const rowsPerStatement = Math.floor(D1_MAX_BOUND_PARAMETERS / group.columns);
    // Fragment byte lengths were already authenticated by the materializer;
    // do not allocate/encode their bodies a second time just to budget IO.
    const bindingBytes = row.reduce<number>((bytes, value, index) => bytes +
      (bodyBytes !== undefined && index === row.length - 1 ? bodyBytes
        : typeof value === "string" ? Buffer.byteLength(value, "utf8") : 8), 0);
    const newStatementBytes = Buffer.byteLength(group.sql, "utf8") + " VALUES ".length + 3 * group.columns;
    const continuedStatementBytes = 2 + 3 * group.columns;
    if (bindingBytes + newStatementBytes > maxBatchBytes) throw new Error("v9-materialization-staging-row-oversized");
    let startsStatement = group.rows.length % rowsPerStatement === 0;
    let sqlBytes = startsStatement ? newStatementBytes : continuedStatementBytes;
    if (batchBytes + bindingBytes + sqlBytes > maxBatchBytes ||
        statementCount + Number(startsStatement) > D1_BATCH_SIZE) {
      await flush();
      startsStatement = true;
      sqlBytes = newStatementBytes;
    }
    group.rows.push(row);
    batchBytes += bindingBytes + sqlBytes;
    statementCount += Number(startsStatement);
  };
  for (const artifact of buildV9PublicMaterializations(publication, health, payloadSha256)) {
    throwIfAborted(signal);
    const m = artifact.manifest;
    const key = m.representationKey;
    const now = Math.floor(Date.now() / 1000);
    const identity = [m.safetyScoreIdentity.publicationGenerationId, m.version, m.payloadSha256];
    const manifestGroup = key === undefined ? groups[0]! : groups[2]!;
    const fragmentGroup = key === undefined ? groups[1]! : groups[3]!;
    const representation = key === undefined ? identity : [...identity, key];
    await appendRow(manifestGroup, [...representation, stableJsonStringifyV1(m), now, now]);
    for (let ordinal = 0; ordinal < artifact.fragments.length; ordinal++) {
      await appendRow(fragmentGroup, [...representation, ordinal, artifact.fragments[ordinal]!], m.fragments[ordinal]!.bytes);
      artifact.fragments[ordinal] = "";
    }
    artifact.fragments.length = 0;
    if (key === undefined) manifest = m;
    else siteCount++;
  }
  await flush();
  if (!manifest) throw new Error("v9-public-materialization-missing");
  return { manifest, siteCount };
}

/**
 * Select only a fully staged generation, and only while it is still the
 * accepted canonical generation (also valid after the canonical write inside
 * the acceptance batch, for non-deferred acceptance). The guard writes the small materialization
 * marker naming the selected generation; a failed predicate becomes a NOT NULL
 * violation so D1 rolls the whole selection back.
 */
export function v9StagedPublicMaterializationStatements(
  db: D1Database, staged: V9StagedPublicMaterialization,
): D1PreparedStatement[] {
  const m = staged.manifest;
  const identity = [m.safetyScoreIdentity.publicationGenerationId, m.version, m.payloadSha256];
  const now = Math.floor(Date.now() / 1000);
  const marker = stableJsonStringifyV1({
    schemaVersion: 1, publicationGenerationId: m.safetyScoreIdentity.publicationGenerationId,
    projectionVersion: m.version, payloadSha256: m.payloadSha256, publishedAtSec: m.publishedAtSec,
    siteRepresentationCount: staged.siteCount, materializedAtSec: now,
  });
  const statements = [db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, CASE WHEN
    EXISTS (SELECT 1 FROM cache WHERE key = ? AND updated_at = ?
      AND json_extract(value, '$.identity.publicationGenerationId') = ?
      AND json_extract(value, '$.payloadSha256') = ?)
    AND (SELECT count(*) FROM safety_score_public_manifests
      WHERE generation_id = ? AND projection_version = ? AND payload_sha256 = ?) = 1
    AND (SELECT count(*) FROM safety_score_public_fragments
      WHERE generation_id = ? AND projection_version = ? AND payload_sha256 = ?) = ?
    AND (SELECT count(*) FROM safety_score_site_manifests
      WHERE generation_id = ? AND projection_version = ? AND payload_sha256 = ?) = ?
    AND NOT EXISTS (SELECT 1 FROM safety_score_site_manifests m
      WHERE m.generation_id = ? AND m.projection_version = ? AND m.payload_sha256 = ?
      AND (SELECT count(*) FROM safety_score_site_fragments f
        WHERE f.generation_id = m.generation_id AND f.projection_version = m.projection_version
          AND f.payload_sha256 = m.payload_sha256 AND f.representation_key = m.representation_key)
        != json_array_length(m.manifest, '$.fragments'))
    THEN ? ELSE NULL END, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(V9_PUBLIC_MATERIALIZATION_CACHE_KEY, SAFETY_SCORE_V9_CACHE_KEYS.publication, m.publishedAtSec,
      m.safetyScoreIdentity.publicationGenerationId, m.payloadSha256,
      ...identity, ...identity, m.fragments.length, ...identity, staged.siteCount, ...identity, marker, now)];
  for (const table of ["safety_score_public_manifests", "safety_score_site_manifests"] as const) {
    // SAFETY: Table identifiers come only from the fixed literal list above.
    statements.push(db.prepare(`UPDATE ${table} SET retired_at = CASE
      WHEN generation_id = ? AND projection_version = ? AND payload_sha256 = ? THEN NULL
      ELSE coalesce(retired_at, ?) END
      WHERE retired_at IS NULL OR (generation_id = ? AND projection_version = ? AND payload_sha256 = ?)`)
      .bind(...identity, now, ...identity));
    // SAFETY: Table identifiers come only from the fixed literal list above.
    statements.push(db.prepare(`DELETE FROM ${table} WHERE retired_at < ? AND generation_id != ?`)
      .bind(now - V9_PUBLIC_READ_GRACE_SEC, m.safetyScoreIdentity.publicationGenerationId));
  }
  return statements;
}

export interface V9AcceptedPublicMaterializationSource {
  publication: SafetyScoreV9CurrentResponse;
  health: V9PublicationHealth;
  payloadSha256: string;
}

export interface V9PublicMaterializationTiming {
  materializeStage: number | null;
  materializeSelect: number | null;
}

export type V9PublicMaterializationResult =
  | { status: "materialized"; publicationGenerationId: string; siteRepresentationCount: number }
  | { status: "superseded"; publicationGenerationId: string };

/**
 * Post-acceptance follow-up: stage every representation of an already accepted
 * generation, then select it atomically. Staging is idempotent (immutable
 * generation-keyed rows), so a retry repeats safely; until selection, readers
 * keep serving the previously selected generation.
 */
export async function materializeV9AcceptedPublication(
  db: D1Database,
  source: V9AcceptedPublicMaterializationSource,
  signal?: AbortSignal,
  timing?: V9PublicMaterializationTiming,
): Promise<V9PublicMaterializationResult> {
  const generationId = source.publication.publicationGenerationId;
  let startedAtMs = Date.now();
  let staged: V9StagedPublicMaterialization;
  try {
    staged = await stageV9PublicMaterialization(db, source.publication, source.health, source.payloadSha256, signal);
  } finally {
    if (timing) timing.materializeStage = Date.now() - startedAtMs;
  }
  startedAtMs = Date.now();
  try {
    await executeAtomicBatch(db, v9StagedPublicMaterializationStatements(db, staged), { signal });
  } catch (error) {
    throwIfAborted(signal);
    const canonical = await db.prepare(`SELECT json_extract(value, '$.identity.publicationGenerationId') AS generation_id
      FROM cache WHERE key = ?`).bind(SAFETY_SCORE_V9_CACHE_KEYS.publication).first<{ generation_id: string | null }>();
    if (canonical !== null && canonical.generation_id !== generationId) return { status: "superseded", publicationGenerationId: generationId };
    throw error;
  } finally {
    if (timing) timing.materializeSelect = Date.now() - startedAtMs;
  }
  throwIfAborted(signal);
  return { status: "materialized", publicationGenerationId: generationId, siteRepresentationCount: staged.siteCount };
}

function buildMaterialization(
  snapshot: ReportCardsV9ProjectionSource | ReportCardsV9TableResponse | ReportCardsV9DetailResponse,
  publication: SafetyScoreV9CurrentResponse,
  payloadSha256: string,
): V9PublicMaterialization {
  const encoder = new TextEncoder();
  const fragments: string[] = [];
  let pending: string[] = [];
  let pendingBytes = 0;
  let totalBytes = 0;
  const append = (text: string) => {
    // Split on UTF-16 boundaries without splitting surrogate pairs. Each piece
    // is <=128 KiB UTF-8, even for a single unusually long evidence string.
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 32768, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      const piece = text.slice(start, end);
      const bytes = encoder.encode(piece).byteLength;
      totalBytes += bytes;
      if (totalBytes > V9_PUBLIC_REPRESENTATION_MAX_BYTES) throw new Error("v9-public-representation-oversized");
      if (pendingBytes + bytes > V9_PUBLIC_FRAGMENT_MAX_BYTES) {
        fragments.push(pending.join(""));
        pending = [];
        pendingBytes = 0;
      }
      pending.push(piece);
      pendingBytes += bytes;
      start = end;
    }
  };
  // A producer-created JSON suffix, not a quoted field or token substitution.
  // Serializing bounded chunks avoids a second complete serialized body/copy.
  const graphCards: Pick<SafetyScoreV9CurrentCard, "id" | "dependencies">[] = [];
  for (const key of Object.keys(snapshot).sort()) {
    if (key === "publicationHealth") continue;
    const value = snapshot[key as keyof typeof snapshot];
    if (value === undefined) continue;
    append(`,${JSON.stringify(key)}:`);
    if (key === "cards" && !("projection" in snapshot)) {
      append("[");
      for (let index = 0; index < snapshot.cards.length; index++) {
        // Only one expanded card/temporary schema clone is resident at a time.
        const card = SafetyScoreV9ResolvedCurrentCardSchema.parse(resolveV9PublicWitnessTexts(snapshot.cards[index]!));
        graphCards.push({ id: card.id, dependencies: card.dependencies });
        if (index > 0) append(",");
        for (const chunk of stableJsonStringifyChunksV1(card)) append(chunk);
      }
      append("]");
    } else if (key === "dependencyGraph" && !("projection" in snapshot)) {
      const graph = ReportCardsV9DependencyGraphSchema.parse(buildReportCardsV9DependencyGraph(graphCards));
      for (const chunk of stableJsonStringifyChunksV1(graph)) append(chunk);
      graphCards.length = 0;
    } else {
      for (const chunk of stableJsonStringifyChunksV1(value)) append(chunk);
    }
  }
  append("}");
  if (pending.length) fragments.push(pending.join(""));
  if (fragments.length > V9_PUBLIC_REPRESENTATION_MAX_FRAGMENTS) throw new Error("v9-public-representation-too-many-fragments");
  const manifest = V9PublicRepresentationManifestSchema.parse({
    version: V9_PUBLIC_REPRESENTATION_VERSION,
    encoding: "utf8-json-health-suffix",
    ...("projection" in snapshot ? { representationKey: snapshot.projection === "table" ? "table" : `coin:${snapshot.coinId}` } : {}),
    safetyScoreIdentity: snapshot.safetyScoreIdentity,
    candidateId: publication.candidateId, factSetDigest: publication.factSetDigest,
    resultDigest: publication.resultDigest, payloadSha256,
    publishedAtSec: publication.publishedAtSec, asOfSec: publication.asOfSec,
    bytes: totalBytes, sha256: sha256HexFromUtf8Chunks(fragments),
    fragments: fragments.map(body => ({ bytes: encoder.encode(body).byteLength, sha256: sha256HexFromUtf8Chunks([body]) })),
  });
  return { manifest, fragments };
}

/**
 * Request-repair write for the canonical representation. Clears unselected rows
 * an interrupted publisher left for the same identity, so the repaired bytes are
 * never mixed with staged ones. Selection of other generations is left to the
 * publisher, which retires them only when it selects a complete generation.
 */
function v9PublicMaterializationStatements(db: D1Database, artifact: V9PublicMaterialization): D1PreparedStatement[] {
  const m = artifact.manifest;
  const now = Math.floor(Date.now() / 1000);
  const identity = [m.safetyScoreIdentity.publicationGenerationId, m.version, m.payloadSha256];
  return [
    db.prepare(`DELETE FROM safety_score_public_manifests
      WHERE generation_id = ? AND projection_version = ? AND payload_sha256 = ? AND retired_at IS NOT NULL`).bind(...identity),
    db.prepare(`INSERT OR IGNORE INTO safety_score_public_manifests
      (generation_id, projection_version, payload_sha256, manifest, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(...identity, stableJsonStringifyV1(m), now),
    ...prepareMultiRowInsertStatements(db, `INSERT OR IGNORE INTO safety_score_public_fragments
      (generation_id, projection_version, payload_sha256, ordinal, body)`, artifact.fragments.map((body, ordinal) => [...identity, ordinal, body])),
  ];
}

function siteMaterializationStatements(db: D1Database, representations: SiteMaterialization[]): D1PreparedStatement[] {
  const now = Math.floor(Date.now() / 1000);
  // Repair writes only the requested representation.
  const statements: D1PreparedStatement[] = [];
  const manifestRows: (string | number)[][] = [];
  const fragmentRows: (string | number)[][] = [];
  for (const { key, artifact } of representations) {
    const m = artifact.manifest;
    statements.push(db.prepare(`DELETE FROM safety_score_site_manifests WHERE generation_id = ? AND projection_version = ?
      AND payload_sha256 = ? AND representation_key = ? AND retired_at IS NOT NULL`)
      .bind(m.safetyScoreIdentity.publicationGenerationId, m.version, m.payloadSha256, key));
    manifestRows.push([m.safetyScoreIdentity.publicationGenerationId, m.version, m.payloadSha256, key, stableJsonStringifyV1(m), now]);
    for (let ordinal = 0; ordinal < artifact.fragments.length; ordinal++) {
      fragmentRows.push([m.safetyScoreIdentity.publicationGenerationId, m.version, m.payloadSha256, key, ordinal, artifact.fragments[ordinal]!]);
    }
  }
  return [
    ...statements,
    ...prepareMultiRowInsertStatements(db, `INSERT OR IGNORE INTO safety_score_site_manifests
      (generation_id, projection_version, payload_sha256, representation_key, manifest, created_at)`, manifestRows),
    ...prepareMultiRowInsertStatements(db, `INSERT OR IGNORE INTO safety_score_site_fragments
      (generation_id, projection_version, payload_sha256, representation_key, ordinal, body)`, fragmentRows),
  ];
}

type Selection = {
  metadata: string; publication_updated_at: number;
  health: string | null; health_updated_at: number | null;
  manifest: string | null;
  fragment_count: number;
  payload_type: string | null; payload_length: number | null; stored_bytes: number;
};

async function selectRepresentation(db: D1Database, representationKey?: string): Promise<Selection | null> {
  const manifests = representationKey ? "safety_score_site_manifests" : "safety_score_public_manifests";
  const fragments = representationKey ? "safety_score_site_fragments" : "safety_score_public_fragments";
  const bindings: (string | number)[] = [SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth, V9_PUBLIC_REPRESENTATION_VERSION];
  if (representationKey) bindings.push(representationKey);
  bindings.push(SAFETY_SCORE_V9_CACHE_KEYS.publication);
  // SAFETY: Table identifiers and optional clauses come only from the closed literal branches above/below; all data values are bound.
  // A sharded envelope carries `payloadChunks` (its digest is checked when the
  // payload itself is read) and records the single-row-equivalent stored bytes.
  return db.prepare(`SELECT json_remove(p.value, '$.payload') AS metadata,
    coalesce(json_type(p.value, '$.payload'), CASE WHEN json_type(p.value, '$.payloadChunks') = 'object' THEN 'chunks' END) AS payload_type,
    coalesce(length(json_extract(p.value, '$.payload')), json_extract(p.value, '$.payloadChunks.payloadBytes')) AS payload_length,
    coalesce(json_extract(p.value, '$.payloadChunks.storedBytes'), length(CAST(p.value AS BLOB))) AS stored_bytes,
    p.updated_at AS publication_updated_at, h.value AS health, h.updated_at AS health_updated_at,
    m.manifest AS manifest, (SELECT count(*) FROM ${fragments} f
      WHERE f.generation_id = m.generation_id AND f.projection_version = m.projection_version
        AND f.payload_sha256 = m.payload_sha256 ${representationKey ? "AND f.representation_key = m.representation_key" : ""}) AS fragment_count FROM cache p
    LEFT JOIN cache h ON h.key = ?
    LEFT JOIN ${manifests} m ON m.generation_id = json_extract(p.value, '$.identity.publicationGenerationId')
      AND m.payload_sha256 = json_extract(p.value, '$.payloadSha256') AND m.projection_version = ?
      ${representationKey ? "AND m.representation_key = ?" : ""} AND m.retired_at IS NULL
    WHERE p.key = ?`).bind(...bindings).first<Selection>();
}

/** The newest still-selected representation of a generation accepted before the canonical one. */
async function selectLaggingRepresentation(
  db: D1Database, canonicalGenerationId: string, canonicalPublishedAtSec: number, representationKey?: string,
): Promise<{ manifest: string; fragment_count: number } | null> {
  const bindings: (string | number)[] = [V9_PUBLIC_REPRESENTATION_VERSION, canonicalGenerationId, canonicalPublishedAtSec];
  if (representationKey) bindings.push(representationKey);
  // SAFETY: Table identifiers and the optional clause come only from closed literal branches; all data values are bound.
  return db.prepare(`SELECT m.manifest AS manifest, (SELECT count(*) FROM ${representationKey ? "safety_score_site_fragments" : "safety_score_public_fragments"} f
      WHERE f.generation_id = m.generation_id AND f.projection_version = m.projection_version
        AND f.payload_sha256 = m.payload_sha256 ${representationKey ? "AND f.representation_key = m.representation_key" : ""}) AS fragment_count
    FROM ${representationKey ? "safety_score_site_manifests" : "safety_score_public_manifests"} m
    WHERE m.retired_at IS NULL AND m.projection_version = ? AND m.generation_id != ?
      AND json_extract(m.manifest, '$.publishedAtSec') < ?
      ${representationKey ? "AND m.representation_key = ?" : ""}
    ORDER BY m.created_at DESC LIMIT 1`).bind(...bindings).first<{ manifest: string; fragment_count: number }>();
}

function admitSelection(row: Selection) {
  let metadata;
  try {
    const stored: unknown = JSON.parse(row.metadata);
    if (stored !== null && typeof stored === "object" && "schemaVersion" in stored && stored.schemaVersion === 6) {
      return unavailable("publication-schema-cutover-pending");
    }
    metadata = SafetyScoreV9StorageMetadataSchema.parse(stored);
  } catch (error) {
    if (error instanceof V9PublicMaterializationUnavailableError) throw error;
    return unavailable("v9-public-canonical-marker-invalid");
  }
  if ((row.payload_type !== "text" && row.payload_type !== "chunks") || row.payload_length == null || row.payload_length <= 0 ||
      row.stored_bytes > SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES) return unavailable("v9-public-canonical-marker-invalid");
  const identity = publicationIdentityFromStorageEnvelope(metadata.identity);
  if (!identity) return unavailable("v9-public-canonical-marker-invalid");
  if (row.health == null || row.health_updated_at == null) return unavailable("v9-public-health-unavailable");
  let health;
  try { health = parseSafetyScoreV9PublicationHealthCache({ value: row.health, updatedAt: row.health_updated_at }); }
  catch (error) {
    if (error instanceof Error && error.message.includes("publication-schema-cutover-pending")) return unavailable("publication-schema-cutover-pending");
    return unavailable("v9-public-health-invalid");
  }
  return { metadata, identity, health };
}

/** One builder per accepted generation, across isolates and representation keys.
 * Request repair retains only the requested artifact; the publisher owns the full set.
 */
async function repairMissingRepresentation(db: D1Database, selected: Selection, representationKey?: string): Promise<void> {
  const { metadata, identity, health } = admitSelection(selected);
  if (representationKey?.startsWith("coin:")) {
    const index = await loadActiveSafetyScoreIndex(db);
    if (index.kind === "error") return unavailable(index.reason);
    if (!safetyScorePublicationIdentitiesMatch(index.snapshot.safetyScoreIdentity, identity)
      || index.snapshot.updatedAt !== selected.publication_updated_at) return unavailable("v9-public-backfill-raced");
    if (!index.snapshot.cards.some(card => card.id === representationKey.slice(5))) {
      return unavailable("v9-coin-not-in-accepted-publication");
    }
  }
  const leaseKey = `v9-materialization:${identity.publicationGenerationId}:${V9_PUBLIC_REPRESENTATION_VERSION}:${metadata.payloadSha256}`;
  const owner = crypto.randomUUID();
  if (!await acquireCronLease(db, leaseKey, owner, V9_MATERIALIZATION_REPAIR_LEASE_SEC)) {
    return unavailable("v9-public-materialization-repair-in-progress");
  }
  try {
    // A prior claimant may have finished between selection and lease acquisition.
    const current = await selectRepresentation(db, representationKey);
    if (!current || current.publication_updated_at !== selected.publication_updated_at
      || current.metadata !== selected.metadata) return unavailable("v9-public-backfill-raced");
    if (current.manifest !== null) return;
    const source = await loadSafetyScoreV9PublicationStoredRow(db);
    if (!source || source.updatedAt !== selected.publication_updated_at) return unavailable("v9-public-backfill-raced");
    const stored = JSON.parse(source.value);
    const storedIdentity = publicationIdentityFromStorageEnvelope(stored.identity);
    if (stored.payloadSha256 !== metadata.payloadSha256 || storedIdentity === null ||
        !safetyScorePublicationIdentitiesMatch(storedIdentity, identity)) return unavailable("v9-public-backfill-raced");
    const publication = await parseSafetyScoreV9Publication(source.value);
    if (publication.publishedAtSec !== source.updatedAt) return unavailable("v9-public-canonical-clock-mismatch");
    const snapshot = projectSafetyScoreV9PublicationForMaterialization(publication, health);
    const projection = representationKey === undefined ? snapshot
      : representationKey === "table" ? projectV9Table(snapshot)
      : projectV9Detail(snapshot, representationKey.slice(5));
    const artifact = buildMaterialization(projection, publication, metadata.payloadSha256);
    // Losing the generation OR the lease rolls back the entire artifact write.
    const now = Math.floor(Date.now() / 1000);
    const guard = db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (
      ?, (SELECT CASE WHEN updated_at = ? AND json_extract(value, '$.payloadSha256') = ?
        AND json_extract(value, '$.identity.publicationGenerationId') = ?
        AND EXISTS (SELECT 1 FROM cron_leases WHERE job = ? AND lease_owner = ? AND lease_until > ?)
        THEN value ELSE NULL END FROM cache WHERE key = ?), ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(SAFETY_SCORE_V9_CACHE_KEYS.publication, source.updatedAt, metadata.payloadSha256,
        identity.publicationGenerationId, leaseKey, owner, now, SAFETY_SCORE_V9_CACHE_KEYS.publication, source.updatedAt);
    await executeAtomicBatch(db, [guard, ...(representationKey === undefined
      ? v9PublicMaterializationStatements(db, artifact)
      : siteMaterializationStatements(db, [{ key: representationKey, artifact }]))]);
  } finally {
    await releaseCronLease(db, leaseKey, owner);
  }
}

export async function loadV9PublicMaterializedResponse(db: D1Database, representationKey?: string): Promise<{
  body: ReadableStream<Uint8Array>; updatedAt: number; publicationHealth: V9PublicationHealth;
  representationIdentity: { version: number; generationId: string; sha256: string };
}> {
  try {
    let row = await selectRepresentation(db, representationKey);
    if (!row) return unavailable("v9-snapshot-unavailable");
    let lagging: { manifest: string; fragment_count: number } | null = null;
    let withinLagBudget = false;
    if (row.manifest == null) {
      const canonical = admitSelection(row);
      withinLagBudget = Math.floor(Date.now() / 1000) - row.publication_updated_at <= V9_PUBLIC_MATERIALIZATION_LAG_BUDGET_SEC;
      // Acceptance commits before materialization: keep serving the previously
      // selected generation instead of a torn or partially staged one.
      lagging = await selectLaggingRepresentation(db, canonical.identity.publicationGenerationId, row.publication_updated_at, representationKey);
      if (lagging === null || !withinLagBudget) {
        // Cold rollout, a key absent from the previous generation, or a
        // publisher that did not finish within the lag budget. Repair is safe
        // beside publisher staging: it replaces unselected rows of the key
        // atomically, and staging never overwrites existing rows.
        try {
          await repairMissingRepresentation(db, row, representationKey);
        } catch (error) {
          // A contended or failed repair keeps serving the lagging generation as held.
          if (lagging === null) throw error;
        }
        const repaired = await selectRepresentation(db, representationKey);
        if (repaired?.manifest != null) {
          row = repaired;
          lagging = null;
        } else if (lagging === null) return unavailable("v9-public-materialization-missing");
      }
    }
    const { metadata, identity, health } = admitSelection(row);
    const manifestText = lagging?.manifest ?? row.manifest!;
    const fragmentCount = lagging?.fragment_count ?? row.fragment_count;
    let manifest;
    try {
      manifest = V9PublicRepresentationManifestSchema.parse(JSON.parse(manifestText));
      if (stableJsonStringifyV1(manifest) !== manifestText) return unavailable("v9-public-manifest-invalid");
    } catch { return unavailable("v9-public-manifest-invalid"); }
    if (manifest.representationKey !== representationKey) return unavailable("v9-public-representation-key-mismatch");
    if (lagging !== null) {
      if (manifest.safetyScoreIdentity.publicationGenerationId === identity.publicationGenerationId
        || manifest.publishedAtSec >= row.publication_updated_at) return unavailable("v9-public-manifest-publication-mismatch");
    } else if (!safetyScorePublicationIdentitiesMatch(identity, manifest.safetyScoreIdentity)
      || manifest.payloadSha256 !== metadata.payloadSha256
      || manifest.resultDigest !== metadata.identity.resultDigest
      || manifest.candidateId !== metadata.identity.candidateId
      || manifest.factSetDigest !== metadata.identity.factSetDigest
      || manifest.publishedAtSec !== row.publication_updated_at) return unavailable("v9-public-manifest-publication-mismatch");
    const servedGenerationId = manifest.safetyScoreIdentity.publicationGenerationId;
    if (fragmentCount !== manifest.fragments.length) return unavailable("v9-public-fragments-count-invalid");
    const fragments: string[] = [];
    const encoder = new TextEncoder();
    const hash = createHash("sha256");
    let bytes = 0;
    // Pack by admitted bytes instead of paying one D1 round trip per four rows.
    // Keep result transfers bounded and serial; never fan out the whole artifact.
    for (let offset = 0; offset < manifest.fragments.length;) {
      let end = offset;
      let readBytes = 0;
      while (end < manifest.fragments.length &&
          readBytes + manifest.fragments[end]!.bytes <= V9_PUBLIC_FRAGMENT_READ_MAX_BYTES) {
        readBytes += manifest.fragments[end++]!.bytes;
      }
      const bindings: (string | number)[] = [servedGenerationId, manifest.version, manifest.payloadSha256];
      if (representationKey) bindings.push(representationKey);
      bindings.push(offset, end);
      // SAFETY: The table and optional clause are chosen from fixed literals; representationKey and all other values are bound.
      const result = await db.prepare(`SELECT ordinal, body FROM ${representationKey ? "safety_score_site_fragments" : "safety_score_public_fragments"}
        WHERE generation_id = ? AND projection_version = ? AND payload_sha256 = ?
        ${representationKey ? "AND representation_key = ?" : ""}
        AND ordinal >= ? AND ordinal < ? ORDER BY ordinal`).bind(...bindings).all<{ ordinal: number; body: string }>();
      if (!result.success || result.results.length !== end - offset) return unavailable("v9-public-fragments-missing");
      for (const fragment of result.results) {
        const expected = manifest.fragments[fragments.length];
        if (!expected || fragment.ordinal !== fragments.length || typeof fragment.body !== "string") return unavailable("v9-public-fragments-order-invalid");
        const size = Buffer.byteLength(fragment.body, "utf8");
        if (size !== expected.bytes || size > V9_PUBLIC_FRAGMENT_MAX_BYTES || sha256HexFromUtf8Chunks([fragment.body]) !== expected.sha256) return unavailable("v9-public-fragment-integrity-invalid");
        bytes += size;
        hash.update(fragment.body);
        fragments.push(fragment.body);
      }
      offset = end;
    }
    if (bytes !== manifest.bytes || hash.digest("hex") !== manifest.sha256) return unavailable("v9-public-body-integrity-invalid");
    const served = { publicationGenerationId: servedGenerationId, publishedAtSec: manifest.publishedAtSec };
    // Within the lag budget the previous generation is still the newest public
    // snapshot, so it carries the accepted health re-anchored to itself.
    const publicationHealth = lagging !== null && withinLagBudget &&
        health.acceptedPublicationGenerationId === identity.publicationGenerationId &&
        health.acceptedAtSec === row.publication_updated_at
      ? { ...health, acceptedPublicationGenerationId: served.publicationGenerationId, acceptedAtSec: served.publishedAtSec }
      : resolveSafetyScoreV9EffectivePublicationHealth(served, health);
    let position = -1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (position === -1) { controller.enqueue(encoder.encode(`{"publicationHealth":${JSON.stringify(publicationHealth)}`)); position = 0; }
        else if (position < fragments.length) { const text = fragments[position]!; fragments[position++] = ""; controller.enqueue(encoder.encode(text)); }
        else controller.close();
      },
      cancel() { fragments.length = 0; },
    });
    return { body, updatedAt: manifest.publishedAtSec, publicationHealth,
      representationIdentity: { version: manifest.version, generationId: servedGenerationId, sha256: manifest.sha256 } };
  } catch (error) {
    if (error instanceof V9PublicMaterializationUnavailableError) throw error;
    if (error instanceof Error && error.message.includes("publication-schema-cutover-pending")) return unavailable("publication-schema-cutover-pending");
    return unavailable("v9-public-materialization-read-failed");
  }
}
