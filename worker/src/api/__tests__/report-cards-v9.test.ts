import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeReportCardsV9Card, makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC } from "../../lib/api-freshness-age";
import { ReportCardsV9CurrentResponseSchema } from "\@shared/types/report-cards-v9-current";
import { ReportCardsV9DetailResponseSchema } from "@shared/types/report-cards-v9-projections";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { V9_PUBLIC_READ_GRACE_SEC, V9_PUBLIC_FRAGMENT_MAX_BYTES } from "@shared/types/report-cards-v9-materialization";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { currentInput, persistAndMaterialize } from "../../lib/__tests__/safety-score-v9-publication-store.test-support";
import { persistSafetyScoreV9Publication } from "../../lib/safety-score-v9/publication-store";
import { materializeV9AcceptedPublication, V9_PUBLIC_MATERIALIZATION_CACHE_KEY } from "../../lib/report-cards-v9-materialization";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../../lib/safety-score-v9/publication-health";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { handleReportCardsV9 } from "../report-cards-v9";
import { getRouteMatch } from "../../routes/registry";
import { handleReportCardsV9Table, handleReportCardsV9Detail } from "../report-cards-v9-projections";
import * as publicationCodec from "../../lib/safety-score-v9/publication-codec";
import { withRepresentationEtag } from "../../lib/api-response";
import { sha256HexFromUtf8Chunks } from "../../lib/hash";

function instrumentReads(db: D1Database, delayMs = 0) {
  const reads: { sql: string; bindings: unknown[] }[] = [];
  const reader = new Proxy(db, { get(target, key) {
    if (key !== "prepare") return Reflect.get(target, key);
    return (sql: string) => {
      const wrap = (statement: D1PreparedStatement, bindings: unknown[]): D1PreparedStatement =>
        new Proxy(statement, { get(target, key) {
          if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values as never[]), values);
          if (key === "first" || key === "all") return async (...args: unknown[]) => {
            reads.push({ sql, bindings });
            if (delayMs > 0) await delay(delayMs);
            return Reflect.apply(Reflect.get(target, key), target, args);
          };
          return Reflect.get(target, key);
        } });
      return wrap(db.prepare(sql), []);
    };
  } });
  return { reader, reads };
}

