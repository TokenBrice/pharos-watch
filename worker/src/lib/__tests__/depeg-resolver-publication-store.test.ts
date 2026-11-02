import { describe, expect, it, vi } from "vitest";
import { DDR_HASH_DOMAINS, stableJsonHashV1 } from "@shared/lib/depeg-resolver/hash";
import { computeDdrPublicRowHash } from "@shared/lib/depeg-resolver/public-contract";
import { DdrForecastReadinessBackstopSchema, DdrForecastReadinessSchema } from "@shared/types/depeg-resolver";
import {
  loadSealedPublicPredictions,
  loadFirstPublicationMembership,
  loadLatestPublicationManifest,
  writePublicationManifest,
} from "../depeg-resolver-publication-store";
import {
  ensureIncident,
  insertOpenEvent,
  sealPublicFixture,
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
  it.each(["prediction", "no_call"] as const)("refuses malformed %s outcomes at sealed JSON admission", async (kind) => withSqliteD1(async (db) => {
    insertOpenEvent(db);
    const incident = await ensureIncident(db);
    const sealed = await sealPublicFixture(db, incident.incidentKey, kind);
    const payload = JSON.parse(sealed.sealedPayloadJson);
    if (kind === "prediction") delete payload.frozen.duration.remainingAsOf;
    else payload.noCall.missingReasons = [null, 17];
    db.sqlite.exec("DROP TRIGGER trg_ddr_public_predictions_no_update");
    db.sqlite.prepare("UPDATE depeg_resolver_public_predictions SET sealed_payload_json = ? WHERE id = ?")
      .run(JSON.stringify(payload), sealed.id);
    await expect(loadSealedPublicPredictions(db, { publicPredictionIds: [sealed.id] })).rejects.toThrow();
    payload.kind = kind === "prediction" ? "no_call" : "prediction";
    db.sqlite.exec("PRAGMA ignore_check_constraints = ON");
    db.sqlite.prepare("UPDATE depeg_resolver_public_predictions SET sealed_payload_json = ? WHERE id = ?")
      .run(JSON.stringify(payload), sealed.id);
    await expect(loadSealedPublicPredictions(db, { publicPredictionIds: [sealed.id] })).rejects.toThrow(/kind does not match/);
  }));

  it.each(["prediction", "no_call"] as const)("retains historical %s bytes, optional fields and retired safety context", async (kind) => withSqliteD1(async (db) => {
    insertOpenEvent(db);
    const incident = await ensureIncident(db);
    const sealed = await sealPublicFixture(db, incident.incidentKey, kind);
    const payload = JSON.parse(sealed.sealedPayloadJson);
    const outcome = kind === "prediction" ? payload.frozen : payload.noCall;
    outcome.relatedContext.safetyContext = { status: "retired-identified", reason: null, identity: null };
    outcome.archivedField = { retained: true };
    payload.prediction.readiness = { score: 0.8, version: "historical-readiness", threshold: 0.75 };
    payload.prediction.backstop = { backstopAt: 300000, delaySec: 259200 };
    // Historical admission must not relax the current public metadata schemas.
    expect(DdrForecastReadinessSchema.safeParse(payload.prediction.readiness).success).toBe(false);
    expect(DdrForecastReadinessBackstopSchema.safeParse(payload.prediction.backstop).success).toBe(false);
    const rowHash = computeDdrPublicRowHash(payload);
    payload.prediction.rowHash = rowHash;
    const json = JSON.stringify(payload, null, 2);
    db.sqlite.exec("DROP TRIGGER trg_ddr_public_predictions_no_update");
    db.sqlite.prepare("UPDATE depeg_resolver_public_predictions SET sealed_payload_json = ?, row_hash = ? WHERE id = ?")
      .run(json, rowHash, sealed.id);
    const [loaded] = await loadSealedPublicPredictions(db, { publicPredictionIds: [sealed.id] });
    expect(loaded).toMatchObject({ outcomeKind: kind, sealedPayloadJson: json, rowHash });
    expect(loaded?.sealedPayload).toEqual(payload);
    expect(computeDdrPublicRowHash(loaded?.sealedPayload)).toBe(rowHash);
  }));

  it.each(["prediction", "no_call"] as const)("rejects invalid historical %s readiness and backstop values", async (kind) => withSqliteD1(async (db) => {
    insertOpenEvent(db);
    const incident = await ensureIncident(db);
    const sealed = await sealPublicFixture(db, incident.incidentKey, kind);
    db.sqlite.exec("DROP TRIGGER trg_ddr_public_predictions_no_update");
    for (const metadata of [
      { readiness: { score: 1.1 } },
      { readiness: { strictEarlyLockReady: "true" } },
      { backstop: { delaySec: -1 } },
      { backstop: { reached: "true" } },
    ]) {
      const payload = JSON.parse(sealed.sealedPayloadJson);
      Object.assign(payload.prediction, metadata);
      db.sqlite.prepare("UPDATE depeg_resolver_public_predictions SET sealed_payload_json = ? WHERE id = ?")
        .run(JSON.stringify(payload), sealed.id);
      await expect(loadSealedPublicPredictions(db, { publicPredictionIds: [sealed.id] })).rejects.toThrow();
    }
  }));

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

    const prepare = vi.spyOn(db, "prepare");
    const latest = await loadLatestPublicationManifest(db);
    expect(latest).toMatchObject({ snapshotToken: "ddrpub:test:2", snapshotSequence: 2, basePayloadHash: second.basePayloadHash });
    const payload = JSON.parse(latest!.basePayloadJson) as {
      _meta: { lineage: { trainingWindow: { start: number; end: number } } };
      methodology: { asOf: number };
    };
    expect(payload.methodology.asOf).toBe(200900);
    expect(payload._meta.lineage.trainingWindow).toEqual({ start: 100900, end: 200900 });
    expect(stableJsonHashV1(DDR_HASH_DOMAINS.publicationManifest, payload)).toBe(latest!.basePayloadHash);
    for (const [table, index] of [
      ["depeg_resolver_publication_snapshots_v2", "idx_ddr_publication_snapshots_v2_published"],
      ["depeg_resolver_publication_snapshot_refs", "idx_ddr_publication_snapshot_refs_published"],
    ] as const) {
      const query = prepare.mock.calls.find(([sql]) => sql.includes(`FROM ${table} s`) && sql.includes("ORDER BY"))?.[0];
      expect(query).toBeDefined();
      const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes(index))).toBe(true);
      expect(plan.some((row) => row.detail.includes("USE TEMP B-TREE"))).toBe(false);
    }
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

  it("stores a fresh payload instead of citing an invalidated payload snapshot", async () => withSqliteD1(async (db) => {
    await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:1",
      snapshotGeneration: 2,
      publishedAt: 200000,
      validatorVersion: "vitest",
      basePayload: emptyBasePayload(200000),
    });
    db.sqlite
      .prepare(
        `INSERT INTO depeg_resolver_publication_snapshot_errata
         (snapshot_token, reason, operator_note, created_at, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("ddrpub:test:1", "operator_invalidation", "test", 200001, "vitest");

    await writePublicationManifest(db, {
      snapshotToken: "ddrpub:test:2",
      snapshotGeneration: 2,
      publishedAt: 200900,
      validatorVersion: "vitest",
      basePayload: emptyBasePayload(200900),
    });

    expect(count(db, "depeg_resolver_publication_snapshots_v2")).toBe(2);
    expect(count(db, "depeg_resolver_publication_snapshot_refs")).toBe(0);
    expect(await loadLatestPublicationManifest(db)).toMatchObject({ snapshotToken: "ddrpub:test:2" });
  }));

  it("does not serve an existing reference to an invalidated payload snapshot", async () => withSqliteD1(async (db) => {
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
    db.sqlite
      .prepare(
        `INSERT INTO depeg_resolver_publication_snapshot_errata
         (snapshot_token, reason, operator_note, created_at, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("ddrpub:test:1", "operator_invalidation", "test", 200901, "vitest");

    expect(await loadLatestPublicationManifest(db)).toBeNull();
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
