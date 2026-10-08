import { createHash } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { DDR_HASH_DOMAINS, stableJsonHashV1, stableJsonStringifyV1 } from "@shared/lib/depeg-resolver/hash";
import { computeDdrPublicRowHash } from "@shared/lib/depeg-resolver/public-contract";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { loadPublicationManifestByToken } from "../src/lib/depeg-resolver-publication-store";
import { parseStrictCliArgs, runCliEntrypoint } from "../../scripts/lib/cli-args.mjs";
import { sqlString } from "./lib/remote-d1";

const COLUMNS = ["public_prediction_id", "incident_key", "snapshot_token", "snapshot_sequence", "snapshot_generation", "published_at", "finalized_at"] as const;
interface Tuple {
  public_prediction_id: number;
  incident_key: string;
  snapshot_token: string;
  snapshot_sequence: number;
  snapshot_generation: number;
  published_at: number;
  finalized_at: number;
}
const FINALIZED = `SELECT s.snapshot_token, s.snapshot_sequence, s.snapshot_generation, s.published_at, f.finalized_at
 FROM depeg_resolver_publication_snapshots s JOIN depeg_resolver_publication_snapshot_finalizations f USING(snapshot_token)
 UNION ALL SELECT snapshot_token, snapshot_sequence, snapshot_generation, published_at, finalized_at FROM depeg_resolver_publication_snapshots_v2
 UNION ALL SELECT snapshot_token, snapshot_sequence, snapshot_generation, published_at, finalized_at FROM depeg_resolver_publication_snapshot_refs`;
const MANIFEST_IDS = `SELECT snapshot_token, public_prediction_ids_json FROM depeg_resolver_publication_snapshots
 UNION ALL SELECT snapshot_token, public_prediction_ids_json FROM depeg_resolver_publication_snapshots_v2
 UNION ALL SELECT snapshot_token, public_prediction_ids_json FROM depeg_resolver_publication_snapshot_refs`;