async function seedCohort() {
  const { sqlite, db } = database();
  // Full wire-card shapes, with resolved research text, not a byte-only blob.
  const cards = Array.from({ length: 397 }, (_, index) => {
    const card: SafetyScoreV9CurrentCard = makeReportCardsV9Card({ id: `fixture-${index.toString().padStart(3, "0")}` });
    card.witnessTexts = [`Asset ${index}: ${"Reviewed control and reserve evidence. ".repeat(220)}`];
    card.evidence.reasons = [{ code: "unresolved-control-identity", message: "~0", path: "control:incidentState" }];
    return card;
  });
  const publication = makeWorkerSafetyScoreV9Publication({ cards });
  await persistAndMaterialize(db, currentInput(publication));
  return { sqlite, db, publication };
}

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
  await persistAndMaterialize(db, currentInput(publication));
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
  it.each(["legacy", "dictionary"] as const)("serves identical warm bytes from %s storage and leaves cold reads pending", async encoding => {
    const { sqlite, db, publication } = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(publication.publishedAtSec * 1000);
    const before = await handleReportCardsV9(db);
    const body = await before.text();
    const etag = before.headers.get("ETag");
    const stored = await publicationCodec.serializeSafetyScoreV9PublicationWithEncoding(publication, encoding);
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(stored, SAFETY_SCORE_V9_CACHE_KEYS.publication);
    const decode = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    const warm = await handleReportCardsV9(db);
    expect(warm.status).toBe(200);
    expect(await warm.text()).toBe(body);
    expect(warm.headers.get("ETag")).toBe(etag);
    expect(decode).not.toHaveBeenCalled();
    sqlite.exec("DELETE FROM safety_score_public_manifests; DELETE FROM safety_score_public_fragments;");
    const pending = await handleReportCardsV9(db);
    expect(pending.status).toBe(503);
    expect(pending.headers.get("Cache-Control")).toBe("no-store");
    expect(await pending.json()).toMatchObject({ reason: "v9-public-materialization-pending" });
    expect(decode).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests").get()!.n).toBe(0);
  });

  it("negotiates compact freshness without changing cards, accepted storage or the old strict wire", async () => {
    const { sqlite, db } = database();
    const publication = makeWorkerSafetyScoreV9Publication();
    publication.pillarFreshness = { dexMaxAgeSec: 5,
      dexObservedAtSec: publication.cards.map(() => publication.asOfSec - 6) };
    publication.sourceGenerations.dex = "captured-dex-generation";
    for (const card of publication.cards) {
      card.pillars.backing.freshness = "unknown";
      card.pillars.exit.freshness = "stale";
      card.pillars.control.freshness = "unknown";
      card.evidence.freshness = "stale";
    }
    await persistAndMaterialize(db, currentInput(publication));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(publication.publishedAtSec * 1000);
    const stored = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.value;
    const plain = await handleReportCardsV9(db);
    const marked = await handleReportCardsV9(db, new URL("https://example.com/api/report-cards/v9?freshness=operands"));
    expect(plain.status).toBe(200);
    expect(marked.status).toBe(200);
    const legacy = await plain.json();
    const operands = ReportCardsV9CurrentResponseSchema.parse(await marked.json());
    const oldSchema = z.strictObject(ReportCardsV9CurrentResponseSchema.shape).omit({ pillarFreshness: true });
    expect(oldSchema.safeParse(legacy).success).toBe(true);
    expect(oldSchema.safeParse(operands).success).toBe(false);
    expect(operands.pillarFreshness).toEqual(publication.pillarFreshness);
    const { pillarFreshness: _metadata, ...withoutOperands } = operands;
    expect(withoutOperands).toEqual(legacy);
    expect(marked.headers.get("ETag")).not.toBe(plain.headers.get("ETag"));
    const id = publication.cards[0]!.id;
    const detail = await handleReportCardsV9Detail(db, new URL(`https://example.com/api/report-cards/v9-detail?stablecoin=${id}&freshness=operands`));
    const detailBody = ReportCardsV9DetailResponseSchema.parse(await detail.json());
    expect(detailBody.pillarFreshness).toEqual({
      dexMaxAgeSec: 5, dexObservedAtSec: [publication.pillarFreshness.dexObservedAtSec[0]],
    });
    const oldDetail = await handleReportCardsV9Detail(db, new URL(`https://example.com/api/report-cards/v9-detail?stablecoin=${id}`));
    expect(await oldDetail.json()).not.toHaveProperty("pillarFreshness");
    expect(await (await handleReportCardsV9Table(db)).json()).not.toHaveProperty("pillarFreshness");
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.value).toBe(stored);
  });

  it("bounds 397-card fragment round trips under D1 latency without changing bytes, identity or ETag", async () => {
    const { sqlite, db, publication } = await seedCohort();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(publication.publishedAtSec * 1000);
    const manifest = readManifest(sqlite);
    expect(manifest.bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(manifest.fragments.length).toBeGreaterThan(16);
    const source = await loadActiveSafetyScoreSource(db);
    expect(source.kind).toBe("v9");
    const { reader, reads } = instrumentReads(db, 10);
    const response = await handleReportCardsV9(reader);
    expect(response.status).toBe(200);
    const fragmentReads = reads.filter(read => read.sql.includes("SELECT ordinal, body"));
    expect(reads.length).toBe(1 + fragmentReads.length);
    expect(fragmentReads.length).toBeLessThanOrEqual(Math.ceil(manifest.bytes / (4 * 1024 * 1024 - V9_PUBLIC_FRAGMENT_MAX_BYTES)));
    expect(fragmentReads.length).toBeLessThan(Math.ceil(manifest.fragments.length / 4));
    let expectedOffset = 0;
    for (const read of fragmentReads) {
      expect(read.bindings.slice(0, 3)).toEqual([publication.publicationGenerationId, manifest.version, manifest.payloadSha256]);
      const [offset, end] = read.bindings.slice(-2) as number[];
      expect(offset).toBe(expectedOffset);
      expect(end).toBeGreaterThan(offset);
      expect(manifest.fragments.slice(offset, end).reduce((bytes: number, fragment: { bytes: number }) => bytes + fragment.bytes, 0))
        .toBeLessThanOrEqual(4 * 1024 * 1024);
      expectedOffset = end!;
    }
    expect(expectedOffset).toBe(manifest.fragments.length);
    const expectedWire = `{"publicationHealth":${JSON.stringify(currentInput(publication).publicationHealth)}` +
      sqlite.prepare("SELECT body FROM safety_score_public_fragments ORDER BY ordinal").all().map(row => row.body).join("");
    const actualWire = await response.text();
    expect(actualWire).toBe(expectedWire);
    expect(JSON.parse(actualWire)).toEqual(source.snapshot);
    const expectedEtag = withRepresentationEtag(new Response(null, { headers: { "Cache-Control": "public, max-age=60" } }), ["report-cards-v9", {
      version: manifest.version, generationId: publication.publicationGenerationId, sha256: manifest.sha256,
    }, currentInput(publication).publicationHealth]).headers.get("ETag");
    expect(expectedEtag).not.toBeNull();
    expect(response.headers.get("ETag")).toBe(expectedEtag);
  });

  it("coalesces the maximum 128 small fragments by bytes, not a fixed row count", async () => {
    const { sqlite, db } = await seed();
    const manifest = readManifest(sqlite);
    const body = sqlite.prepare("SELECT body FROM safety_score_public_fragments ORDER BY ordinal").all().map(row => row.body).join("");
    const fragments = Array.from({ length: 128 }, (_, index) =>
      body.slice(Math.floor(index * body.length / 128), Math.floor((index + 1) * body.length / 128)));
    manifest.fragments = fragments.map(text => ({ bytes: Buffer.byteLength(text, "utf8"), sha256: sha256HexFromUtf8Chunks([text]) }));
    sqlite.exec("DELETE FROM safety_score_public_fragments");
    const insert = sqlite.prepare("INSERT INTO safety_score_public_fragments VALUES (?, ?, ?, ?, ?)");
    fragments.forEach((text, ordinal) => insert.run(manifest.safetyScoreIdentity.publicationGenerationId,
      manifest.version, manifest.payloadSha256, ordinal, text));
    sqlite.prepare("UPDATE safety_score_public_manifests SET manifest = ?").run(stableJsonStringifyV1(manifest));
    const { reader, reads } = instrumentReads(db);
    const response = await handleReportCardsV9(reader);
    expect(response.status).toBe(200);
    expect(reads.length).toBe(2);
    expect(reads[1]!.bindings.slice(-2)).toEqual([0, 128]);
    expect(await response.text()).toContain(body);
  });

  it.each(["missing", "wrong-hash", "wrong-order", "body-hash"])("rejects late %s corruption before headers across coalesced reads", async mode => {
    const { sqlite, db } = await seedCohort();
    const manifest = readManifest(sqlite);
    const last = manifest.fragments.length - 1;
    if (mode === "body-hash") {
      manifest.sha256 = "f".repeat(64);
      sqlite.prepare("UPDATE safety_score_public_manifests SET manifest = ?").run(stableJsonStringifyV1(manifest));
    } else if (mode === "missing") {
      const original = db.prepare.bind(db);
      let removed = false;
      // Remove after the joined count read, not before admission.
      vi.spyOn(db, "prepare").mockImplementation(sql => {
        if (!removed && sql.includes("SELECT ordinal, body")) {
          removed = true;
          sqlite.prepare("DELETE FROM safety_score_public_fragments WHERE ordinal = ?").run(last);
        }
        return original(sql);
      });
    } else if (mode === "wrong-hash") {
      sqlite.prepare("UPDATE safety_score_public_fragments SET body = 'X' || substr(body, 2) WHERE ordinal = ?").run(last);
    } else {
      sqlite.prepare("UPDATE safety_score_public_fragments SET ordinal = 127 WHERE ordinal = ?").run(last);
    }
    const response = await handleReportCardsV9(db);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ reason: mode === "body-hash" ? "v9-public-body-integrity-invalid"
      : mode === "wrong-hash" ? "v9-public-fragment-integrity-invalid" : "v9-public-fragments-missing" });
  });

  it("preserves rated, NR, technical pipeline gaps and partial-pillar evidence across the full cohort", async () => {
    const { db } = database();
    const cards = [
      makeReportCardsV9Card({ id: "a-rated" }),
      makeReportCardsV9Card({ id: "b-nr", score: null, grade: "NR",
        nrReasons: [{ code: "unresolved-control-identity", message: "Control identity unresolved", field: null, origin: "asset" }] }),
      makeReportCardsV9PartialCard("exit", "A", { id: "c-partial" }),
      makeReportCardsV9PipelineGapCard("control", "B", { id: "d-gap" }),
    ];
    await persistAndMaterialize(db, currentInput(makeWorkerSafetyScoreV9Publication({ cards })));
    await assertServedEquivalent(db);
  });

  it("authenticates and streams multiple UTF-8 fragments without splitting surrogate pairs", async () => {
    const { db, sqlite } = database();
    const publication = makeWorkerSafetyScoreV9Publication();
    const text = "\uD83D\uDE80".repeat(180_000);
    publication.cards[0]!.witnessTexts = [text];
    publication.cards[0]!.evidence.reasons = [{ code: "unresolved-control-identity", message: "~0", path: "control:incidentState" }];
    await persistAndMaterialize(db, currentInput(publication));
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

  it("preserves source clocks across hits and expiry; computes freshness at the request instant", async () => {
    const { db, publication } = await seed();
    const budget = SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC;
    for (const age of [0, budget - 0.5, budget, budget + 1, budget * 10, -API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC - 1]) {
      vi.useFakeTimers();
      vi.setSystemTime((publication.publishedAtSec + age) * 1000);
      const response = await handleReportCardsV9(db);
      const body = await response.json();
      expect(body).toMatchObject({ updatedAt: publication.publishedAtSec, asOfSec: publication.asOfSec, source: { sourceGenerations: publication.sourceGenerations } });
      expect(response.headers.get("Age")).toBeNull();
      if (age >= budget || age < 0) expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Safety-Score-Status")).toBe(age > budget || age < 0 ? "stale" : "current");
      expect(response.headers.get("X-Safety-Score-Freshness-Budget")).toBe(String(budget));
      expect(response.headers.get("X-Safety-Score-Generation")).toBe(publication.publicationGenerationId);
    }

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

  it("without deferral, atomically rolls back canonical acceptance when required fragments cannot be written", async () => {
    const { db, sqlite } = await seed();
    const before = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
    const manifests = sqlite.prepare("SELECT * FROM safety_score_public_manifests").all();
    sqlite.exec("CREATE TRIGGER refuse_fragment BEFORE INSERT ON safety_score_public_fragments BEGIN SELECT RAISE(ABORT, 'fragment failed'); END");
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await expect(persistSafetyScoreV9Publication(db, currentInput(next))).rejects.toThrow();
    expect(sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(before);
    expect(sqlite.prepare("SELECT * FROM safety_score_public_manifests").all()).toEqual(manifests);
  });

  it("without deferral, selects the staged generation inside the acceptance batch", async () => {
    const { db, sqlite } = await seed();
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    expect((await persistSafetyScoreV9Publication(db, currentInput(next))).acceptedMaterialization).toBeNull();
    expect(readManifest(sqlite).safetyScoreIdentity.publicationGenerationId).toBe(next.publicationGenerationId);
    expect(JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY)!.value as string))
      .toMatchObject({ publicationGenerationId: next.publicationGenerationId });
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({ updatedAt: next.publishedAtSec });
  });

  it("keeps acceptance and serves the previous whole generation when required fragments cannot be written", async () => {
    const { db, sqlite, publication } = await seed();
    const expected = await (await handleReportCardsV9(db)).json() as object;
    const manifests = sqlite.prepare("SELECT * FROM safety_score_public_manifests").all();
    const marker = sqlite.prepare("SELECT * FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY);
    expect(JSON.parse(marker!.value as string)).toMatchObject({ publicationGenerationId: publication.publicationGenerationId });
    sqlite.exec("CREATE TRIGGER refuse_fragment BEFORE INSERT ON safety_score_public_fragments BEGIN SELECT RAISE(ABORT, 'fragment failed'); END");
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    const persisted = await persistSafetyScoreV9Publication(db, { ...currentInput(next), deferPublicMaterialization: true });
    await expect(materializeV9AcceptedPublication(db, persisted.acceptedMaterialization!)).rejects.toThrow();
    expect(sqlite.prepare("SELECT * FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY)).toEqual(marker);
    expect(sqlite.prepare("SELECT * FROM safety_score_public_manifests").all()).toEqual(manifests);
    vi.useFakeTimers({ toFake: ["Date"] });
    const decode = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    for (const age of [60, CRON_SCHEDULE_CADENCES.v9PublicationOffset.intervalSec, CRON_SCHEDULE_CADENCES.v9PublicationOffset.intervalSec + 1, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1]) {
      vi.setSystemTime((next.publishedAtSec + age) * 1000);
      const withinLagBudget = age <= CRON_SCHEDULE_CADENCES.v9PublicationOffset.intervalSec;
      const lagging = await handleReportCardsV9(db);
      expect(lagging.status).toBe(200);
      expect(lagging.headers.get("X-Safety-Score-Status")).toBe(withinLagBudget ? "current" : "held");
      expect(lagging.headers.get("X-Safety-Score-Generation")).toBe(publication.publicationGenerationId);
      expect(lagging.headers.get("X-Safety-Score-Freshness-Budget")).toBe(String(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC));
      expect(lagging.headers.get("X-Data-Updated-At")).toBe(String(publication.publishedAtSec));
      if (!withinLagBudget) {
        expect(lagging.headers.get("Cache-Control")).toBe("no-store");
        expect(lagging.headers.get("ETag")).toBeNull();
      }
      expect(await lagging.json()).toEqual({ ...expected, publicationHealth: {
        ...currentInput(next).publicationHealth,
        acceptedPublicationGenerationId: publication.publicationGenerationId, acceptedAtSec: publication.publishedAtSec,
        ...(!withinLagBudget ? { status: "held", heldSinceSec: next.publishedAtSec,
          reasons: [{ code: "v9-public-materialization-pending" }] } : {}),
      } });
    }
    sqlite.exec("DROP TRIGGER refuse_fragment");
    expect((await handleReportCardsV9(db)).headers.get("X-Safety-Score-Status")).toBe("held");
    expect(decode).not.toHaveBeenCalled();
    // Only the heavy materializer advances selection after writes recover.
    await materializeV9AcceptedPublication(db, persisted.acceptedMaterialization!);
    expect(JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY)!.value as string))
      .toMatchObject({ publicationGenerationId: next.publicationGenerationId, publishedAtSec: next.publishedAtSec });
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({
      updatedAt: next.publishedAtSec, publicationHealth: currentInput(next).publicationHealth,
    });
  });

  it("does not select a materialization whose generation is no longer accepted", async () => {
    const { db, sqlite, publication } = await seed();
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    const third = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 150, publicationGenerationId: "report-cards:v9:third" });
    const persisted = await persistSafetyScoreV9Publication(db, { ...currentInput(next), deferPublicMaterialization: true });
    await persistSafetyScoreV9Publication(db, { ...currentInput(third), deferPublicMaterialization: true });
    expect(await materializeV9AcceptedPublication(db, persisted.acceptedMaterialization!))
      .toEqual({ status: "superseded", publicationGenerationId: next.publicationGenerationId });
    expect(sqlite.prepare("SELECT generation_id FROM safety_score_public_manifests WHERE retired_at IS NULL").all())
      .toEqual([{ generation_id: publication.publicationGenerationId }]);
  });

  it("does not collide on a reused result digest and protects replaced bytes for in-flight grace", async () => {
    const { db, sqlite, publication } = await seed();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const next = makeWorkerSafetyScoreV9Publication({ resultDigest: publication.resultDigest, publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await persistAndMaterialize(db, currentInput(next));
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({ updatedAt: 130, safetyScoreIdentity: { publicationGenerationId: next.publicationGenerationId } });
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests").get()!.n).toBe(2);
    vi.setSystemTime((1000 + V9_PUBLIC_READ_GRACE_SEC + 1) * 1000);
    const third = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 150, publicationGenerationId: "report-cards:v9:third" });
    await persistAndMaterialize(db, currentInput(third));
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests WHERE generation_id = ?").get(publication.publicationGenerationId)!.n).toBe(0);
  });

  it("never advances representation selection on a stale accepted writer", async () => {
    const { db, sqlite, publication } = await seed();
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await persistAndMaterialize(db, currentInput(next));
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
    await persistAndMaterialize(db, currentInput(publication));
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
    const { db, sqlite, publication } = await seedCohort();
    const oldRows = sqlite.prepare("SELECT key, value, updated_at FROM cache").all();
    const expected = ReportCardsV9CurrentResponseSchema.parse(await (await handleReportCardsV9(db)).json());
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    await persistAndMaterialize(db, currentInput(next));
    const nextRows = sqlite.prepare("SELECT key, value, updated_at FROM cache").all();
    const selection = sqlite.prepare("UPDATE safety_score_public_manifests SET retired_at = CASE WHEN generation_id = ? THEN NULL ELSE 1 END");
    for (const row of oldRows) sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(row.value, row.updated_at, row.key);
    selection.run(publication.publicationGenerationId);
    let raced = false;
    const reader = createSqliteD1(sqlite, { onAll(sql) {
      if (!raced && sql.includes("FROM safety_score_public_fragments")) {
        raced = true;
        for (const row of nextRows) sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(row.value, row.updated_at, row.key);
        selection.run(next.publicationGenerationId);
      }
    } });
    expect(await (await handleReportCardsV9(reader)).json()).toEqual(expected);
    expect(raced).toBe(true);
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({
      updatedAt: next.publishedAtSec, safetyScoreIdentity: { publicationGenerationId: next.publicationGenerationId },
    });
    expect(expected.updatedAt).toBe(publication.publishedAtSec);
  });

  it("never imports the full parser or writes during concurrent cold reads", async () => {
    const source = readFileSync(new NodeURL("../../lib/report-cards-v9-materialization.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bparseSafetyScoreV9Publication\b/);
    const { db, sqlite } = await seed();
    sqlite.exec("DELETE FROM safety_score_public_manifests; DELETE FROM safety_score_site_manifests");
    const decode = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    const rows = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
    const otherIsolate = createSqliteD1(sqlite);
    for (const response of await Promise.all([
      handleReportCardsV9(db), handleReportCardsV9(otherIsolate), handleReportCardsV9Table(otherIsolate),
      handleReportCardsV9Detail(otherIsolate, new URL("https://example.com/api/report-cards/v9-detail?stablecoin=usdc-circle")),
    ])) {
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ reason: "v9-public-materialization-pending" });
    }
    expect(decode).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(rows);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests").get()!.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests").get()!.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM cron_leases").get()!.n).toBe(0);
  });

  it("does not treat an independently recorded failed attempt as a hold", async () => {
    const { db, sqlite, publication } = await seed();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      SAFETY_SCORE_V9_CACHE_KEYS.failedPublicationAttempt, '{"outcome":"failed"}', 999,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(publication.publishedAtSec * 1000);
    const response = await handleReportCardsV9(db);
    expect(response.headers.get("X-Safety-Score-Status")).toBe("current");
    expect(await response.json()).toMatchObject({ publicationHealth: { status: "current" } });
  });
});
