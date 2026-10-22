import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeReportCardsV9Card, makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { projectV9Table, projectV9Detail } from "@shared/lib/report-cards-v9-projections";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ReportCardsV9TableResponseSchema, ReportCardsV9DetailResponseSchema } from "@shared/types/report-cards-v9-projections";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import { V9_PUBLIC_FRAGMENT_MAX_BYTES } from "@shared/types/report-cards-v9-materialization";
import { D1_BATCH_SIZE } from "../../lib/constants";
import { D1_MAX_BOUND_PARAMETERS } from "../../lib/db";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { currentInput } from "../../lib/__tests__/safety-score-v9-publication-store.test-support";
import { persistSafetyScoreV9Publication } from "../../lib/safety-score-v9/publication-store";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../../lib/safety-score-v9/publication-health";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { handleReportCardsV9Table, handleReportCardsV9Detail } from "../report-cards-v9-projections";
import { handleReportCardsV9 } from "../report-cards-v9";
import { getRouteMatch } from "../../routes/registry";
import * as publicationCodec from "../../lib/safety-score-v9/publication-codec";

const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const sqlite of databases.splice(0)) sqlite.close(); });
async function seed() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  databases.push(sqlite);
  const db = createSqliteD1(sqlite);
  const publication = makeWorkerSafetyScoreV9Publication({ cards: [
    makeReportCardsV9Card({ id: "dai-makerdao" }),
    makeReportCardsV9PartialCard("exit", "A", { id: "usdc-circle" }),
    makeReportCardsV9PipelineGapCard("control", "B", { id: "usde-ethena" }),
    makeReportCardsV9Card({ id: "usdt-tether", score: null, grade: "NR",
      nrReasons: [{ code: "unresolved-control-identity", message: "Control identity unresolved", field: null, origin: "asset" }] }),
  ] });
  await persistSafetyScoreV9Publication(db, currentInput(publication));
  return { sqlite, db, publication };
}
const detailUrl = (id = "usdc-circle") => new URL(`https://example.com/api/report-cards/v9-detail?stablecoin=${id}`);
function health(sqlite: DatabaseSync, value: V9PublicationHealth) {
  sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?")
    .run(stableJsonStringifyV1(value), value.attemptedAtSec, SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth);
}

