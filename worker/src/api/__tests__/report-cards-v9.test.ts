import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { projectV9Table, projectV9Detail } from "@shared/lib/report-cards-v9-projections";
import { D1_BATCH_SIZE } from "../../lib/constants";
import { D1_MAX_BOUND_PARAMETERS } from "../../lib/db";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeReportCardsV9Card, makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard, makeReportCardsV9PricedExcludedCard } from "@shared/test-utils/report-cards-v9";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC } from "../../lib/api-freshness-age";
import { ReportCardsV9CurrentResponseSchema } from "\@shared/types/report-cards-v9-current";
import { ReportCardsV9TableResponseSchema, ReportCardsV9DetailResponseSchema } from "@shared/types/report-cards-v9-projections";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { V9_PUBLIC_READ_GRACE_SEC, V9_PUBLIC_FRAGMENT_MAX_BYTES } from "@shared/types/report-cards-v9-materialization";
import { makeReportCardsV9Response, makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
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
import { safetyScoreSnapshotHeaders, withRepresentationEtag } from "../../lib/api-response";
import { isFreshnessWarningHeader } from "@shared/lib/warning-headers";
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

// The 397-card cohort is a real >4 MiB multi-fragment publication. Seeding it
// costs ~0.8s (encode, hash, fragment insert), so the seeded database is
// serialized once and restored per case: every case still owns an independent
// copy of the same bytes.
let cohortTemplate: Uint8Array | undefined;
let cohortPublication: ReturnType<typeof makeWorkerSafetyScoreV9Publication> | undefined;

async function seedCohort() {
  if (cohortTemplate === undefined) {
    const { sqlite, db } = database();
    // Full wire-card shapes, with resolved research text, not a byte-only blob.
    const cards = Array.from({ length: 397 }, (_, index) => {
      const card: SafetyScoreV9CurrentCard = makeReportCardsV9Card({ id: `fixture-${index.toString().padStart(3, "0")}` });
      card.witnessTexts = [`Asset ${index}: ${"Reviewed control and reserve evidence. ".repeat(220)}`];
      card.evidence.reasons = [{ code: "unresolved-control-identity", message: "~0", path: "control:incidentState" }];
      return card;
    });
    cohortPublication = makeWorkerSafetyScoreV9Publication({ cards });
    await persistAndMaterialize(db, currentInput(cohortPublication));
    cohortTemplate = sqlite.serialize();
  }
  const sqlite = new DatabaseSync(":memory:");
  sqlite.deserialize(cohortTemplate);
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite), publication: cohortPublication! };
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

  it("emits the documented 110 warning for a future-dated publication beyond the generic skew allowance", () => {
    const nowSec = 1_800_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const publication = makeReportCardsV9Response();
    const updatedAt = nowSec + 120;
    const headers = safetyScoreSnapshotHeaders({
      updatedAt,
      publicationHealth: {
        ...publication.publicationHealth,
        acceptedAtSec: updatedAt,
        attemptedAtSec: updatedAt,
      },
    }, publication.safetyScoreIdentity.publicationGenerationId);

    expect(headers["X-Safety-Score-Status"]).toBe("stale");
    expect(headers["X-Data-Freshness"]).toBe("stale");
    expect(headers["X-Data-Freshness-Reason"]).toBe("future-timestamp");
    // docs/report-cards.md#api requires `Warning: 110` for a non-held
    // publication that is future at any skew. The generic 199 is not a
    // freshness verdict for endpoint probes.
    expect(headers.Warning).toMatch(/^110 - /);
    expect(isFreshnessWarningHeader(headers.Warning)).toBe(true);
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

describe("generation-bound compact Safety Scores", () => {
  async function seed() {
    const { sqlite, db } = database();
    const publication = makeWorkerSafetyScoreV9Publication({ cards: [
      makeReportCardsV9Card({ id: "dai-makerdao" }),
      makeReportCardsV9PartialCard("exit", "A", { id: "usdc-circle" }),
      makeReportCardsV9PipelineGapCard("control", "B", { id: "usde-ethena" }),
      makeReportCardsV9Card({ id: "usdt-tether", score: null, grade: "NR",
        nrReasons: [{ code: "unresolved-control-identity", message: "Control identity unresolved", field: null, origin: "asset" }] }),
    ] });
    await persistAndMaterialize(db, currentInput(publication));
    return { sqlite, db, publication };
  }
  const detailUrl = (id = "usdc-circle") => new URL(`https://example.com/api/report-cards/v9-detail?stablecoin=${id}`);

  it("materializes representation version 3 with local authority exposure", async () => {
    const { sqlite } = await seed();
    const manifests = sqlite.prepare(
      "SELECT manifest FROM safety_score_public_manifests UNION ALL SELECT manifest FROM safety_score_site_manifests",
    ).all();
    expect(manifests).toHaveLength(6);
    for (const row of manifests) expect(JSON.parse(row.manifest as string).version).toBe(3);
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
      updateHealth(sqlite, held);
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
    updateHealth(sqlite, mismatch);
    expect(await (await handleReportCardsV9Table(db)).json()).toMatchObject({ publicationHealth: { status: "held", reasons: [{ code: "assessment-failed" }] } });
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth);
    for (const response of [await handleReportCardsV9Table(db), await handleReportCardsV9Detail(db, detailUrl())]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ reason: "v9-public-health-unavailable" });
    }
  });

  it.each(["A", "B"] as const)("selects one coherent full/table/detail generation for a priced cause-%s excluded card (#1674)", async cause => {
    const { db, publication } = await seed();
    const next = makeWorkerSafetyScoreV9Publication({
      cards: publication.cards.map(card => card.id === "usdc-circle" ? makeReportCardsV9PricedExcludedCard(cause, { id: "usdc-circle" }) : card),
      publishedAtSec: 130, publicationGenerationId: "report-cards:v9:priced-excluded",
    });
    const persisted = await persistSafetyScoreV9Publication(db, { ...currentInput(next), deferPublicMaterialization: true });
    await materializeV9AcceptedPublication(db, persisted.acceptedMaterialization!);
    const responses = [await handleReportCardsV9(db), await handleReportCardsV9Table(db), await handleReportCardsV9Detail(db, detailUrl())];
    const bodies = await Promise.all(responses.map(response => response.json() as Promise<{ completeness: unknown }>));
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Safety-Score-Generation")).toBe(next.publicationGenerationId);
      expect(bodies[index]).toMatchObject({
        safetyScoreIdentity: { publicationGenerationId: next.publicationGenerationId },
        completeness: bodies[0].completeness, updatedAt: next.publishedAtSec,
      });
    }
    const table = ReportCardsV9TableResponseSchema.parse(bodies[1]);
    expect(table.cards.find(card => card.id === "usdc-circle")!.pillars.exit)
      .toEqual({ score: null, aggregationDisposition: "excluded-a-b", pricedUnknown: { cause: "U", score: 50 } });
    expect(ReportCardsV9DetailResponseSchema.parse(bodies[2]).cards[0]!.pillars.exit.aggregationDisposition).toBe("excluded-a-b");
  });

  it("leaves a newly added coin pending until heavy selects its generation", async () => {
    const { db, sqlite, publication } = await seed();
    const next = makeWorkerSafetyScoreV9Publication({
      cards: [publication.cards[0]!, makeReportCardsV9Card({ id: "lusd-liquity" }), ...publication.cards.slice(1)],
      publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next",
    });
    const persisted = await persistSafetyScoreV9Publication(db, { ...currentInput(next), deferPublicMaterialization: true });
    const before = sqlite.prepare("SELECT * FROM safety_score_site_manifests").all();
    const decode = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    const pending = await handleReportCardsV9Detail(db, detailUrl("lusd-liquity"));
    expect(pending.status).toBe(503);
    expect(pending.headers.get("Cache-Control")).toBe("no-store");
    expect(await pending.json()).toMatchObject({ reason: "v9-public-materialization-pending" });
    expect(decode).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT * FROM safety_score_site_manifests").all()).toEqual(before);
    await materializeV9AcceptedPublication(db, persisted.acceptedMaterialization!);
    expect(await (await handleReportCardsV9Detail(db, detailUrl("lusd-liquity"))).json()).toMatchObject({
      coinId: "lusd-liquity", updatedAt: next.publishedAtSec, publicationHealth: { status: "current" },
    });
  });

  it.each(["usr-resolv", "buck-buck-assets", "usds-sky"])("returns an explicit nonmember reason for %s without decoding", async id => {
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

  it("fails closed on a missing membership census without decoding", async () => {
    const { db, sqlite } = await seed();
    sqlite.exec("DELETE FROM safety_score_site_manifests");
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex);
    const parse = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    expect(await (await handleReportCardsV9Detail(db, detailUrl())).json()).toMatchObject({ reason: "safety-score-index-missing" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not treat another accepted generation's census as absence", async () => {
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

  it("keeps acceptance and the previous selected generation when a required compact write fails", async () => {
    const { db, sqlite, publication } = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(140_000);
    const table = await (await handleReportCardsV9Table(db)).json() as object;
    const detail = await (await handleReportCardsV9Detail(db, detailUrl())).json() as object;
    sqlite.exec("CREATE TRIGGER refuse_site BEFORE INSERT ON safety_score_site_fragments BEGIN SELECT RAISE(ABORT, 'site write failed'); END");
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    const persisted = await persistSafetyScoreV9Publication(db, { ...currentInput(next), deferPublicMaterialization: true });
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex)!.updated_at).toBe(130);
    await expect(materializeV9AcceptedPublication(db, persisted.acceptedMaterialization!)).rejects.toThrow();
    for (const age of [60, CRON_SCHEDULE_CADENCES.v9PublicationOffset.intervalSec, CRON_SCHEDULE_CADENCES.v9PublicationOffset.intervalSec + 1]) {
      vi.setSystemTime((next.publishedAtSec + age) * 1000);
      const withinLagBudget = age <= CRON_SCHEDULE_CADENCES.v9PublicationOffset.intervalSec;
      const lagHealth = { ...currentInput(next).publicationHealth,
        acceptedPublicationGenerationId: publication.publicationGenerationId, acceptedAtSec: publication.publishedAtSec,
        ...(!withinLagBudget ? { status: "held", heldSinceSec: next.publishedAtSec,
          reasons: [{ code: "v9-public-materialization-pending" }] } : {}),
      };
      const responses = [await handleReportCardsV9Table(db), await handleReportCardsV9Detail(db, detailUrl())];
      for (const [index, response] of responses.entries()) {
        expect(response.headers.get("X-Safety-Score-Status")).toBe(withinLagBudget ? "current" : "held");
        expect(response.headers.get("X-Safety-Score-Generation")).toBe(publication.publicationGenerationId);
        expect(response.headers.get("X-Safety-Score-Freshness-Budget")).toBe(String(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC));
        if (!withinLagBudget) expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toEqual({ ...(index === 0 ? table : detail), publicationHealth: lagHealth });
      }
    }
  });

  it("does not re-anchor a previous generation as current when the accepted publication clock is ahead of the reader", async () => {
    const { db, sqlite, publication } = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(140_000);
    sqlite.exec("CREATE TRIGGER refuse_site BEFORE INSERT ON safety_score_site_fragments BEGIN SELECT RAISE(ABORT, 'site write failed'); END");
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next" });
    const persisted = await persistSafetyScoreV9Publication(db, { ...currentInput(next), deferPublicMaterialization: true });
    await expect(materializeV9AcceptedPublication(db, persisted.acceptedMaterialization!)).rejects.toThrow();

    // The accepted row's clock leads this reading isolate by 10 s (writer/reader
    // skew). A future-dated clock is not a known lag within the one-cadence
    // budget, so the previous generation is held rather than re-anchored.
    vi.setSystemTime((next.publishedAtSec - 10) * 1000);
    const response = await handleReportCardsV9(db);
    const body = await response.json() as { publicationHealth: unknown };

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Safety-Score-Status")).toBe("held");
    expect(response.headers.get("X-Safety-Score-Generation")).toBe(publication.publicationGenerationId);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.publicationHealth).toEqual({
      ...currentInput(next).publicationHealth,
      acceptedPublicationGenerationId: publication.publicationGenerationId,
      acceptedAtSec: publication.publishedAtSec,
      status: "held",
      heldSinceSec: next.publishedAtSec,
      reasons: [{ code: "v9-public-materialization-pending" }],
    });
  });

  it("keeps the selected generation when source cards change between fragment passes", async () => {
    const { db, sqlite, publication } = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(140_000);
    const next = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 130, publicationGenerationId: "report-cards:v9:next",
      cards: [makeReportCardsV9Card({ id: "dai-makerdao", evidence: { level: "adequate", freshness: "current", reasons: [{
        code: "unresolved-control-identity", message: "x".repeat(2_400_000), path: "control:incidentState",
      }] } }), makeReportCardsV9Card({ id: "usdc-circle" })] });
    const persisted = await persistSafetyScoreV9Publication(db, { ...currentInput(next), deferPublicMaterialization: true });
    const source = structuredClone(persisted.acceptedMaterialization!);
    const canonical = sqlite.prepare("SELECT * FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication);
    const selected = sqlite.prepare("SELECT * FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY);
    const batch = db.batch.bind(db);
    let mutated = false;
    const spy = vi.spyOn(db, "batch").mockImplementation(async statements => {
      const result = await batch(statements);
      if (!mutated) {
        // A large first card forces a flush before the second pass reaches this card.
        source.publication.cards[1]!.evidence.reasons.push({
          code: "unresolved-control-identity", message: "Changed after manifest measurement", path: "control:incidentState",
        });
        mutated = true;
      }
      return result;
    });
    await expect(materializeV9AcceptedPublication(db, source)).rejects.toThrow("v9-public-materialization-source-changed");
    spy.mockRestore();
    expect(mutated).toBe(true);
    expect(sqlite.prepare("SELECT * FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)).toEqual(canonical);
    expect(sqlite.prepare("SELECT * FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY)).toEqual(selected);
    expect(await (await handleReportCardsV9(db)).json()).toMatchObject({ updatedAt: publication.publishedAtSec });
  });

  it.each([1, 397])("coalesces %i cards within staging caps while preserving accepted reads", async cardCount => {
    const { db, sqlite, publication } = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(140_000);
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
          const selection = writes.some(({ values }) => values[0] === V9_PUBLIC_MATERIALIZATION_CACHE_KEY);
          if (staging || !selection) {
            // Acceptance commits first; readers keep the previous whole generation until selection.
            expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.updated_at)
              .toBe(next.publishedAtSec);
            expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests WHERE generation_id = ? AND retired_at IS NULL")
              .get(next.publicationGenerationId)!.n).toBe(0);
            for (const response of [
              await handleReportCardsV9(db), await handleReportCardsV9Table(db),
              await handleReportCardsV9Detail(db, detailUrl()),
            ]) {
              expect(response.status).toBe(200);
              expect(await response.json()).toMatchObject({ updatedAt: publication.publishedAtSec,
                publicationHealth: { status: "current", reasons: [],
                  acceptedPublicationGenerationId: publication.publicationGenerationId, acceptedAtSec: publication.publishedAtSec } });
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
    await persistAndMaterialize(observedDb, currentInput(next));
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

  it.each(["public", "site"])("refuses selection if one staged %s fragment disappears before the pointer switch", async surface => {
    const { db, sqlite, publication } = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(140_000);
    const marker = sqlite.prepare("SELECT * FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY);
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
    await expect(persistAndMaterialize(racedDb, currentInput(next))).rejects.toThrow();
    expect(removed).toBe(true);
    expect(sqlite.prepare("SELECT * FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY)).toEqual(marker);
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.updated_at).toBe(130);
    const table = await handleReportCardsV9Table(db);
    expect(table.status).toBe(200);
    expect(await table.json()).toMatchObject({ updatedAt: publication.publishedAtSec });
  });

  it("validates the selected coin parameter before reading storage", async () => {
    const { db } = await seed();
    expect((await handleReportCardsV9Detail(db, new URL("https://example.com/api/report-cards/v9-detail"))).status).toBe(400);
    expect((await handleReportCardsV9Detail(db, new URL("https://example.com/api/report-cards/v9-detail?stablecoin=usdc-circle&stablecoin=usdt-tether"))).status).toBe(400);
  });
});