const equal = (a: Tuple, b: Tuple) => COLUMNS.every((key) => a[key] === b[key]);
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Read-only, complete offline reconciliation. A failed tuple/hash never produces import SQL. */
export async function reconcileDdrFinalizedChronology(sqlite: DatabaseSync) {
  const db = createSqliteD1(sqlite);
  const earliest = new Map<number, Tuple>();
  const tokens = new Set<string>();
  const sequences = new Set<number>();
  const manifests: { snapshotToken: string; payloadHash: string; payloadBytes: number; predictionCount: number }[] = [];
  // iterate keeps payload residency bounded to one publication, not the whole archive.
  for (const raw of sqlite.prepare(`${FINALIZED} ORDER BY published_at, snapshot_sequence`).iterate()) {
    const row = raw as Omit<Tuple, "public_prediction_id" | "incident_key">;
    requireEvidence(!tokens.has(row.snapshot_token) && !sequences.has(row.snapshot_sequence), "Duplicate publication identity or sequence");
    tokens.add(row.snapshot_token); sequences.add(row.snapshot_sequence);
    const manifest = await loadPublicationManifestByToken(db, row.snapshot_token);
    requireEvidence(manifest, `Unresolvable finalized token ${row.snapshot_token}`);
    requireEvidence(manifest.snapshotSequence === row.snapshot_sequence && manifest.snapshotGeneration === row.snapshot_generation && manifest.publishedAt === row.published_at && manifest.finalizedAt === row.finalized_at, `Manifest tuple drift ${row.snapshot_token}`);
    const payload = JSON.parse(manifest.basePayloadJson) as { rows?: unknown[]; _meta?: { publicPredictionIds?: number[]; publicPredictionRowHashes?: Record<string, string> } };
    requireEvidence(stableJsonHashV1(DDR_HASH_DOMAINS.publicationManifest, payload) === manifest.basePayloadHash, `Payload hash mismatch ${row.snapshot_token}`);
    requireEvidence(stableJsonHashV1(DDR_HASH_DOMAINS.publicPredictionIds, manifest.publicPredictionIds) === manifest.publicPredictionIdsHash, `ID hash mismatch ${row.snapshot_token}`);
    requireEvidence(Array.isArray(payload.rows) && payload.rows.length === manifest.baseRowCount && manifest.publicPredictionIds.length === manifest.publicPredictionCount && new Set(manifest.publicPredictionIds).size === manifest.publicPredictionCount, `Publication row/count mismatch ${row.snapshot_token}`);
    requireEvidence(stableJsonStringifyV1(payload._meta?.publicPredictionIds) === stableJsonStringifyV1(manifest.publicPredictionIds) && stableJsonStringifyV1(payload._meta?.publicPredictionRowHashes) === stableJsonStringifyV1(manifest.publicPredictionRowHashes), `Payload membership mismatch ${row.snapshot_token}`);
    const finalization = sqlite.prepare("SELECT * FROM depeg_resolver_publication_snapshot_finalizations WHERE snapshot_token = ?").get(row.snapshot_token);
    if (finalization) {
      requireEvidence(finalization.validated_base_payload_hash === manifest.basePayloadHash && finalization.validated_public_prediction_ids_hash === manifest.publicPredictionIdsHash && finalization.validated_base_row_count === manifest.baseRowCount && finalization.validated_public_prediction_count === manifest.publicPredictionCount && stableJsonStringifyV1(JSON.parse(String(finalization.validated_public_prediction_row_hashes_json))) === stableJsonStringifyV1(manifest.publicPredictionRowHashes), `Legacy finalization validation mismatch ${row.snapshot_token}`);
      const declared = sqlite.prepare("SELECT public_prediction_id, incident_key FROM depeg_resolver_publication_snapshot_rows WHERE snapshot_token = ? ORDER BY public_prediction_id").all(row.snapshot_token) as { public_prediction_id: number; incident_key: string }[];
      requireEvidence(stableJsonStringifyV1(declared.map((entry) => entry.public_prediction_id)) === stableJsonStringifyV1([...manifest.publicPredictionIds].sort((a, b) => a - b)), `Legacy row-set mismatch ${row.snapshot_token}`);
      for (const entry of declared) {
        const prediction = sqlite.prepare("SELECT incident_key FROM depeg_resolver_public_predictions WHERE id = ?").get(entry.public_prediction_id);
        requireEvidence(prediction?.incident_key === entry.incident_key, `Legacy incident mismatch ${entry.public_prediction_id}`);
      }
    }
    const publicRows = new Map<number, Record<string, unknown>>();
    for (const rawRow of payload.rows) {
      requireEvidence(rawRow && typeof rawRow === "object", `Invalid publication row ${row.snapshot_token}`);
      const publicRow = rawRow as Record<string, unknown>;
      const predictionMeta = publicRow.prediction as Record<string, unknown> | undefined;
      const id = predictionMeta?.publicPredictionId;
      if (id == null) continue;
      requireEvidence(typeof id === "number" && !publicRows.has(id), `Invalid/duplicate public row identity ${row.snapshot_token}`);
      requireEvidence(computeDdrPublicRowHash(publicRow) === manifest.publicPredictionRowHashes[String(id)], `Published row hash mismatch ${id}`);
      publicRows.set(id, publicRow);
    }
    requireEvidence(publicRows.size === manifest.publicPredictionCount, `Published row set mismatch ${row.snapshot_token}`);
    for (const id of manifest.publicPredictionIds) {
      const prediction = sqlite.prepare("SELECT incident_key, row_hash FROM depeg_resolver_public_predictions WHERE id = ?").get(id);
      requireEvidence(prediction && manifest.publicPredictionRowHashes[String(id)] === prediction.row_hash, `Prediction identity/hash mismatch ${id} at ${row.snapshot_token}; resolve errata before import`);
      requireEvidence(publicRows.get(id)?.incidentKey === prediction.incident_key, `Published incident mismatch ${id}`);
      if (!earliest.has(id)) earliest.set(id, { public_prediction_id: id, incident_key: String(prediction.incident_key), ...row });
    }
    manifests.push({ snapshotToken: row.snapshot_token, payloadHash: manifest.basePayloadHash, payloadBytes: Buffer.byteLength(manifest.basePayloadJson), predictionCount: manifest.publicPredictionCount });
  }
  const canonical = sqlite.prepare(`SELECT ${COLUMNS.join(",")} FROM depeg_resolver_first_publications_v2 ORDER BY public_prediction_id`).all() as unknown as Tuple[];
  for (const row of canonical) requireEvidence(earliest.has(row.public_prediction_id) && equal(row, earliest.get(row.public_prediction_id)!), `Conflicting canonical chronology ${row.public_prediction_id}`);
  const legacyDeclarations = sqlite.prepare(`SELECT r.public_prediction_id, r.incident_key, r.snapshot_token, s.snapshot_sequence, s.snapshot_generation, s.published_at, f.finalized_at, r.first_published
    FROM depeg_resolver_publication_snapshot_rows r JOIN depeg_resolver_publication_snapshots s USING(snapshot_token)
    LEFT JOIN depeg_resolver_publication_snapshot_finalizations f USING(snapshot_token)`).all() as unknown as (Omit<Tuple, "finalized_at"> & { finalized_at: number | null; first_published: number })[];
  const legacyFirst = legacyDeclarations.filter((row) => row.first_published === 1);
  for (const row of legacyFirst) if (row.finalized_at != null) requireEvidence(earliest.has(row.public_prediction_id) && equal(row as Tuple, earliest.get(row.public_prediction_id)!), `Conflicting finalized legacy first declaration ${row.public_prediction_id}`);
  const canonicalIds = new Set(canonical.map((row) => row.public_prediction_id));
  const tuples = [...earliest.values()].sort((a, b) => a.public_prediction_id - b.public_prediction_id);
  const snapshotErrata = sqlite.prepare("SELECT * FROM depeg_resolver_publication_snapshot_errata ORDER BY id").all();
  for (const erratum of snapshotErrata) {
    // Public publication identities are archive references, not authentication secrets.
    for (const snapshotToken of [erratum.snapshot_token, erratum.superseded_by_snapshot_token]) {
      if (snapshotToken == null) continue;
      requireEvidence(typeof snapshotToken === "string" && sqlite.prepare(`SELECT 1 FROM (${MANIFEST_IDS}) WHERE snapshot_token = ?`).get(snapshotToken), `Unresolvable snapshot erratum ${erratum.id}`);
    }
  }
  const predictionErrata = sqlite.prepare("SELECT * FROM depeg_resolver_prediction_errata ORDER BY id").all();
  for (const erratum of predictionErrata) {
    const prediction = sqlite.prepare("SELECT incident_key, event_id, assessment_id FROM depeg_resolver_public_predictions WHERE id = ?").get(erratum.public_prediction_id);
    requireEvidence(prediction?.incident_key === erratum.incident_key && prediction.event_id === erratum.event_id && prediction.assessment_id === erratum.assessment_id, `Unresolvable prediction erratum ${erratum.id}`);
    if (erratum.replacement_assessment_id != null) requireEvidence(sqlite.prepare("SELECT 1 FROM depeg_resolver_assessments WHERE id = ?").get(erratum.replacement_assessment_id), `Missing replacement assessment for erratum ${erratum.id}`);
  }
  return {
    tuples, missing: tuples.filter((row) => !canonicalIds.has(row.public_prediction_id)), manifests,
    neverFinalizedDeclarations: legacyDeclarations.filter((row) => row.finalized_at == null),
    suppressedMembershipRepairs: tuples.filter((row) => !canonicalIds.has(row.public_prediction_id) && legacyFirst.some((entry) => entry.public_prediction_id === row.public_prediction_id && entry.finalized_at == null)),
    snapshotErrata,
    predictionErrata,
    finalizedPublicationCount: manifests.length,
    reconstructedPayloadBytes: manifests.reduce((sum, row) => sum + row.payloadBytes, 0),
  };
}

