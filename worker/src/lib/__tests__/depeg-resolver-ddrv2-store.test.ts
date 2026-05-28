import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { ensureCanonicalIncidents, recordLockOpportunity } from "../depeg-resolver-incident-store";
import {
  loadFirstPublicationMembership,
  sealPublicNoCall,
  sealPublicPrediction,
  writePublicationManifest,
} from "../depeg-resolver-publication-store";
import { appendPredictionErratum } from "../depeg-resolver-errata-store";
import { authorizeEventRepair, consumeEventRepairAuthorization } from "../depeg-resolver-repair-store";
import { attachDdrPublicRowHash, computeDdrPublicRowHash } from "@shared/lib/depeg-resolver/public-contract";

const MIGRATIONS_DIR = join(process.cwd(), "worker/migrations");
interface SqliteD1 extends D1Database {
  close(): void;
  sqlite: DatabaseSync;
}

function applyMigrations(db: DatabaseSync): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((entry) => entry.endsWith(".sql")).sort()) {
    // Test-only migration replay must load every migration file from the repo-controlled migration directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

function makeSqliteD1(): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);

  function statement(sql: string, binds: unknown[] = []): D1PreparedStatement {
    const run = () => {
      const result = sqlite.prepare(sql).run(...(binds as never[]));
      return {
        success: true,
        meta: {
          changes: result.changes,
          last_row_id: Number(result.lastInsertRowid ?? 0),
        },
      };
    };
    return {
      bind: (...nextBinds: unknown[]) => statement(sql, nextBinds),
      run: async () => run(),
      first: async <T>() => (sqlite.prepare(sql).get(...(binds as never[])) ?? null) as T | null,
      all: async <T>() => ({
        results: sqlite.prepare(sql).all(...(binds as never[])) as T[],
        success: true,
        meta: {},
      }),
      raw: async () => sqlite.prepare(sql).all(...(binds as never[])) as unknown as unknown[][],
    } as unknown as D1PreparedStatement;
  }

  return {
    sqlite,
    prepare: (sql: string) => statement(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        sqlite.exec("COMMIT");
        return results as Awaited<ReturnType<D1Database["batch"]>>;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    close: () => sqlite.close(),
  } as SqliteD1;
}

function insertOpenEvent(db: SqliteD1, eventId = 1): void {
  db.sqlite
    .prepare(
      `INSERT INTO depeg_events
       (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
        started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
       VALUES (?, 'lusd-liquity', 'LUSD', 'peggedUSD', 'below', -300, 100000, NULL, 0.98, 0.97, NULL, 1, 'live')`,
    )
    .run(eventId);
}

async function ensureIncident(db: SqliteD1, eventId = 1) {
  const [incident] = await ensureCanonicalIncidents(
    db,
    [
      {
        eventId,
        stablecoinId: "lusd-liquity",
        pegCurrency: "USD",
        direction: "below",
        startedAt: 100000,
        peakDeviationBps: -300,
        source: "live",
        publicTrackedAtFirstSeen: true,
        registrySnapshot: { id: "lusd-liquity", symbol: "LUSD" },
      },
    ],
    {
      nowSec: 200000,
      predictionPolicyVersion: "sticky-24h-v1",
      ddrV2EffectiveAt: 90000,
      createdBy: "vitest",
    },
  );
  if (!incident) throw new Error("incident was not created");
  return incident;
}

function sealedPayload(incidentKey: string, kind: "prediction" | "no_call" = "prediction") {
  const base = {
    kind,
    eventId: 1,
    incidentKey,
    stablecoinId: "lusd-liquity",
    symbol: "LUSD",
    name: "Liquity USD",
    pegCurrency: "USD",
    governance: "decentralized",
    status: "active",
    direction: "below",
    startedAt: 100000,
    prediction: {
      incidentKey,
      eligibleAt: 186400,
      lockedAt: 186400,
      eventAgeAtLockSec: 86400,
      lockTiming: "on_time",
      policyDelaySec: 86400,
      predictionPolicyVersion: "sticky-24h-v1",
      predictionMethodologyVersion: "2.0",
      resolutionRubricVersion: "resolution-rubric-v2",
      durationModelVersion: "duration-landmark-v2",
      incidentGroupingVersion: "incident-group-v2",
      supportRulesVersion: "support-rules-v2",
    },
  };
  return kind === "prediction"
    ? {
        ...base,
        frozen: {
          resolution: { tier: "at_risk", factors: [] },
          duration: { suppressed: false, horizons: [] },
          relatedContext: {},
          sourceRow: { eventId: 1, stablecoinId: "lusd-liquity" },
        },
      }
    : {
        ...base,
        noCall: {
          lockedAt: 186400,
          eventAgeAtLockSec: 86400,
          missingReasons: ["insufficient_signal"],
          relatedContext: {},
        },
        frozen: null,
      };
}

