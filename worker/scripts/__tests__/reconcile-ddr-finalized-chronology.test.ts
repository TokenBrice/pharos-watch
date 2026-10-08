import { describe, expect, it } from "vitest";
import { DDR_HASH_DOMAINS, stableJsonHashV1 } from "@shared/lib/depeg-resolver/hash";
import { buildDdrChronologyImport, reconcileDdrFinalizedChronology } from "../reconcile-ddr-finalized-chronology";
import { loadFirstPublicationMembership, writePublicationManifest } from "../../src/lib/depeg-resolver-publication-store";
import { sealPredictionFixture, sealedPayloadWithHash, withSqliteD1 } from "../../src/lib/__tests__/depeg-resolver-ddrv2-store.test-support";
import type { SqliteD1 } from "../../src/lib/__tests__/depeg-resolver-ddrv2-store.test-support";
import type { DdrSealedPublicPrediction } from "../../src/lib/depeg-resolver-publication-store";

function payload(
  prediction: DdrSealedPublicPrediction,
  { snapshotToken = "legacy", publishedAt = 200000 } = {},
) {
  const raw = sealedPayloadWithHash(prediction.incidentKey).payload;
  return {
    _meta: { publicPredictionIds: [prediction.id], publicPredictionRowHashes: { [prediction.id]: prediction.rowHash } },
    rows: [{ ...raw, prediction: { ...(raw.prediction as Record<string, unknown>), publicPredictionId: prediction.id, state: "frozen", publishedAt, publicationSnapshotToken: snapshotToken, snapshotGeneration: 2 } }],
  };
}
function legacy(
  db: SqliteD1,
  prediction: DdrSealedPublicPrediction,
  finalized: boolean,
  first = true,
  { snapshotToken = "legacy", sequence = 1, publishedAt = 200000 } = {},
) {
  const base = payload(prediction, { snapshotToken, publishedAt });
  const hash = stableJsonHashV1(DDR_HASH_DOMAINS.publicationManifest, base);
  const idsHash = stableJsonHashV1(DDR_HASH_DOMAINS.publicPredictionIds, [prediction.id]);
  db.sqlite.prepare(`INSERT INTO depeg_resolver_publication_snapshots
    (snapshot_token,snapshot_kind,snapshot_sequence,snapshot_generation,published_at,base_payload_hash,public_prediction_ids_hash,public_prediction_ids_json,public_prediction_row_hashes_json,base_payload_json,base_row_count,public_prediction_count,created_at)
    VALUES (?,'ddr_public',?,2,?,?,?, ?,?, ?,1,1,?)`)
    .run(snapshotToken, sequence, publishedAt, hash, idsHash, JSON.stringify([prediction.id]), JSON.stringify(base._meta.publicPredictionRowHashes), JSON.stringify(base), publishedAt);
  db.sqlite.prepare("INSERT INTO depeg_resolver_publication_snapshot_rows VALUES (?,?,?,?)").run(snapshotToken, prediction.id, prediction.incidentKey, first ? 1 : 0);
  if (finalized) db.sqlite.prepare(`INSERT INTO depeg_resolver_publication_snapshot_finalizations
    (snapshot_token,finalized_at,validator_version,validated_base_payload_hash,validated_public_prediction_ids_hash,validated_public_prediction_row_hashes_json,validated_base_row_count,validated_public_prediction_count)
    VALUES (?,?,'vitest',?,?,?,1,1)`).run(snapshotToken, publishedAt + 1, hash, idsHash, JSON.stringify(base._meta.publicPredictionRowHashes));
}

