import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeReportCardsV9Card, makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC } from "../../lib/api-freshness-age";
import { ReportCardsV9CurrentResponseSchema } from "@shared/types/report-cards-v9";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import { V9_PUBLIC_READ_GRACE_SEC, V9_PUBLIC_FRAGMENT_MAX_BYTES } from "@shared/types/report-cards-v9-materialization";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { currentInput } from "../../lib/__tests__/safety-score-v9-publication-store.test-support";
import { persistSafetyScoreV9Publication, SAFETY_SCORE_V9_CACHE_KEYS } from "../../lib/safety-score-v9/publication-store";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { handleReportCardsV9 } from "../report-cards-v9";
import { getRouteMatch } from "../../routes/registry";
import { handleReportCardsV9Table, handleReportCardsV9Detail } from "../report-cards-v9-projections";
import * as publicationCodec from "../../lib/safety-score-v9/publication-codec";

const databases: DatabaseSync[] = [];
function database() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const sqlite of databases.splice(0)) sqlite.close(); });

async function seed() {
  const { sqlite, db } = database();
  const publication = makeWorkerSafetyScoreV9Publication();
  await persistSafetyScoreV9Publication(db, currentInput(publication));
  return { sqlite, db, publication };
}

function readManifest(sqlite: DatabaseSync) {
  return JSON.parse(sqlite.prepare("SELECT manifest FROM safety_score_public_manifests WHERE retired_at IS NULL").get()!.manifest as string);
}

function updateHealth(sqlite: DatabaseSync, health: V9PublicationHealth) {
  sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(stableJsonStringifyV1(health), health.attemptedAtSec, SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth);
}

async function assertServedEquivalent(db: D1Database) {
  const source = await loadActiveSafetyScoreSource(db);
  expect(source.kind).toBe("v9");
  const response = await handleReportCardsV9(db);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(source.snapshot);
}