function sealedPayloadWithHash(incidentKey: string, kind: "prediction" | "no_call" = "prediction") {
  const payload = sealedPayload(incidentKey, kind);
  const rowHash = computeDdrPublicRowHash(payload);
  return { payload: attachDdrPublicRowHash(payload, rowHash), rowHash };
}

async function sealPredictionFixture(db: SqliteD1) {
  insertOpenEvent(db);
  const incident = await ensureIncident(db);
  const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey);
  const prediction = await sealPublicPrediction(db, {
    incidentKey: incident.incidentKey,
    eventId: 1,
    stablecoinId: "lusd-liquity",
    symbol: "LUSD",
    name: "Liquity USD",
    pegCurrency: "USD",
    governance: "decentralized",
    direction: "below",
    startedAt: 100000,
    assessedAt: 186400,
    eventAgeSec: 86400,
    methodologyVersion: "2.0",
    methodologyVersionLabel: "v2.0",
    resolutionRubricVersion: "resolution-rubric-v2",
    durationModelVersion: "duration-landmark-v2",
    incidentGroupingVersion: "incident-group-v2",
    supportRulesVersion: "support-rules-v2",
    resolutionTier: "at_risk",
    durationSuppressed: false,
    durationSuppressedReason: null,
    medianRemainingSec: 7200,
    iqrLowRemainingSec: 3600,
    iqrHighRemainingSec: 14400,
    stratum: "below",
    horizons: [],
    factors: [],
    sealedPayload: payload,
    rowHash,
    predictionPolicyVersion: "sticky-24h-v1",
    policyDelaySec: 86400,
    eligibleAt: 186400,
    lockedAt: 186400,
    eventAgeAtLockSec: 86400,
    lockTiming: "on_time",
    createdAt: 186401,
    runId: "ddr:test",
  });
  return { incident, prediction };
}

