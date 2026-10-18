import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeReportCardsV9Card, makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { projectV9Table, projectV9Detail } from "@shared/lib/report-cards-v9-projections";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ReportCardsV9TableResponseSchema, ReportCardsV9DetailResponseSchema } from "@shared/types/report-cards-v9-projections";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { currentInput } from "../../lib/__tests__/safety-score-v9-publication-store.test-support";
import { persistSafetyScoreV9Publication } from "../../lib/safety-score-v9/publication-store";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../../lib/safety-score-v9/publication-health";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { handleReportCardsV9Table, handleReportCardsV9Detail } from "../report-cards-v9-projections";
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

  it("stages at most four fragments per batch without exposing an unaccepted generation", async () => {
    const { db, sqlite, publication } = await seed();
    const before = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    next.cards[0]!.evidence.reasons = [{ code: "unresolved-control-identity", message: "x".repeat(1_200_000), path: "control:incidentState" }];
    let stagedBatches = 0;
    let previousFragments = 0;
    const fragmentCount = sqlite.prepare(`SELECT
      (SELECT count(*) FROM safety_score_public_fragments WHERE generation_id = ?) +
      (SELECT count(*) FROM safety_score_site_fragments WHERE generation_id = ?) AS n`);
    const observedDb = {
      ...db,
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const result = await db.batch<T>(statements);
        const acceptedAt = sqlite.prepare("SELECT updated_at FROM cache WHERE key = ?")
          .get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.updated_at;
        if (acceptedAt === publication.publishedAtSec) {
          expect(sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(before);
          const count = Number(fragmentCount.get(next.publicationGenerationId, next.publicationGenerationId)!.n);
          expect(count - previousFragments).toBeGreaterThan(0);
          expect(count - previousFragments).toBeLessThanOrEqual(4);
          expect(statements.length).toBeLessThanOrEqual(2);
          previousFragments = count;
          stagedBatches++;
          const response = await handleReportCardsV9Table(db);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ updatedAt: publication.publishedAtSec });
        } else {
          expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests WHERE generation_id = ? AND retired_at IS NULL")
            .get(next.publicationGenerationId)!.n).toBe(next.cards.length + 1);
        }
        return result;
      },
    } as D1Database;
    await persistSafetyScoreV9Publication(observedDb, currentInput(next));
    expect(stagedBatches).toBeGreaterThan(next.cards.length + 2);
    expect(await (await handleReportCardsV9Table(db)).json()).toMatchObject({ updatedAt: next.publishedAtSec });
    expect((await handleReportCardsV9Detail(db, detailUrl(next.cards[0]!.id))).status).toBe(200);
  });

  it("rolls back acceptance if staged fragments disappear before the pointer switch", async () => {
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
          sqlite.prepare("DELETE FROM safety_score_site_fragments WHERE generation_id = ?")
            .run(next.publicationGenerationId);
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