describe("generation-bound compact Safety Scores", () => {
  it("retains representation version 1 while phase-1 producer bytes are unchanged", async () => {
    const { sqlite } = await seed();
    const manifests = sqlite.prepare(
      "SELECT manifest FROM safety_score_public_manifests UNION ALL SELECT manifest FROM safety_score_site_manifests",
    ).all();
    expect(manifests).toHaveLength(6);
    for (const row of manifests) expect(JSON.parse(row.manifest as string).version).toBe(1);
  });

  it("matches admitted full cards across rated, NR, partial and pipeline-gap states", async () => {
    const { db } = await seed();
    const source = await loadActiveSafetyScoreSource(db);
    if (source.kind !== "v9") throw new Error("Expected admitted source");
    const tableResponse = await handleReportCardsV9Table(db);
    expect(tableResponse.status).toBe(200);
    const table = ReportCardsV9TableResponseSchema.parse(await tableResponse.json());
    expect(table).toEqual(projectV9Table(source.snapshot));
    for (const card of source.snapshot.cards) {
      const response = await handleReportCardsV9Detail(db, detailUrl(card.id));
      expect(response.status).toBe(200);
      const detail = ReportCardsV9DetailResponseSchema.parse(await response.json());
      expect(detail).toEqual(projectV9Detail(source.snapshot, card.id));
      expect(detail.cards).toEqual([card]);
      expect(detail.completeness).toEqual(source.snapshot.completeness);
    }
    for (const path of ["/api/report-cards/v9-table", "/api/report-cards/v9-detail"]) {
      expect(getRouteMatch(path)?.endpoint).toMatchObject({ publicApiAccess: "site-only", strictContract: true, cacheBypass: true });
      expect(getRouteMatch(path)?.endpoint?.cacheKeyIgnoresQuery).not.toBe(true);
    }
  });

  it("reads compact immutable bytes without decoding a mutated source payload", async () => {
    const { db, sqlite } = await seed();
    const expected = await (await handleReportCardsV9Table(db)).json();
    const row = JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.value as string);
    row.payload = "not-base64";
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(stableJsonStringifyV1(row), SAFETY_SCORE_V9_CACHE_KEYS.publication);
    expect(await (await handleReportCardsV9Table(db)).json()).toEqual(expected);
    expect((await handleReportCardsV9Detail(db, detailUrl())).status).toBe(200);
  });

  it("composes current-to-held transitions and changed hold reasons without replacing bytes", async () => {
    const { db, sqlite, publication } = await seed();
    const before = sqlite.prepare("SELECT * FROM safety_score_site_fragments ORDER BY representation_key, ordinal").all();
    const held: V9PublicationHealth = { ...currentInput(publication).publicationHealth,
      status: "held", heldSinceSec: 120, attemptedAtSec: 130, reasons: [{ code: "dex-stale" }] };
    for (const reasons of [[{ code: "dex-stale" }], [{ code: "assessment-failed", detail: "Read failed" }]] as const) {
      held.reasons = [...reasons];
      health(sqlite, held);
      for (const response of [await handleReportCardsV9Table(db), await handleReportCardsV9Detail(db, detailUrl())]) {
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("X-Safety-Score-Status")).toBe("held");
        expect(await response.json()).toMatchObject({ updatedAt: publication.publishedAtSec, publicationHealth: held });
      }
    }
    expect(sqlite.prepare("SELECT * FROM safety_score_site_fragments ORDER BY representation_key, ordinal").all()).toEqual(before);
  });

  it("fails closed after required health disappears and treats valid identity mismatch as held", async () => {
    const { db, sqlite, publication } = await seed();
    const mismatch = { ...currentInput(publication).publicationHealth, acceptedPublicationGenerationId: "report-cards:v9:other" };
    health(sqlite, mismatch);
    expect(await (await handleReportCardsV9Table(db)).json()).toMatchObject({ publicationHealth: { status: "held", reasons: [{ code: "assessment-failed" }] } });
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth);
    for (const response of [await handleReportCardsV9Table(db), await handleReportCardsV9Detail(db, detailUrl())]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ reason: "v9-public-health-unavailable" });
    }
  });

  it("backfills only the requested representation at the accepted clock", async () => {
    const { db, sqlite, publication } = await seed();
    sqlite.exec("DELETE FROM safety_score_site_fragments; DELETE FROM safety_score_site_manifests; DELETE FROM safety_score_public_manifests");
    const response = await handleReportCardsV9Detail(db, detailUrl());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ updatedAt: publication.publishedAtSec });
    expect(sqlite.prepare("SELECT representation_key FROM safety_score_site_manifests").all())
      .toEqual([{ representation_key: "coin:usdc-circle" }]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests").get()!.n).toBe(0);
  });

  it.each(["usr-resolv", "buck-buck-assets", "usds-sky"])("returns an explicit nonmember reason for %s without repair", async id => {
    const { db, sqlite } = await seed();
    // Corrupt payload proves a supported frozen/nonmember read never decodes it.
    const row = JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.value as string);
    row.payload = "not-base64";
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(stableJsonStringifyV1(row), SAFETY_SCORE_V9_CACHE_KEYS.publication);
    const parse = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    const before = sqlite.prepare("SELECT * FROM safety_score_site_manifests").all();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await handleReportCardsV9Detail(db, detailUrl(id));
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ reason: "v9-coin-not-in-accepted-publication" });
    }
    expect(parse).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT * FROM safety_score_site_manifests").all()).toEqual(before);
    expect(sqlite.prepare("SELECT count(*) AS n FROM cron_leases").get()!.n).toBe(0);
  });

  it("fails closed on a missing membership census without attempting repair", async () => {
    const { db, sqlite } = await seed();
    sqlite.exec("DELETE FROM safety_score_site_manifests");
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex);
    const parse = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    expect(await (await handleReportCardsV9Detail(db, detailUrl())).json()).toMatchObject({ reason: "safety-score-index-missing" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not treat another accepted generation's census as absence or repair permission", async () => {
    const { db, sqlite } = await seed();
    const row = JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex)!.value as string);
    row.safetyScoreIdentity.publicationGenerationId = "report-cards:v9:another";
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(stableJsonStringifyV1(row), SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex);
    const parse = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    expect(await (await handleReportCardsV9Detail(db, detailUrl("usr-resolv"))).json())
      .toMatchObject({ reason: "safety-score-index-publication-mismatch" });
    expect(parse).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT count(*) AS n FROM cron_leases").get()!.n).toBe(0);
  });

  it("rejects corrupt or swapped compact fragments before returning success", async () => {
    const { db, sqlite } = await seed();
    sqlite.exec("UPDATE safety_score_site_fragments SET body = 'X' || substr(body, 2) WHERE representation_key = 'table' AND ordinal = 0");
    expect((await handleReportCardsV9Table(db)).status).toBe(503);
    expect((await handleReportCardsV9Detail(db, detailUrl())).status).toBe(200);
    const manifest = JSON.parse(sqlite.prepare("SELECT manifest FROM safety_score_site_manifests WHERE representation_key = 'coin:usdc-circle'").get()!.manifest as string);
    manifest.representationKey = "coin:usdt-tether";
    sqlite.prepare("UPDATE safety_score_site_manifests SET manifest = ? WHERE representation_key = 'coin:usdc-circle'").run(stableJsonStringifyV1(manifest));
    expect(await (await handleReportCardsV9Detail(db, detailUrl())).json()).toMatchObject({ reason: "v9-public-representation-key-mismatch" });
  });

  it("rolls back the full publication when a required compact write fails", async () => {
    const { db, sqlite } = await seed();
    const before = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
    sqlite.exec("CREATE TRIGGER refuse_site BEFORE INSERT ON safety_score_site_fragments BEGIN SELECT RAISE(ABORT, 'site write failed'); END");
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await expect(persistSafetyScoreV9Publication(db, currentInput(next))).rejects.toThrow();
    expect(sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(before);
  });

  it.each([1, 397])("coalesces %i cards within staging caps while preserving accepted reads", async cardCount => {
    const { db, sqlite, publication } = await seed();
    const before = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
    const cards = Array.from({ length: cardCount }, (_, index) => makeReportCardsV9Card({
      id: index === 0 ? "usdc-circle" : `v9-staging-coin-${String(index).padStart(3, "0")}`,
      evidence: { level: "adequate", freshness: "current", reasons: [{
        code: "unresolved-control-identity",
        // Exercise both a multi-batch artifact and UTF-8 (not UTF-16) accounting.
        message: cardCount === 1 ? "x".repeat(1_200_000) : "\u00e9".repeat(6_000),
        path: "control:incidentState",
      }] },
    }));
    const next = makeWorkerSafetyScoreV9Publication({
      cards, publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next",
    });
    let stagedBatches = 0;
    let inFlight = 0;
    let maxBatchFragments = 0;
    let multiRowManifests = false;
    const manifestInserts = new Map<string, number>();
    const bindings = new WeakMap<D1PreparedStatement, { sql: string; values: unknown[] }>();
    const expectedSiteKeys = ["table", ...cards.map(card => `coin:${card.id}`)].sort();
    const observedDb: D1Database = {
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        const bind = statement.bind.bind(statement);
        statement.bind = (...values: unknown[]) => {
          const bound = bind(...values);
          bindings.set(bound, { sql, values });
          return bound;
        };
        return statement;
      },
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        expect(++inFlight).toBe(1);
        const writes = statements.map(statement => bindings.get(statement)!);
        const staging = writes.every(({ sql }) => sql.startsWith("INSERT OR IGNORE INTO safety_score_"));
        if (staging) {
          expect(statements.length).toBeLessThanOrEqual(D1_BATCH_SIZE);
          let batchBytes = 0;
          let fragments = 0;
          for (const { sql, values } of writes) {
            expect(values.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
            expect((sql.match(/\?/g) ?? []).length).toBe(values.length);
            batchBytes += Buffer.byteLength(sql, "utf8") + values.reduce<number>((bytes, value) =>
              bytes + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 8), 0);
            const site = sql.includes("safety_score_site_");
            const manifest = sql.includes("_manifests");
            const columns = manifest ? site ? 7 : 6 : site ? 6 : 5;
            expect(values.length % columns).toBe(0);
            if (manifest && values.length > columns) multiRowManifests = true;
            for (let offset = 0; offset < values.length; offset += columns) {
              if (manifest) {
                const key = site ? String(values[offset + 3]) : "full";
                manifestInserts.set(key, (manifestInserts.get(key) ?? 0) + 1);
              } else {
                const body = String(values[offset + columns - 1]);
                expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(V9_PUBLIC_FRAGMENT_MAX_BYTES);
                fragments++;
              }
            }
          }
          expect(batchBytes).toBeLessThanOrEqual(4 * V9_PUBLIC_FRAGMENT_MAX_BYTES);
          maxBatchFragments = Math.max(maxBatchFragments, fragments);
          stagedBatches++;
        }
        try {
          const result = await db.batch<T>(statements);
          if (staging) {
            expect(sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(before);
            expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests WHERE generation_id = ? AND retired_at IS NULL")
              .get(next.publicationGenerationId)!.n).toBe(0);
            for (const response of [
              await handleReportCardsV9(db), await handleReportCardsV9Table(db),
              await handleReportCardsV9Detail(db, detailUrl()),
            ]) {
              expect(response.status).toBe(200);
              expect(await response.json()).toMatchObject({ updatedAt: publication.publishedAtSec });
            }
          } else {
            expect(sqlite.prepare("SELECT generation_id FROM safety_score_public_manifests WHERE retired_at IS NULL").all())
              .toEqual([{ generation_id: next.publicationGenerationId }]);
            expect(sqlite.prepare("SELECT representation_key FROM safety_score_site_manifests WHERE generation_id = ? AND retired_at IS NULL ORDER BY representation_key")
              .all(next.publicationGenerationId)).toEqual(expectedSiteKeys.map(representation_key => ({ representation_key })));
          }
          return result;
        } finally { inFlight--; }
      },
    };
    await persistSafetyScoreV9Publication(observedDb, currentInput(next));
    expect(stagedBatches).toBeGreaterThan(1);
    expect(stagedBatches).toBeLessThanOrEqual(cardCount === 1 ? 6 : 40);
    expect(manifestInserts).toEqual(new Map(["full", ...expectedSiteKeys].map(key => [key, 1])));
    if (cardCount === 397) {
      expect(maxBatchFragments).toBeGreaterThan(4);
      expect(multiRowManifests).toBe(true);
    }
    expect(await (await handleReportCardsV9Table(db)).json()).toMatchObject({ updatedAt: next.publishedAtSec });
    expect((await handleReportCardsV9Detail(db, detailUrl())).status).toBe(200);
    const full = await handleReportCardsV9(db);
    expect(full.status).toBe(200);
    await full.body?.cancel();
  });

  it.each(["public", "site"])("rolls back acceptance if one staged %s fragment disappears before the pointer switch", async surface => {
    const { db, sqlite } = await seed();
    const before = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    let removed = false;
    const racedDb = {
      ...db,
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const sites = Number(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests WHERE generation_id = ?")
          .get(next.publicationGenerationId)!.n);
        if (!removed && sites === next.cards.length + 1) {
          const deletion = sqlite.prepare(surface === "public"
            ? "DELETE FROM safety_score_public_fragments WHERE generation_id = ? AND ordinal = 0"
            : "DELETE FROM safety_score_site_fragments WHERE generation_id = ? AND representation_key = 'table' AND ordinal = 0")
            .run(next.publicationGenerationId);
          expect(deletion.changes).toBe(1);
          removed = true;
        }
        return db.batch<T>(statements);
      },
    } as D1Database;
    await expect(persistSafetyScoreV9Publication(racedDb, currentInput(next))).rejects.toThrow();
    expect(removed).toBe(true);
    expect(sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(before);
    expect((await handleReportCardsV9Table(db)).status).toBe(200);
  });

  it("validates the selected coin parameter before reading storage", async () => {
    const { db } = await seed();
    expect((await handleReportCardsV9Detail(db, new URL("https://example.com/api/report-cards/v9-detail"))).status).toBe(400);
    expect((await handleReportCardsV9Detail(db, new URL("https://example.com/api/report-cards/v9-detail?stablecoin=usdc-circle&stablecoin=usdt-tether"))).status).toBe(400);
  });
});