describe("DDRv2 storage migrations and stores", () => {
  it("replaces the monolithic public-prediction guard with split triggers", () => {
    const db = makeSqliteD1();
    try {
      const rows = db.sqlite
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'trigger'
             AND tbl_name = 'depeg_resolver_public_predictions'`,
        )
        .all() as { name: string }[];
      const names = new Set(rows.map((row) => row.name));

      expect(names.has("trg_ddr_public_predictions_assessment_guard")).toBe(false);
      expect([...names]).toEqual(expect.arrayContaining([
        "trg_ddr_public_predictions_relational_guard",
        "trg_ddr_public_predictions_version_guard",
        "trg_ddr_public_predictions_payload_identity_guard",
        "trg_ddr_public_predictions_payload_prediction_guard",
        "trg_ddr_public_predictions_prediction_kind_guard",
        "trg_ddr_public_predictions_no_call_kind_guard",
      ]));
    } finally {
      db.close();
    }
  });

  it("bootstraps canonical incidents with immutable links and policy membership", async () => {
    const db = makeSqliteD1();
    try {
      const incident = await ensureIncident(db);

      expect(incident.incidentKey).toMatch(/^ddr2:[0-9a-f]{32}$/);
      expect(incident.policyMembership?.policyUniverseIncluded).toBe(true);
      expect(incident.policyMembership?.policyUniverseReason).toBe("post_effective_public_tracked");
      expect(() =>
        db.sqlite.exec("UPDATE depeg_resolver_incident_event_links SET relation = 'merged' WHERE event_id = 1"),
      ).toThrow(/incident event links are append-only/);

      const [again] = await ensureCanonicalIncidents(
        db,
        [
          {
            eventId: 1,
            stablecoinId: "lusd-liquity",
            pegCurrency: "USD",
            direction: "below",
            startedAt: 100000,
            peakDeviationBps: -300,
            source: "live",
          },
        ],
        { nowSec: 200100, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000 },
      );
      expect(again?.incidentKey).toBe(incident.incidentKey);
    } finally {
      db.close();
    }
  });

  it("seals exactly one public prediction and makes the assessment immutable", async () => {
    const db = makeSqliteD1();
    try {
      const { incident, prediction } = await sealPredictionFixture(db);
      expect(prediction.incidentKey).toBe(incident.incidentKey);
      expect(prediction.rowHash).toMatch(/^[0-9a-f]{64}$/);
      const duplicatePayload = sealedPayloadWithHash(incident.incidentKey);

      const duplicate = await sealPublicPrediction(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
        direction: "below",
        startedAt: 100000,
        assessedAt: 186500,
        eventAgeSec: 86500,
        methodologyVersion: "2.1",
        methodologyVersionLabel: "v2.1",
        resolutionRubricVersion: "resolution-rubric-v2",
        durationModelVersion: "duration-landmark-v2",
        incidentGroupingVersion: "incident-group-v2",
        supportRulesVersion: "support-rules-v2",
        resolutionTier: "recovery_likely",
        durationSuppressed: false,
        sealedPayload: duplicatePayload.payload,
        rowHash: duplicatePayload.rowHash,
        predictionPolicyVersion: "sticky-24h-v1",
        policyDelaySec: 86400,
        eligibleAt: 186400,
        lockedAt: 186500,
        eventAgeAtLockSec: 86500,
        lockTiming: "late_freeze",
        createdAt: 186501,
      });
      expect(duplicate.id).toBe(prediction.id);
      expect(() =>
        db.sqlite.exec("UPDATE depeg_resolver_assessments SET row_json = '{}' WHERE checkpoint = 'public_prediction'"),
      ).toThrow(/public_prediction assessments are immutable/);
    } finally {
      db.close();
    }
  });

  it("stores no-call locks with flattened insufficient-signal fields", async () => {
    const db = makeSqliteD1();
    try {
      insertOpenEvent(db);
      const incident = await ensureIncident(db);
      const { payload, rowHash } = sealedPayloadWithHash(incident.incidentKey, "no_call");
      const prediction = await sealPublicNoCall(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
        direction: "below",
        startedAt: 100000,
        assessedAt: 186400,
        eventAgeSec: 86400,
        methodologyVersion: "2.0",
        methodologyVersionLabel: "v2.0",
        resolutionRubricVersion: "resolution-rubric-v2",
        durationModelVersion: "duration-landmark-v2",
        incidentGroupingVersion: "incident-group-v2",
        supportRulesVersion: "support-rules-v2",
        sealedPayload: payload,
        rowHash,
        predictionPolicyVersion: "sticky-24h-v1",
        policyDelaySec: 86400,
        eligibleAt: 186400,
        lockedAt: 186400,
        eventAgeAtLockSec: 86400,
        lockTiming: "on_time",
        createdAt: 186401,
      });

      expect(prediction.outcomeKind).toBe("no_call");
      const row = db.sqlite
        .prepare("SELECT resolution_tier, duration_suppressed, horizons_json, factors_json FROM depeg_resolver_assessments")
        .get() as { resolution_tier: string; duration_suppressed: number; horizons_json: string; factors_json: string };
      expect(row).toEqual({
        resolution_tier: "insufficient_signal",
        duration_suppressed: 1,
        horizons_json: "[]",
        factors_json: "[]",
      });
    } finally {
      db.close();
    }
  });

  it("enforces append-only errata and repair authorization consumption", async () => {
    const db = makeSqliteD1();
    try {
      const { incident, prediction } = await sealPredictionFixture(db);
      const erratum = await appendPredictionErratum(db, {
        publicPredictionId: prediction.id,
        incidentKey: incident.incidentKey,
        eventId: 1,
        assessmentId: prediction.assessmentId,
        reason: "event_identity_error",
        operatorNote: "test repair evidence",
        rowHashBefore: prediction.rowHash,
        createdAt: 190000,
        createdBy: "vitest",
      });
      expect(erratum.id).toBeGreaterThan(0);
      expect(() => db.sqlite.exec("UPDATE depeg_resolver_prediction_errata SET operator_note = 'mutated'")).toThrow(
        /prediction errata are append-only/,
      );
      expect(() => db.sqlite.exec("UPDATE depeg_events SET started_at = 100001 WHERE id = 1")).toThrow(
        /sealed depeg event identity updates require incident repair authorization/,
      );

      const authorization = await authorizeEventRepair(db, {
        eventId: 1,
        incidentKey: incident.incidentKey,
        operation: "identity_update",
        columns: ["started_at"],
        reason: "correct start timestamp",
        createdAt: 190010,
        expiresAt: 4102444800,
        createdBy: "vitest",
      });
      await consumeEventRepairAuthorization(db, {
        authorizationId: authorization.id,
        eventId: 1,
        incidentKey: incident.incidentKey,
        operation: "identity_update",
        consumedAt: 190011,
        consumer: "vitest",
      });
      expect(() =>
        db.sqlite.exec("UPDATE depeg_events SET started_at = 100001 WHERE id = 1"),
      ).not.toThrow();
      expect(() => db.sqlite.exec("UPDATE depeg_events SET started_at = 100002 WHERE id = 1")).toThrow(
        /sealed depeg event identity updates require incident repair authorization/,
      );
      await expect(
        consumeEventRepairAuthorization(db, {
          authorizationId: authorization.id,
          eventId: 1,
          incidentKey: incident.incidentKey,
          operation: "identity_update",
          consumedAt: 190012,
          consumer: "vitest",
        }),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("finalizes publication manifests atomically and records first-publication membership once", async () => {
      const db = makeSqliteD1();
    try {
      const { prediction } = await sealPredictionFixture(db);
      const rawManifestPayload = sealedPayload(prediction.incidentKey);
      const manifestPayload = attachDdrPublicRowHash(
        {
          ...rawManifestPayload,
          prediction: {
            ...(rawManifestPayload.prediction as Record<string, unknown>),
            publicPredictionId: prediction.id,
            state: "frozen",
            publishedAt: 200000,
            publicationSnapshotToken: "ddrpub:test:1",
            snapshotGeneration: 2,
          },
        },
        prediction.rowHash,
      );
      const basePayload = {
        _meta: {
          publicPredictionIds: [prediction.id],
          publicPredictionRowHashes: { [prediction.id]: prediction.rowHash },
        },
        rows: [manifestPayload],
      };
      await expect(
        writePublicationManifest(db, {
          snapshotToken: "ddrpub:test:mutated",
          snapshotGeneration: 2,
          publishedAt: 199999,
          validatorVersion: "vitest",
          basePayload: {
            ...basePayload,
            rows: [
              {
                ...manifestPayload,
                frozen: {
                  ...(manifestPayload.frozen as Record<string, unknown>),
                  tampered: true,
                },
              },
            ],
          },
        }),
      ).rejects.toThrow(/canonical hash does not match sealed row hash/);

      const manifest = await writePublicationManifest(db, {
        snapshotToken: "ddrpub:test:1",
        snapshotGeneration: 2,
        publishedAt: 200000,
        validatorVersion: "vitest",
        basePayload,
      });
      expect(manifest.publicPredictionIds).toEqual([prediction.id]);
      expect(manifest.publicPredictionCount).toBe(1);
      expect(() =>
        db.sqlite
          .prepare(
            `INSERT INTO depeg_resolver_publication_snapshot_rows
             (snapshot_token, public_prediction_id, incident_key, first_published)
             VALUES (?, ?, ?, 0)`,
          )
          .run(manifest.snapshotToken, prediction.id, prediction.incidentKey),
      ).toThrow(/cannot add rows to a finalized publication snapshot/);

      await writePublicationManifest(db, {
        snapshotToken: "ddrpub:test:2",
        snapshotGeneration: 2,
        publishedAt: 200100,
        validatorVersion: "vitest",
        basePayload,
      });

      const membership = await loadFirstPublicationMembership(db, { publicPredictionIds: [prediction.id] });
      expect(membership).toHaveLength(1);
      expect(membership[0]?.snapshotToken).toBe("ddrpub:test:1");
    } finally {
      db.close();
    }
  });

  it("persists publication retry state for sealed rows", async () => {
    const db = makeSqliteD1();
    try {
      const { incident } = await sealPredictionFixture(db);

      await recordLockOpportunity(db, {
        incidentKey: incident.incidentKey,
        eventId: 1,
        predictionPolicyVersion: "sticky-24h-v1",
        eligibleAt: 186400,
        runAt: 200000,
        action: "publication_retry_pending",
        reason: "manifest write failed",
        healthStatus: "healthy",
      });

      const row = db.sqlite
        .prepare("SELECT last_state FROM depeg_resolver_prediction_lock_state WHERE incident_key = ?")
        .get(incident.incidentKey) as { last_state: string };
      expect(row.last_state).toBe("publication_retry_pending");
    } finally {
      db.close();
    }
  });
});