describe("DDR finalized chronology reconciliation", () => {
  it("losslessly imports old-only exposure and coalesces the identical bridge tuple", async () => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    legacy(db, prediction, true);
    const before = await loadFirstPublicationMembership(db);
    const packet = await reconcileDdrFinalizedChronology(db.sqlite);
    expect(packet.missing).toHaveLength(1);
    expect(packet.tuples[0]).toMatchObject({ snapshot_token: "legacy", published_at: 200000, finalized_at: 200001 });
    db.sqlite.exec(`BEGIN; ${buildDdrChronologyImport(packet.tuples, "a".repeat(64))} COMMIT;`);
    expect(await loadFirstPublicationMembership(db)).toEqual(before);
    expect((await reconcileDdrFinalizedChronology(db.sqlite)).missing).toEqual([]);
    // Replay is idempotent without INSERT OR IGNORE hiding contradictory data.
    db.sqlite.exec(`BEGIN; ${buildDdrChronologyImport(packet.tuples, "a".repeat(64))} COMMIT;`);
    expect(await loadFirstPublicationMembership(db)).toEqual(before);
  }));

  it("finds finalized legacy exposures when the first declaration was never finalized", async () => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    legacy(db, prediction, false, true, { snapshotToken: "never-finalized" });
    legacy(db, prediction, true, false, { sequence: 2, publishedAt: 200900 });
    const packet = await reconcileDdrFinalizedChronology(db.sqlite);
    expect(packet.tuples).toMatchObject([{ snapshot_token: "legacy", snapshot_sequence: 2, published_at: 200900, finalized_at: 200901 }]);
    expect(packet.neverFinalizedDeclarations).toHaveLength(1);
    expect(packet.suppressedMembershipRepairs).toHaveLength(1);
    expect(packet.missing).toHaveLength(1);
  }));

  it("does not turn a never-finalized declaration into exposure", async () => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    legacy(db, prediction, false);
    const packet = await reconcileDdrFinalizedChronology(db.sqlite);
    expect(packet.tuples).toEqual([]);
    expect(packet.neverFinalizedDeclarations).toHaveLength(1);
    expect(await loadFirstPublicationMembership(db)).toEqual([]);
  }));

  it.each([false, true])("repairs suppressed finalized v2/reference chronology (reference=%s)", async (reference) => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    legacy(db, prediction, false);
    const empty = { _meta: { publicPredictionIds: [], publicPredictionRowHashes: {} }, rows: [] };
    if (reference) {
      await writePublicationManifest(db, { snapshotToken: "payload", snapshotGeneration: 2, publishedAt: 200900, validatorVersion: "vitest", basePayload: payload(prediction) });
      // The first finalized exposure is still the payload, even if later unchanged publications use references.
      await writePublicationManifest(db, { snapshotToken: "reference", snapshotGeneration: 2, publishedAt: 201800, validatorVersion: "vitest", basePayload: payload(prediction) });
    } else {
      await writePublicationManifest(db, { snapshotToken: "empty", snapshotGeneration: 2, publishedAt: 200900, validatorVersion: "vitest", basePayload: empty });
      await writePublicationManifest(db, { snapshotToken: "visible", snapshotGeneration: 2, publishedAt: 201800, validatorVersion: "vitest", basePayload: payload(prediction) });
    }
    expect(await loadFirstPublicationMembership(db)).toEqual([]);
    const packet = await reconcileDdrFinalizedChronology(db.sqlite);
    expect(packet.suppressedMembershipRepairs).toHaveLength(1);
    expect(packet.tuples[0].snapshot_token).toBe(reference ? "payload" : "visible");
    db.sqlite.exec(`BEGIN; ${buildDdrChronologyImport(packet.tuples, "a".repeat(64))} COMMIT;`);
    expect(await loadFirstPublicationMembership(db)).toMatchObject([{ snapshotToken: reference ? "payload" : "visible" }]);
  }));

  it("rejects contradictory copies in both offline reconciliation and the live bridge", async () => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    legacy(db, prediction, true);
    db.sqlite.prepare(`INSERT INTO depeg_resolver_first_publications_v2 VALUES (?,?, 'legacy',1,2,200000,200002)`).run(prediction.id, prediction.incidentKey);
    await expect(loadFirstPublicationMembership(db)).rejects.toThrow(/Conflicting DDR/);
    await expect(reconcileDdrFinalizedChronology(db.sqlite)).rejects.toThrow(/Conflicting canonical/);
    const expected = [{ public_prediction_id: prediction.id, incident_key: prediction.incidentKey, snapshot_token: "legacy", snapshot_sequence: 1, snapshot_generation: 2, published_at: 200000, finalized_at: 200001 }];
    expect(() => db.sqlite.exec(buildDdrChronologyImport(expected, "a".repeat(64)))).toThrow(/CHECK/);
    expect(db.sqlite.prepare("SELECT finalized_at FROM depeg_resolver_first_publications_v2").get()).toEqual({ finalized_at: 200002 });
  }));

  it("accepts new-only canonical chronology without inventing an import", async () => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    await writePublicationManifest(db, { snapshotToken: "new", snapshotGeneration: 2, publishedAt: 200000, validatorVersion: "vitest", basePayload: payload(prediction) });
    const packet = await reconcileDdrFinalizedChronology(db.sqlite);
    expect(packet.missing).toEqual([]);
    expect(packet.tuples).toHaveLength(1);
  }));
});
