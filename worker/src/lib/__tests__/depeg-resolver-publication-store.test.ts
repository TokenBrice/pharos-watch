import { describe, expect, it } from "vitest";
import { DDR_HASH_DOMAINS, stableJsonHashV1 } from "@shared/lib/depeg-resolver/hash";
import {
  loadFirstPublicationMembership,
  loadLatestPublicationManifest,
  writePublicationManifest,
} from "../depeg-resolver-publication-store";
import {
  sealPredictionFixture,
  sealedPayloadWithHash,
  withSqliteD1,
  type SqliteD1,
} from "./depeg-resolver-ddrv2-store.test-support";

function count(db: SqliteD1, table: string): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function emptyBasePayload(clockSec: number) {
  return {
    _meta: {
      publicPredictionIds: [],
      publicPredictionRowHashes: {},
      lineage: {
        trainingWindow: { start: clockSec - 100000, end: clockSec },
        eventCount: 3,
        incidentCount: 1,
        coinCount: 1,
        quarantinedCoins: 0,
      },
    },
    rows: [],
    methodology: { version: "2.0", versionLabel: "v2.0", asOf: clockSec },
  };
}

describe("DDR publication payload storage", () => {
  it("references the prior payload when only the publication clock advanced", async () => withSqliteD1(async (db) => {
    const first = await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:1",
      snapshotGeneration: 2,
      publishedAt: 200000,
      validatorVersion: "vitest",
      basePayload: emptyBasePayload(200000),
    });
    const second = await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:2",
      snapshotGeneration: 2,
      publishedAt: 200900,
      validatorVersion: "vitest",
      basePayload: emptyBasePayload(200900),
    });

    expect(count(db, "depeg_resolver_publication_snapshots_v2")).toBe(1);
    expect(count(db, "depeg_resolver_publication_snapshot_refs")).toBe(1);
    expect(
      db.sqlite
        .prepare("SELECT payload_snapshot_token FROM depeg_resolver_publication_snapshot_refs WHERE snapshot_token = ?")
        .get("ddrpub:test:2"),
    ).toEqual({ payload_snapshot_token: "ddrpub:test:1" });
    expect(second.basePayloadHash).not.toBe(first.basePayloadHash);

    const latest = await loadLatestPublicationManifest(db);
    expect(latest).toMatchObject({ snapshotToken: "ddrpub:test:2", snapshotSequence: 2, basePayloadHash: second.basePayloadHash });
    const payload = JSON.parse(latest!.basePayloadJson) as {
      _meta: { lineage: { trainingWindow: { start: number; end: number } } };
      methodology: { asOf: number };
    };
    expect(payload.methodology.asOf).toBe(200900);
    expect(payload._meta.lineage.trainingWindow).toEqual({ start: 100900, end: 200900 });
    expect(stableJsonHashV1(DDR_HASH_DOMAINS.publicationManifest, payload)).toBe(latest!.basePayloadHash);
  }));

  it("stores a new payload when the published content changed", async () => withSqliteD1(async (db) => {
    await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:1",
      snapshotGeneration: 2,
      publishedAt: 200000,
      validatorVersion: "vitest",
      basePayload: emptyBasePayload(200000),
    });
    const changed = emptyBasePayload(200900);
    changed._meta.lineage.incidentCount = 2;
    await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:2",
      snapshotGeneration: 2,
      publishedAt: 200900,
      validatorVersion: "vitest",
      basePayload: changed,
    });

    expect(count(db, "depeg_resolver_publication_snapshots_v2")).toBe(2);
    expect(count(db, "depeg_resolver_publication_snapshot_refs")).toBe(0);
    expect(await loadLatestPublicationManifest(db)).toMatchObject({ snapshotToken: "ddrpub:test:2" });
  }));

  it("rejects a reference whose payload does not reconstruct the published hash", async () => withSqliteD1(async (db) => {
    await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:1",
      snapshotGeneration: 2,
      publishedAt: 200000,
      validatorVersion: "vitest",
      basePayload: emptyBasePayload(200000),
    });
    db.sqlite
      .prepare(
        `INSERT INTO depeg_resolver_publication_snapshot_refs
         (snapshot_token, snapshot_kind, snapshot_sequence, snapshot_generation, published_at,
          base_payload_hash, base_payload_content_hash, payload_snapshot_token, base_payload_clock_json,
          public_prediction_ids_hash, public_prediction_ids_json, public_prediction_row_hashes_json,
          base_row_count, public_prediction_count, created_at, finalized_at, validator_version)
         VALUES (?, 'ddr_public', 9, 2, 300000, ?, ?, 'ddrpub:test:1', '{"methodologyAsOf":300000}',
                 ?, '[]', '{}', 0, 0, 300000, 300000, 'vitest')`,
      )
      .run("ddrpub:test:tampered", "0".repeat(64), "1".repeat(64), "2".repeat(64));

    await expect(loadLatestPublicationManifest(db)).rejects.toThrow(/reconstruction does not match/);
  }));

  it("keeps the first-publication membership when an unchanged publication is a reference", async () => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    const raw = sealedPayloadWithHash(prediction.incidentKey).payload;
    const manifestRow = {
      ...raw,
      prediction: {
        ...(raw.prediction as Record<string, unknown>),
        publicPredictionId: prediction.id,
        state: "frozen",
        publishedAt: 200000,
        publicationSnapshotToken: "ddrpub:test:1",
        snapshotGeneration: 2,
      },
    };
    const basePayload = {
      _meta: { publicPredictionIds: [prediction.id], publicPredictionRowHashes: { [prediction.id]: prediction.rowHash } },
      rows: [manifestRow],
    };
    await writePublicationManifest(db, { snapshotToken: "ddrpub:test:1", snapshotGeneration: 2, publishedAt: 200000, validatorVersion: "vitest", basePayload });
    const second = await writePublicationManifest(db, { snapshotToken: "ddrpub:test:2", snapshotGeneration: 2, publishedAt: 200900, validatorVersion: "vitest", basePayload });

    expect(count(db, "depeg_resolver_publication_snapshots_v2")).toBe(1);
    expect(second).toMatchObject({ publicPredictionIds: [prediction.id], publicPredictionCount: 1 });
    expect(await loadFirstPublicationMembership(db, { publicPredictionIds: [prediction.id] })).toMatchObject([
      { snapshotToken: "ddrpub:test:1" },
    ]);
  }));

  it("rejects a reference-unaware allocator that would reuse a claimed publication sequence", async () => withSqliteD1(async (db) => {
    await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:1",
      snapshotGeneration: 2,
      publishedAt: 200000,
      validatorVersion: "vitest",
      basePayload: emptyBasePayload(200000),
    });
    await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:2",
      snapshotGeneration: 2,
      publishedAt: 200900,
      validatorVersion: "vitest",
      basePayload: emptyBasePayload(200900),
    });
    expect(count(db, "depeg_resolver_publication_snapshot_refs")).toBe(1);

    // The pre-reference Worker allocated the next sequence from the legacy and
    // compressed tables only. After a rollback that allocator computes 2, which
    // the reference row already claims, so the guard must abort the insert.
    const referenceUnawareAllocator = `(SELECT COALESCE(MAX(snapshot_sequence), 0) + 1
         FROM (
           SELECT snapshot_sequence FROM depeg_resolver_publication_snapshots WHERE snapshot_kind = 'ddr_public'
           UNION ALL
           SELECT snapshot_sequence FROM depeg_resolver_publication_snapshots_v2 WHERE snapshot_kind = 'ddr_public'
         ))`;
    expect(() =>
      db.sqlite
        .prepare(
          `INSERT INTO depeg_resolver_publication_snapshots_v2
           (snapshot_token, snapshot_kind, snapshot_sequence, snapshot_generation, published_at,
            base_payload_hash, base_payload_content_hash, public_prediction_ids_hash,
            public_prediction_ids_json, public_prediction_row_hashes_json, base_payload_gzip,
            base_payload_bytes, compressed_payload_bytes, base_row_count, public_prediction_count,
            created_at, finalized_at, validator_version)
           VALUES (?, 'ddr_public', ${referenceUnawareAllocator}, 2, 300000, ?, ?, ?, '[]', '{}', ?, 1, 1, 0, 0, 300000, 300000, 'vitest')`,
        )
        .run("ddrpub:test:rollback", "3".repeat(64), "4".repeat(64), "5".repeat(64), new Uint8Array([0x1f])),
    ).toThrow(/snapshot_sequence is already claimed by another publication table/);

    // The guard is symmetric: a reference row cannot claim a compressed row's
    // sequence either.
    expect(() =>
      db.sqlite
        .prepare(
          `INSERT INTO depeg_resolver_publication_snapshot_refs
           (snapshot_token, snapshot_kind, snapshot_sequence, snapshot_generation, published_at,
            base_payload_hash, base_payload_content_hash, payload_snapshot_token, base_payload_clock_json,
            public_prediction_ids_hash, public_prediction_ids_json, public_prediction_row_hashes_json,
            base_row_count, public_prediction_count, created_at, finalized_at, validator_version)
           VALUES (?, 'ddr_public', 1, 2, 300000, ?, ?, 'ddrpub:test:1', '{"methodologyAsOf":300000}',
                   ?, '[]', '{}', 0, 0, 300000, 300000, 'vitest')`,
        )
        .run("ddrpub:test:colliding-ref", "6".repeat(64), "7".repeat(64), "8".repeat(64)),
    ).toThrow(/snapshot_sequence is already claimed by another publication table/);

    // The current three-table allocator still publishes past the reference.
    const changed = emptyBasePayload(301800);
    changed._meta.lineage.incidentCount = 2;
    const next = await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:3",
      snapshotGeneration: 2,
      publishedAt: 301800,
      validatorVersion: "vitest",
      basePayload: changed,
    });
    expect(next.snapshotSequence).toBe(3);
  }));
});