describe("materialized V9 response", () => {
  it("preserves rated, NR, technical pipeline gaps and partial-pillar evidence across the full cohort", async () => {
    const { db } = database();
    const cards = [
      makeReportCardsV9Card({ id: "a-rated" }),
      makeReportCardsV9Card({ id: "b-nr", score: null, grade: "NR",
        nrReasons: [{ code: "unresolved-control-identity", message: "Control identity unresolved", field: null, origin: "asset" }] }),
      makeReportCardsV9PartialCard("exit", "A", { id: "c-partial" }),
      makeReportCardsV9PipelineGapCard("control", "B", { id: "d-gap" }),
    ];
    await persistSafetyScoreV9Publication(db, currentInput(makeWorkerSafetyScoreV9Publication({ cards })));
    await assertServedEquivalent(db);
  });

  it("authenticates and streams multiple UTF-8 fragments without splitting surrogate pairs", async () => {
    const { db, sqlite } = database();
    const publication = makeWorkerSafetyScoreV9Publication();
    const text = "\uD83D\uDE80".repeat(180_000);
    publication.cards[0]!.witnessTexts = [text];
    publication.cards[0]!.evidence.reasons = [{ code: "unresolved-control-identity", message: "~0", path: "control:incidentState" }];
    await persistSafetyScoreV9Publication(db, currentInput(publication));
    expect(readManifest(sqlite).fragments.length).toBeGreaterThan(1);
    await assertServedEquivalent(db);
    const body = ReportCardsV9CurrentResponseSchema.parse(await (await handleReportCardsV9(db)).json());
    expect(body.cards[0].evidence.reasons[0].message).toBe(text);
    expect(() => sqlite.exec(`INSERT INTO safety_score_public_fragments
      SELECT * FROM safety_score_public_fragments WHERE ordinal = 0`)).toThrow();
  });
  it("matches the fully admitted object source and preserves the bypassed route", async () => {
    const { db, sqlite } = await seed();
    const source = await loadActiveSafetyScoreSource(db);
    expect(source.kind).toBe("v9");
    const response = await handleReportCardsV9(db);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual(source.snapshot);
    expect(ReportCardsV9CurrentResponseSchema.safeParse(body).success).toBe(true);
    expect(getRouteMatch("/api/report-cards/v9")?.endpoint?.cacheBypass).toBe(true);
    expect(getRouteMatch("/api/report-cards/v9-preview")).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_fragments").get()!.n).toBe(readManifest(sqlite).fragments.length);
  });

  it("keeps immutable bytes while fresh health moves current to held and changes held reasons", async () => {
    const { db, sqlite, publication } = await seed();
    const before = sqlite.prepare("SELECT * FROM safety_score_public_fragments ORDER BY ordinal").all();
    await handleReportCardsV9(db);
    const health: V9PublicationHealth = { ...currentInput(publication).publicationHealth, status: "held",
      attemptedAtSec: 130, heldSinceSec: 120, reasons: [{ code: "dex-stale" }] };
    updateHealth(sqlite, health);
    const held = await handleReportCardsV9(db);
    expect(held.headers.get("X-Safety-Score-Status")).toBe("held");
    expect(held.headers.get("Cache-Control")).toBe("no-store");
    expect(await held.json()).toMatchObject({ updatedAt: publication.publishedAtSec, publicationHealth: health });
    health.attemptedAtSec++;
    health.reasons = [{ code: "assessment-failed", detail: "Latest assessment could not complete." }];
    updateHealth(sqlite, health);
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({ publicationHealth: health });
    expect(sqlite.prepare("SELECT * FROM safety_score_public_fragments ORDER BY ordinal").all()).toEqual(before);
  });

  it.each(["missing", "malformed", "noncanonical", "clock", "legacy"])("fails closed on %s health after a successful read", async mode => {
    const { db, sqlite, publication } = await seed();
    expect((await handleReportCardsV9(db)).status).toBe(200);
    if (mode === "missing") sqlite.prepare("DELETE FROM cache WHERE key = ?").run(SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth);
    else {
      const health = currentInput(publication).publicationHealth;
      const value = mode === "malformed" ? "{" : mode === "legacy" ? '{"schemaVersion":1}' : stableJsonStringifyV1(health) + (mode === "noncanonical" ? " " : "");
      sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(value, health.attemptedAtSec + (mode === "clock" ? 1 : 0), SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth);
    }
    const response = await handleReportCardsV9(db);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ reason: mode === "legacy" ? "publication-schema-cutover-pending" : mode === "missing" ? "v9-public-health-unavailable" : "v9-public-health-invalid" });
  });

  it.each(["generation", "accepted-clock"])("serves valid %s health mismatch as held, not an index-style error", async mode => {
    const { db, sqlite, publication } = await seed();
    const health = currentInput(publication).publicationHealth;
    if (mode === "generation") health.acceptedPublicationGenerationId = "report-cards:v9:other";
    else health.acceptedAtSec = publication.publishedAtSec - 1;
    updateHealth(sqlite, health);
    const response = await handleReportCardsV9(db);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ publicationHealth: {
      status: "held", acceptedPublicationGenerationId: publication.publicationGenerationId,
      acceptedAtSec: publication.publishedAtSec, reasons: [{ code: "assessment-failed" }],
    } });
  });

  it("preserves source clocks across hits, expiry and repair; computes freshness at the request instant", async () => {
    const { db, sqlite, publication } = await seed();
    const budget = API_FRESHNESS_MAX_AGE_SEC.reportCards * FRESHNESS_RATIOS.FRESH;
    for (const age of [0, budget - 0.5, budget, budget + 1, budget * 10, -API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC - 1]) {
      vi.useFakeTimers();
      vi.setSystemTime((publication.publishedAtSec + age) * 1000);
      const response = await handleReportCardsV9(db);
      const body = await response.json();
      expect(body).toMatchObject({ updatedAt: publication.publishedAtSec, asOfSec: publication.asOfSec, source: { sourceGenerations: publication.sourceGenerations } });
      expect(response.headers.get("Age")).toBeNull();
      if (age >= budget || age < 0) expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    sqlite.exec("DELETE FROM safety_score_public_fragments; DELETE FROM safety_score_public_manifests");
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({ updatedAt: publication.publishedAtSec, asOfSec: publication.asOfSec });
    expect(readManifest(sqlite).publishedAtSec).toBe(publication.publishedAtSec);
  });

  it("uses the admitted representation without decoding a mutated canonical payload on hits", async () => {
    const { db, sqlite } = await seed();
    const expected = await (await handleReportCardsV9(db)).json();
    const row = JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.value as string);
    row.payload = "not-base64";
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(stableJsonStringifyV1(row), SAFETY_SCORE_V9_CACHE_KEYS.publication);
    expect(await (await handleReportCardsV9(db)).json()).toEqual(expected);
  });

  it.each(["missing", "truncated", "wrong-hash", "wrong-order", "extra"])("rejects %s fragments before returning successful headers", async mode => {
    const { db, sqlite } = await seed();
    if (mode === "missing") sqlite.exec("DELETE FROM safety_score_public_fragments WHERE ordinal = 0");
    if (mode === "truncated") sqlite.exec("UPDATE safety_score_public_fragments SET body = substr(body, 1, length(body)-1) WHERE ordinal = 0");
    if (mode === "wrong-hash") sqlite.exec("UPDATE safety_score_public_fragments SET body = 'X' || substr(body, 2) WHERE ordinal = 0");
    if (mode === "wrong-order") sqlite.exec("UPDATE safety_score_public_fragments SET ordinal = 127 WHERE ordinal = 0");
    if (mode === "extra") sqlite.exec("INSERT INTO safety_score_public_fragments SELECT generation_id, projection_version, payload_sha256, 127, 'x' FROM safety_score_public_fragments WHERE ordinal = 0");
    const response = await handleReportCardsV9(db);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(["version", "policy", "build", "clock", "body-hash", "malformed"])("refuses %s manifest identity or integrity corruption", async mode => {
    const { db, sqlite } = await seed();
    const m = readManifest(sqlite);
    if (mode === "version") m.version++;
    if (mode === "policy") m.safetyScoreIdentity.policyDigest = "f".repeat(64);
    if (mode === "build") m.safetyScoreIdentity.evaluationBuildDigest = "f".repeat(64);
    if (mode === "clock") m.publishedAtSec++;
    if (mode === "body-hash") m.sha256 = "f".repeat(64);
    sqlite.prepare("UPDATE safety_score_public_manifests SET manifest = ?").run(mode === "malformed" ? "{" : stableJsonStringifyV1(m));
    expect((await handleReportCardsV9(db)).status).toBe(503);
  });

  it("atomically rolls back canonical acceptance when required fragments cannot be written", async () => {
    const { db, sqlite } = await seed();
    const before = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
    const manifests = sqlite.prepare("SELECT * FROM safety_score_public_manifests").all();
    sqlite.exec("CREATE TRIGGER refuse_fragment BEFORE INSERT ON safety_score_public_fragments BEGIN SELECT RAISE(ABORT, 'fragment failed'); END");
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await expect(persistSafetyScoreV9Publication(db, currentInput(next))).rejects.toThrow();
    expect(sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(before);
    expect(sqlite.prepare("SELECT * FROM safety_score_public_manifests").all()).toEqual(manifests);
  });

  it("does not collide on a reused result digest and protects replaced bytes for in-flight grace", async () => {
    const { db, sqlite, publication } = await seed();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const next = makeWorkerSafetyScoreV9Publication({ resultDigest: publication.resultDigest, publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await persistSafetyScoreV9Publication(db, currentInput(next));
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({ updatedAt: 130, safetyScoreIdentity: { publicationGenerationId: next.publicationGenerationId } });
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests").get()!.n).toBe(2);
    vi.setSystemTime((1000 + V9_PUBLIC_READ_GRACE_SEC + 1) * 1000);
    const third = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 150, publicationGenerationId: "report-cards:v9:third" });
    await persistSafetyScoreV9Publication(db, currentInput(third));
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests WHERE generation_id = ?").get(publication.publicationGenerationId)!.n).toBe(0);
  });

  it("never advances representation selection on a stale accepted writer", async () => {
    const { db, sqlite, publication } = await seed();
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await persistSafetyScoreV9Publication(db, currentInput(next));
    await expect(persistSafetyScoreV9Publication(db, currentInput(publication))).rejects.toThrow();
    expect(readManifest(sqlite).safetyScoreIdentity.publicationGenerationId).toBe(next.publicationGenerationId);
  });

  it("keeps the wire witness-resolved including literal leading tilde text and graph intermediary labels", async () => {
    const { db } = database();
    const parent = makeReportCardsV9Card({ id: "z-parent" });
    const publication = makeWorkerSafetyScoreV9Publication({ cards: [makeReportCardsV9Card(), parent] });
    const card = publication.cards[0]!;
    card.witnessTexts = ["Custody intermediary", "~Literal evidence"];
    card.evidence.reasons = [{ code: "unresolved-control-identity", message: "~1", path: "control:incidentState" }];
    card.dependencies.basket = [{
      upstreamAssetId: parent.id, score: parent.score, ratingStatus: parent.ratingStatus, partialEvidence: null,
      causeGapRefs: [], limitedEvidenceCauses: [], weight: 0.2, boundedUnknown: false,
      dependencyType: "collateral", wrapperForm: null,
      provenance: { source: "live-reserve", evidenceAsOf: "2026-10-11",
        intermediary: { kind: "bridge", label: "~0", verified: true } },
    }];
    await persistSafetyScoreV9Publication(db, currentInput(publication));
    const response = await handleReportCardsV9(db);
    expect(response.status).toBe(200);
    const body = ReportCardsV9CurrentResponseSchema.parse(await response.json());
    expect(body.cards.every((value: object) => !("witnessTexts" in value))).toBe(true);
    expect(body.cards[0].evidence.reasons[0].message).toBe("~Literal evidence");
    expect(body.dependencyGraph.edges[0].provenance?.intermediary?.label).toBe("Custody intermediary");
    expect(ReportCardsV9CurrentResponseSchema.safeParse(body).success).toBe(true);
    expect(ReportCardsV9CurrentResponseSchema.safeParse({ ...body, cards: publication.cards }).success).toBe(false);
    const { sqlite } = database();
    sqlite.prepare(`INSERT INTO safety_score_public_manifests
      (generation_id, projection_version, payload_sha256, manifest, created_at) VALUES ('g', 1, 'h', '{}', 1)`).run();
    expect(() => sqlite.prepare(`INSERT INTO safety_score_public_fragments
      VALUES ('g', 1, 'h', 0, ?)`).run("x".repeat(V9_PUBLIC_FRAGMENT_MAX_BYTES + 1))).toThrow();
  });

  it("keeps one coherent selected generation when acceptance changes during fragment reads", async () => {
    const { db, sqlite, publication } = await seed();
    const oldRows = sqlite.prepare("SELECT key, value, updated_at FROM cache").all();
    const expected = ReportCardsV9CurrentResponseSchema.parse(await (await handleReportCardsV9(db)).json());
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await persistSafetyScoreV9Publication(db, currentInput(next));
    const nextRows = sqlite.prepare("SELECT key, value, updated_at FROM cache").all();
    for (const row of oldRows) sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(row.value, row.updated_at, row.key);
    let raced = false;
    const reader = createSqliteD1(sqlite, { onAll(sql) {
      if (!raced && sql.includes("FROM safety_score_public_fragments")) {
        raced = true;
        for (const row of nextRows) sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(row.value, row.updated_at, row.key);
      }
    } });
    expect(await (await handleReportCardsV9(reader)).json()).toEqual(expected);
    expect(raced).toBe(true);
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({
      updatedAt: next.publishedAtSec, safetyScoreIdentity: { publicationGenerationId: next.publicationGenerationId },
    });
    expect(expected.updatedAt).toBe(publication.publishedAtSec);
  });

  it("admits only one cold builder across isolates and representation keys", async () => {
    const { db, sqlite } = await seed();
    sqlite.exec("DELETE FROM safety_score_public_manifests; DELETE FROM safety_score_site_manifests");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalParse = publicationCodec.parseSafetyScoreV9Publication;
    const parse = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication").mockImplementation(async (...args) => {
      enter();
      await gate;
      return originalParse(...args);
    });
    const claimant = handleReportCardsV9(db);
    await entered;
    try {
      // Separate binding objects share D1, not isolate-local promise state.
      const otherIsolate = createSqliteD1(sqlite);
      const contenders = await Promise.all([
        handleReportCardsV9(otherIsolate),
        handleReportCardsV9Table(otherIsolate),
        handleReportCardsV9Detail(otherIsolate, new URL("https://example.com/api/report-cards/v9-detail?stablecoin=usdc-circle")),
      ]);
      for (const response of contenders) {
        expect(response.status).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toMatchObject({ reason: "v9-public-materialization-repair-in-progress" });
      }
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { release(); }
    expect((await claimant).status).toBe(200);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests").get()!.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM cron_leases").get()!.n).toBe(0);
  });

  it("allows an expired repair claim to be taken over without changing producer clocks", async () => {
    const { db, sqlite, publication } = await seed();
    const manifest = readManifest(sqlite);
    sqlite.exec("DELETE FROM safety_score_public_manifests");
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const leaseKey = `v9-materialization:${publication.publicationGenerationId}:${manifest.version}:${manifest.payloadSha256}`;
    sqlite.prepare("INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(leaseKey, "abandoned-request", 1060, 1000, 1000);
    const parse = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({ reason: "v9-public-materialization-repair-in-progress" });
    expect(parse).not.toHaveBeenCalled();
    vi.setSystemTime(1_061_000);
    const response = await handleReportCardsV9(db);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ updatedAt: publication.publishedAtSec, asOfSec: publication.asOfSec });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM cron_leases").get()!.n).toBe(0);
  });

  it.each(["expired", "replaced"])("rejects a repair with an %s lease before the atomic write", async mode => {
    const { db, sqlite } = await seed();
    sqlite.exec("DELETE FROM safety_score_public_manifests");
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const originalParse = publicationCodec.parseSafetyScoreV9Publication;
    vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication").mockImplementation(async (...args) => {
      const publication = await originalParse(...args);
      vi.setSystemTime(1_061_000);
      if (mode === "replaced") sqlite.exec("UPDATE cron_leases SET lease_owner = 'replacement', lease_until = 1120");
      return publication;
    });
    expect((await handleReportCardsV9(db)).status).toBe(503);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests").get()!.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_fragments").get()!.n).toBe(0);
    if (mode === "replaced") expect(sqlite.prepare("SELECT lease_owner FROM cron_leases").get()!.lease_owner).toBe("replacement");
    else expect(sqlite.prepare("SELECT count(*) AS n FROM cron_leases").get()!.n).toBe(0);
  });

  it("rolls back a first-read backfill that loses its canonical CAS without leaving orphan fragments", async () => {
    const { db, sqlite, publication } = await seed();
    const oldRows = sqlite.prepare("SELECT key, value, updated_at FROM cache").all();
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await persistSafetyScoreV9Publication(db, currentInput(next));
    const nextRows = sqlite.prepare("SELECT key, value, updated_at FROM cache").all();
    sqlite.prepare("DELETE FROM safety_score_public_manifests WHERE generation_id = ?").run(publication.publicationGenerationId);
    for (const row of oldRows) sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(row.value, row.updated_at, row.key);
    const racingDb = { ...db, batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      for (const row of nextRows) sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(row.value, row.updated_at, row.key);
      return db.batch<T>(statements);
    } } as D1Database;
    expect((await handleReportCardsV9(racingDb)).status).toBe(503);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests WHERE generation_id = ?").get(publication.publicationGenerationId)!.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_fragments WHERE generation_id = ?").get(publication.publicationGenerationId)!.n).toBe(0);
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({ updatedAt: next.publishedAtSec });
  });

  it("does not treat an independently recorded failed attempt as a hold", async () => {
    const { db, sqlite } = await seed();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      SAFETY_SCORE_V9_CACHE_KEYS.failedPublicationAttempt, '{"outcome":"failed"}', 999,
    );
    const response = await handleReportCardsV9(db);
    expect(response.headers.get("X-Safety-Score-Status")).toBe("current");
    expect(await response.json()).toMatchObject({ publicationHealth: { status: "current" } });
  });
});