/** Reviewed append-only import proposal, never executes. All conflicts checked before first write. */
export function buildDdrChronologyImport(tuples: Tuple[], evidenceSha256: string): string {
  requireEvidence(/^[0-9a-f]{64}$/.test(evidenceSha256), "Invalid evidence hash");
  const values = tuples.map((row) => `(${COLUMNS.map((key) => typeof row[key] === "string" ? sqlString(row[key]) : row[key]).join(",")})`);
  const mismatch = COLUMNS.map((key) => `c.${key} IS NOT e.${key}`).join(" OR ");
  const sourceMismatch = COLUMNS.filter((key) => key !== "public_prediction_id" && key !== "incident_key").map((key) => `s.${key} IS NOT e.${key}`).join(" OR ");
  return [
    "-- rollout-safety: backward-compatible", "-- data-migration: reviewed", `-- Offline evidence SHA-256: ${evidenceSha256}`,
    "-- Apply only after bridge-aware Worker floor, owner review and pre-window bookmark.",
    `CREATE TEMP TABLE ddr_chronology_expected (${COLUMNS.join(",")}, PRIMARY KEY(public_prediction_id));`,
    ...values.map((value) => `INSERT INTO ddr_chronology_expected VALUES ${value};`),
    "CREATE TEMP TABLE ddr_chronology_guard (ok INTEGER CHECK(ok = 1));",
    `INSERT INTO ddr_chronology_guard SELECT NOT EXISTS (SELECT 1 FROM depeg_resolver_first_publications_v2 c LEFT JOIN ddr_chronology_expected e USING(public_prediction_id) WHERE e.public_prediction_id IS NULL OR ${mismatch});`,
    `INSERT INTO ddr_chronology_guard SELECT NOT EXISTS (SELECT 1 FROM ddr_chronology_expected e LEFT JOIN (${FINALIZED}) s ON s.snapshot_token=e.snapshot_token LEFT JOIN depeg_resolver_public_predictions p ON p.id=e.public_prediction_id WHERE s.snapshot_token IS NULL OR p.incident_key IS NOT e.incident_key OR ${sourceMismatch});`,
    `INSERT INTO ddr_chronology_guard WITH exposures AS (
      SELECT CAST(ids.value AS INTEGER) public_prediction_id, p.incident_key, s.*,
        ROW_NUMBER() OVER (PARTITION BY ids.value ORDER BY s.published_at, s.snapshot_sequence) exposure_rank
      FROM (${FINALIZED}) s JOIN (${MANIFEST_IDS}) m USING(snapshot_token)
      JOIN json_each(m.public_prediction_ids_json) ids
      JOIN depeg_resolver_public_predictions p ON p.id=CAST(ids.value AS INTEGER)
    ) SELECT NOT EXISTS (SELECT 1 FROM exposures c LEFT JOIN ddr_chronology_expected e USING(public_prediction_id)
      WHERE c.exposure_rank=1 AND (e.public_prediction_id IS NULL OR ${mismatch}))
      AND (SELECT COUNT(*) FROM exposures WHERE exposure_rank=1)=${tuples.length};`,
    `INSERT INTO depeg_resolver_first_publications_v2 (${COLUMNS.join(",")}) SELECT ${COLUMNS.map((key) => `e.${key}`).join(",")} FROM ddr_chronology_expected e WHERE NOT EXISTS (SELECT 1 FROM depeg_resolver_first_publications_v2 c WHERE c.public_prediction_id=e.public_prediction_id);`,
    `INSERT INTO ddr_chronology_guard SELECT (SELECT COUNT(*) FROM depeg_resolver_first_publications_v2) = ${tuples.length};`,
    "DROP TABLE temp.ddr_chronology_guard;", "DROP TABLE temp.ddr_chronology_expected;", "",
  ].join("\n");
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseStrictCliArgs(argv, { options: { sqlite: { type: "string" }, report: { type: "string" }, sql: { type: "string" } } });
  if (values.help) { console.log("Usage: tsx worker/scripts/reconcile-ddr-finalized-chronology.ts --sqlite <frozen-export.sqlite> --report <packet.json> --sql <reviewed-proposal.sql>\nOffline read-only reconciliation; never executes SQL or accesses production."); return; }
  requireEvidence(typeof values.sqlite === "string" && typeof values.report === "string" && typeof values.sql === "string", "--sqlite, --report and --sql are required");
  requireEvidence(new Set([values.sqlite, values.report, values.sql].map((path) => resolve(path))).size === 3, "Archive/report/SQL paths must be distinct");
  const archiveHash = createHash("sha256");
  for await (const chunk of createReadStream(values.sqlite)) archiveHash.update(chunk);
  const archiveSha256 = archiveHash.digest("hex");
  const sqlite = new DatabaseSync(values.sqlite, { readOnly: true });
  try {
    const report = { archiveSha256, ...await reconcileDdrFinalizedChronology(sqlite) };
    const bytes = stableJsonStringifyV1(report) + "\n";
    const hash = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(values.report, bytes);
    writeFileSync(values.sql, buildDdrChronologyImport(report.tuples, hash));
  } finally { sqlite.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCliEntrypoint(() => main(process.argv.slice(2)));
