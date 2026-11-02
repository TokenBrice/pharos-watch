import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { sha256Hex } from "@shared/lib/sha256";
import { SAFETY_SCORE_COHORT_MAX_BYTES, SafetyScoreCohortSchema } from "@shared/types/safety-score-cohort";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { currentInput } from "./safety-score-v9-publication-store.test-support";
import { admitAndSerializeSafetyScoreV9Publication, parseSafetyScoreV9Publication, requireCurrentSafetyScoreV9Publication } from "../safety-score-v9/publication-codec";
import { buildSafetyScoreV9AcceptedPublicationBaseline } from "../safety-score-v9/publication-assessment";
import { persistSafetyScoreV9Publication } from "../safety-score-v9/publication-store";
import { SAFETY_SCORE_V9_CACHE_KEYS as keys } from "../safety-score-v9/publication-health";
import {
  buildSafetyScoreV9AcceptedBaselineProjection,
  buildSafetyScoreV9AcceptedProjections,
  buildSafetyScoreV9CohortProjection,
  buildSafetyScoreV9LenderCollateralProjection,
  parseSafetyScoreV9AcceptedBaselineProjection,
  parseSafetyScoreV9LenderCollateralProjection,
  serializeSafetyScoreV9AcceptedBaselineProjection,
  serializeSafetyScoreV9CohortProjection,
  serializeSafetyScoreV9LenderCollateralProjection,
  SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES,
  SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES,
} from "../safety-score-v9/accepted-projections";
import { loadActiveSafetyScoreIndex } from "../safety-score-index";
import { loadActiveSafetyScoreCohort } from "../safety-score-active-source";
import * as publicCache from "../report-cards-v9-cache";
import * as structuredLog from "../structured-log";
import { SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, reassembleSafetyScoreV9CohortStoredValue, shardSafetyScoreV9CohortStoredValue } from "../safety-score-v9/publication-chunks";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

async function fixture() {
  const fixture = fixtures.open();
  const publication = makeWorkerSafetyScoreV9Publication();
  await persistSafetyScoreV9Publication(fixture.db, { ...currentInput(publication), deferPublicMaterialization: true });
  const read = (key: string) => {
    const value = fixture.sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)!.value as string;
    const chunks = fixture.sqlite.prepare("SELECT key, value FROM cache WHERE key >= ? AND key < ? ORDER BY key")
      .all(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`) as { key: string; value: string }[];
    return JSON.parse(key === keys.cohort ? reassembleSafetyScoreV9CohortStoredValue(value, chunks) : value);
  };
  const write = (key: string, value: unknown) => {
    let stored = stableJsonStringifyV1(value);
    if (key === keys.cohort) {
      const sharded = shardSafetyScoreV9CohortStoredValue(stored);
      stored = sharded.envelope;
      fixture.sqlite.prepare("DELETE FROM cache WHERE key >= ? AND key < ?")
        .run(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`);
      for (const chunk of sharded.chunks) fixture.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run(chunk.key, chunk.value, publication.publishedAtSec);
    }
    fixture.sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(stored, key);
  };
  return { ...fixture, publication, read, write };
}

describe("accepted Safety Score cohort", () => {
  it.each(["current", "held"])("reads %s without decoding the publication", async status => {
    const { db, read, write, publication } = await fixture();
    const envelope = read(keys.publication);
    envelope.payload = "not-base64";
    write(keys.publication, envelope);
    if (status === "held") {
      const health = read(keys.publicationHealth);
      Object.assign(health, { status, heldSinceSec: health.attemptedAtSec, reasons: [{ code: "dex-stale" }] });
      write(keys.publicationHealth, health);
    }
    const prepare = vi.spyOn(db, "prepare");
    const result = await loadActiveSafetyScoreCohort(db);
    expect(result).toMatchObject({ kind: status === "current" ? "v9" : "held",
      snapshot: { updatedAt: publication.publishedAtSec, completeness: publication.completeness } });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]![0]).not.toMatch(/p\.value\s+AS/);
  });

  it("shares the index schema-cutover reason without falling back", async () => {
    const { db, read, write } = await fixture();
    write(keys.scoreIndex, { ...read(keys.scoreIndex), schemaVersion: 1 });
    expect(await loadActiveSafetyScoreIndex(db)).toMatchObject({ kind: "error", reason: "publication-schema-cutover-pending" });
    expect(await loadActiveSafetyScoreCohort(db)).toMatchObject({ kind: "error", reason: "publication-schema-cutover-pending",
      snapshot: null });
  });

  it.each([
    ["malformed JSON", "{", "safety-cohort-health-unavailable"],
    ["a pre-cutover schema", JSON.stringify({ schemaVersion: 1 }), "publication-schema-cutover-pending"],
  ])("fails closed on %s publication health", async (_label, value, reason) => {
    const { db, sqlite } = await fixture();
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(value, keys.publicationHealth);
    expect(await loadActiveSafetyScoreCohort(db)).toEqual({
      kind: "error", reason, detail: `Canonical Safety Score cohort unavailable: ${reason}`, snapshot: null,
    });
  });

  it.each([
    ["malformed JSON", "{", "safety-cohort-index-invalid"],
    ["a schema-invalid envelope", JSON.stringify({ schemaVersion: 2 }), "safety-cohort-index-invalid"],
  ])("fails closed on %s in the accepted index", async (_label, value, reason) => {
    const { db, sqlite } = await fixture();
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(value, keys.scoreIndex);
    expect(await loadActiveSafetyScoreCohort(db)).toEqual({
      kind: "error", reason, detail: `Canonical Safety Score cohort unavailable: ${reason}`, snapshot: null,
    });
  });

  it("reconstructs binding caps and serial dependencies from the accepted cohort graph", async () => {
    const { db } = fixtures.open();
    const cap = { kind: "track-record", limit: 49, reason: "Short reviewed track record.", source: "track-record" as const, binding: true };
    const publication = makeWorkerSafetyScoreV9Publication({
      cards: [makeWorkerV9Card({
        caps: [cap],
        bindingCap: cap,
        dependencies: {
          serial: [{
            upstreamAssetId: "parent-fixture",
            score: 62,
            ratingStatus: "rated",
            partialEvidence: null,
            causeGapRefs: [],
            limitedEvidenceCauses: [],
            blocked: false,
            dependencyType: "wrapper",
            wrapperForm: "strategy-vault",
          }],
          basket: [],
          cycleBlocked: false,
          reasonCodes: [],
        },
      })],
    });
    await persistSafetyScoreV9Publication(db, { ...currentInput(publication), deferPublicMaterialization: true });

    const result = await loadActiveSafetyScoreCohort(db);
    expect(result).toMatchObject({
      kind: "v9",
      snapshot: {
        cards: [{
          id: "usdc-circle",
          bindingCap: { kind: "track-record", limit: 49, reason: "Short reviewed track record.", binding: true },
          dependencies: { serial: [{ upstreamAssetId: "parent-fixture" }] },
        }],
      },
    });
  });

  it.each(["missing", "other-generation"])("rejects a %s cohort without decoding the publication", async scenario => {
    const { db, sqlite, read, write } = await fixture();
    if (scenario === "missing") sqlite.prepare("DELETE FROM cache WHERE key = ?").run(keys.cohort);
    else {
      const cohort = read(keys.cohort);
      cohort.safetyScoreIdentity.publicationGenerationId = "report-cards:v9:prior";
      write(keys.cohort, cohort);
    }
    const fullRead = vi.spyOn(publicCache, "loadPublishedReportCardsV9Snapshot");
    expect(await loadActiveSafetyScoreCohort(db)).toMatchObject({ kind: "error", snapshot: null,
      reason: scenario === "missing" ? "safety-cohort-missing" : "safety-cohort-publication-mismatch" });
    expect(fullRead).not.toHaveBeenCalled();
  });

  it("warns when only the cohort crosses its half-cap and rejects overflow before any persistence", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    publication.cards[0]!.sharedBookId = "x".repeat(SAFETY_SCORE_COHORT_MAX_BYTES / 2);
    const logger = vi.spyOn(structuredLog, "logWorkerEvent");
    const projections = buildSafetyScoreV9AcceptedProjections(publication);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({
      event: "safety_score_v9_accepted_projection_size_warning",
      metadata: expect.objectContaining({ cohortBytes: Buffer.byteLength(projections.cohort), cohortMaxBytes: SAFETY_SCORE_COHORT_MAX_BYTES }),
    }));
    publication.cards[0]!.sharedBookId = "x".repeat(SAFETY_SCORE_COHORT_MAX_BYTES);
    const { db } = fixtures.open();
    const batch = vi.spyOn(db, "batch");
    await expect(persistSafetyScoreV9Publication(db, currentInput(publication))).rejects.toThrow(/exceeds/);
    expect(batch).not.toHaveBeenCalled();
  });

  it.each(["malformed", "canonical", "clock", "digest", "identity", "count", "missing-health", "health-generation", "missing-chunk", "corrupt-chunk", "missing-index", "index-generation"])(
    "fails closed without decode fallback for %s", async scenario => {
      const { db, sqlite, read, write } = await fixture();
      const cohort = read(keys.cohort);
      if (scenario === "malformed") sqlite.prepare("UPDATE cache SET value = '{' WHERE key = ?").run(keys.cohort);
      if (scenario === "canonical") sqlite.prepare("UPDATE cache SET value = value || ' ' WHERE key = ?").run(keys.cohort);
      if (scenario === "clock") sqlite.prepare("UPDATE cache SET updated_at = updated_at + 1 WHERE key = ?").run(keys.cohort);
      if (scenario === "digest") { cohort.publicationResultDigest = "f".repeat(64); write(keys.cohort, cohort); }
      if (scenario === "identity") { cohort.safetyScoreIdentity.policyDigest = "f".repeat(64); write(keys.cohort, cohort); }
      if (scenario === "count") { cohort.cards = []; write(keys.cohort, cohort); }
      if (scenario === "missing-health") sqlite.prepare("DELETE FROM cache WHERE key = ?").run(keys.publicationHealth);
      if (scenario === "health-generation") { const health = read(keys.publicationHealth); health.acceptedPublicationGenerationId = "other"; write(keys.publicationHealth, health); }
      if (scenario === "missing-index") sqlite.prepare("DELETE FROM cache WHERE key = ?").run(keys.scoreIndex);
      if (scenario === "index-generation") { const index = read(keys.scoreIndex); index.safetyScoreIdentity.publicationGenerationId = "other"; write(keys.scoreIndex, index); }
      if (scenario === "missing-chunk") sqlite.prepare("DELETE FROM cache WHERE key >= ? AND key < ?")
        .run(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`);
      if (scenario === "corrupt-chunk") sqlite.prepare("UPDATE cache SET value = 'corrupted' WHERE key >= ? AND key < ?")
        .run(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`);
      const prepare = vi.spyOn(db, "prepare");
      const result = await loadActiveSafetyScoreCohort(db);
      expect(result).toMatchObject({ kind: "error", snapshot: null });
      expect(result.kind === "error" && result.reason).toMatch(/^safety-cohort-/);
      expect(prepare).toHaveBeenCalledTimes(2);
    },
  );

  it("admits a cohort above D1's row ceiling using bounded chunks in the acceptance batch", async () => {
    const { db, sqlite } = fixtures.open();
    const publication = makeWorkerSafetyScoreV9Publication();
    publication.cards[0]!.sharedBookId = "x".repeat(2_100_000);
    await persistSafetyScoreV9Publication(db, { ...currentInput(publication), deferPublicMaterialization: true });
    const chunks = sqlite.prepare("SELECT key, value FROM cache WHERE key >= ? AND key < ? ORDER BY key")
      .all(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((chunk) => Buffer.byteLength(String(chunk.value)) <= 512 * 1024)).toBe(true);
    const batch = vi.spyOn(db, "batch");
    expect(await loadActiveSafetyScoreCohort(db)).toMatchObject({ kind: "v9",
      snapshot: { cards: [{ sharedBookId: publication.cards[0]!.sharedBookId }] } });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
    const [metadata, chunkRows] = await batch.mock.results[0]!.value;
    expect(metadata.results).toHaveLength(1);
    expect(metadata.results[0]).toHaveProperty("score_index");
    expect(chunkRows.results).toHaveLength(chunks.length);
    for (const row of chunkRows.results) expect(Object.keys(row).sort()).toEqual(["chunk", "chunk_key"]);
  });

  it("preserves the index health-clock hold semantics and empty database unavailability", async () => {
    expect(await loadActiveSafetyScoreCohort(fixtures.open().db)).toMatchObject({ kind: "error", reason: "v9-snapshot-unavailable" });
    const { db, read, write } = await fixture();
    const health = read(keys.publicationHealth);
    health.acceptedAtSec--;
    write(keys.publicationHealth, health);
    expect(await loadActiveSafetyScoreCohort(db)).toMatchObject({ kind: "held" });
  });

  it("rejects oversize writes, rather than truncating the accepted projection", () => {
    const cohort = buildSafetyScoreV9CohortProjection(makeWorkerSafetyScoreV9Publication());
    cohort.cards[0]!.sharedBookId = "x";
    const initial = serializeSafetyScoreV9CohortProjection(cohort);
    cohort.cards[0]!.sharedBookId = "x".repeat(SAFETY_SCORE_COHORT_MAX_BYTES - Buffer.byteLength(initial) + 1);
    const exact = serializeSafetyScoreV9CohortProjection(cohort);
    expect(Buffer.byteLength(exact)).toBe(SAFETY_SCORE_COHORT_MAX_BYTES);
    cohort.cards[0]!.sharedBookId += "x";
    expect(() => serializeSafetyScoreV9CohortProjection(cohort)).toThrow(/exceeds/);
    expect(SafetyScoreCohortSchema.safeParse({ ...cohort, cards: [cohort.cards[0], cohort.cards[0]] }).success).toBe(false);
  });
});
describe("Safety Score V9 accepted projection writers", () => {
  it("preserves the complete comparison baseline deeply and as canonical bytes", async () => {
    const { publication } = await admitAndSerializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication());
    const projection = buildSafetyScoreV9AcceptedBaselineProjection(publication);
    const expected = buildSafetyScoreV9AcceptedPublicationBaseline(publication);
    expect(projection.baseline).toEqual(expected);
    expect(stableJsonStringifyV1(projection.baseline)).toBe(stableJsonStringifyV1(expected));
    const value = serializeSafetyScoreV9AcceptedBaselineProjection(projection);
    expect(parseSafetyScoreV9AcceptedBaselineProjection({ value, updatedAt: publication.publishedAtSec })).toEqual(projection);
    expect(projection).toMatchObject({ publicationResultDigest: publication.resultDigest,
      safetyScoreIdentity: { publicationGenerationId: publication.publicationGenerationId },
      expectedCount: publication.cards.length });
  });

  it("carries measured-route expiry witnesses through the baseline projection (10.35)", () => {
    const publication = makeWorkerSafetyScoreV9Publication({
      cards: [makeWorkerV9Card({ id: "alpha", score: null, grade: null, ratingStatus: "pipeline-gap" }), makeWorkerV9Card({ id: "beta" })],
    });
    const witness = { routeId: "dex:primary", dexGenerationId: "dex-liquidity-1", observationWindowEndedAt: publication.publishedAtSec, freshnessMaxSec: 10_800 };
    const value = serializeSafetyScoreV9AcceptedBaselineProjection(buildSafetyScoreV9AcceptedBaselineProjection(publication, { alpha: [witness] }));
    const parsed = parseSafetyScoreV9AcceptedBaselineProjection({ value, updatedAt: publication.publishedAtSec });
    expect(parsed.baseline.dexExpiryByAssetId).toEqual({ alpha: [witness] });
    // Without witnesses the projection keeps its pre-10.35 shape.
    expect(buildSafetyScoreV9AcceptedBaselineProjection(publication).baseline).not.toHaveProperty("dexExpiryByAssetId");
    // A witness on a rated card cannot be committed.
    expect(() => buildSafetyScoreV9AcceptedBaselineProjection(publication, { beta: [witness] })).toThrow();
  });

  it("retains every eligible card, canonical card SHA and stable local/foreign gaps with D > C > U precedence", () => {
    const cards = ["adverse", "curated", "unreferenced", "unknown"].map(id => makeWorkerV9Card({ id }));
    cards[0]!.pillars.backing.limitedEvidenceCauses = ["C", "D", "U"];
    cards[1]!.pillars.backing.limitedEvidenceCauses = ["C", "U"];
    cards[3]!.pillars.backing.limitedEvidenceCauses = ["U"];
    for (const card of cards) {
      card.localCauseGaps = ["z", "a"];
      card.foreignCauseGapRefs = [0, 1];
      card.pillars.backing.causeGapRefs = [0, 1, 2, 3];
    }
    const publication = makeWorkerSafetyScoreV9Publication({ cards,
      foreignCauseGaps: ["foreign:gap:a", "foreign:gap:z"] });
    const projection = buildSafetyScoreV9LenderCollateralProjection(publication);
    expect(Object.keys(projection.byAssetId)).toEqual(["adverse", "curated", "unknown", "unreferenced"]);
    expect(cards.map(card => projection.byAssetId[card.id]!.sourceCause)).toEqual(["D", "C", null, "U"]);
    for (const card of cards) {
      expect(projection.byAssetId[card.id]).toEqual({ assetId: card.id, backingScore: card.pillars.backing.score,
        cardSha256: sha256Hex(stableJsonStringifyV1(card)),
        sourceCause: projection.byAssetId[card.id]!.sourceCause,
        sourceGapIds: [`${card.id}:gap:a`, `${card.id}:gap:z`, "foreign:gap:a", "foreign:gap:z"].sort() });
    }
    const value = serializeSafetyScoreV9LenderCollateralProjection(projection);
    expect(parseSafetyScoreV9LenderCollateralProjection({ value, updatedAt: publication.publishedAtSec })).toEqual(projection);
  });

  it.each(["not-rated", "pipeline-gap", "excluded", "null", "nan", "negative", "over-100", "C-empty", "U-empty"] as const)(
    "omits ineligible %s cards without inventing a zero score", scenario => {
      const card = makeWorkerV9Card();
      if (scenario === "not-rated" || scenario === "pipeline-gap") card.ratingStatus = scenario;
      if (scenario === "excluded") card.pillars.backing.aggregationDisposition = "excluded-a-b";
      if (scenario === "null") card.pillars.backing.score = null;
      if (scenario === "nan") card.pillars.backing.score = NaN;
      if (scenario === "negative") card.pillars.backing.score = -1;
      if (scenario === "over-100") card.pillars.backing.score = 101;
      if (scenario === "C-empty" || scenario === "U-empty") card.pillars.backing.limitedEvidenceCauses = [scenario === "C-empty" ? "C" : "U"];
      expect(buildSafetyScoreV9LenderCollateralProjection(makeWorkerSafetyScoreV9Publication({ cards: [card] })).byAssetId).toEqual({});
    },
  );

  it("hashes the admitted transformed card identically after publication transport round-trip", async () => {
    const input = makeWorkerSafetyScoreV9Publication();
    input.cards[0]!.pillars.backing.supportedComponentKeys = ["z-normalized", "a-normalized"];
    const { publication, stored } = await admitAndSerializeSafetyScoreV9Publication(input);
    expect(publication.cards[0]!.pillars.backing.supportedComponentKeys).toEqual(["a-normalized", "z-normalized"]);
    expect(input.cards[0]!.pillars.backing.supportedComponentKeys).toEqual(["z-normalized", "a-normalized"]);
    const decoded = requireCurrentSafetyScoreV9Publication(await parseSafetyScoreV9Publication(stored));
    const written = buildSafetyScoreV9LenderCollateralProjection(publication);
    expect(written.byAssetId[publication.cards[0]!.id]!.cardSha256).toBe(sha256Hex(stableJsonStringifyV1(decoded.cards[0])));
    expect(buildSafetyScoreV9LenderCollateralProjection(decoded)).toEqual(written);
  });

  it.each(["baseline", "lender"] as const)("enforces %s canonical bytes, row clocks and inclusive UTF-8 byte cap", kind => {
    const publication = makeWorkerSafetyScoreV9Publication();
    if (kind === "baseline") {
      const projection = buildSafetyScoreV9AcceptedBaselineProjection(publication);
      const initial = serializeSafetyScoreV9AcceptedBaselineProjection(projection);
      projection.baseline.dexGenerationId = "x".repeat(SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES - Buffer.byteLength(initial) + 2);
      const value = serializeSafetyScoreV9AcceptedBaselineProjection(projection);
      expect(Buffer.byteLength(value)).toBe(SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES);
      expect(parseSafetyScoreV9AcceptedBaselineProjection({ value, updatedAt: publication.publishedAtSec })).toEqual(projection);
      projection.baseline.dexGenerationId += "x";
      expect(() => serializeSafetyScoreV9AcceptedBaselineProjection(projection)).toThrow(/exceeds/);
      expect(() => parseSafetyScoreV9AcceptedBaselineProjection({ value: value + " ", updatedAt: publication.publishedAtSec })).toThrow(/exceeds/);
      expect(() => parseSafetyScoreV9AcceptedBaselineProjection({ value: initial + " ", updatedAt: publication.publishedAtSec })).toThrow(/canonical/);
      expect(() => parseSafetyScoreV9AcceptedBaselineProjection({ value: initial, updatedAt: publication.publishedAtSec + 1 })).toThrow(/clock/);
    } else {
      const projection = buildSafetyScoreV9LenderCollateralProjection(publication);
      const initial = serializeSafetyScoreV9LenderCollateralProjection(projection);
      projection.byAssetId[publication.cards[0]!.id]!.sourceGapIds = ["x".repeat(SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES - Buffer.byteLength(initial) - 2)];
      const value = serializeSafetyScoreV9LenderCollateralProjection(projection);
      expect(Buffer.byteLength(value)).toBe(SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES);
      expect(parseSafetyScoreV9LenderCollateralProjection({ value, updatedAt: publication.publishedAtSec })).toEqual(projection);
      projection.byAssetId[publication.cards[0]!.id]!.sourceGapIds[0] += "x";
      expect(() => serializeSafetyScoreV9LenderCollateralProjection(projection)).toThrow(/exceeds/);
      expect(() => parseSafetyScoreV9LenderCollateralProjection({ value: value + " ", updatedAt: publication.publishedAtSec })).toThrow(/exceeds/);
      expect(() => parseSafetyScoreV9LenderCollateralProjection({ value: initial + " ", updatedAt: publication.publishedAtSec })).toThrow(/canonical/);
      expect(() => parseSafetyScoreV9LenderCollateralProjection({ value: initial, updatedAt: publication.publishedAtSec + 1 })).toThrow(/clock/);
    }
  });

  it("rejects invalid nested baseline identity, membership, clocks, scores and capacity", () => {
    const projection = buildSafetyScoreV9AcceptedBaselineProjection(makeWorkerSafetyScoreV9Publication());
    for (const mutate of [
      (value: typeof projection) => { value.baseline.policyDigest = "f".repeat(64); },
      (value: typeof projection) => { value.baseline.cards.push(value.baseline.cards[0]!); value.expectedCount++; },
      (value: typeof projection) => { value.asOfSec = value.publishedAtSec + 1; },
      (value: typeof projection) => { value.baseline.cards[0]!.score = Infinity; },
      (value: typeof projection) => { value.baseline.cards[0]!.primaryRouteCapacityUsd = -1; },
      (value: typeof projection) => { value.expectedCount++; },
    ]) {
      const invalid = structuredClone(projection);
      mutate(invalid);
      expect(() => serializeSafetyScoreV9AcceptedBaselineProjection(invalid)).toThrow();
    }
  });

  it("warns once before writing a projection above half its byte cap", () => {
    const logger = vi.spyOn(structuredLog, "logWorkerEvent");
    try {
      // Card shape sets the per-row cost, so 1,400 accepted cards push the
      // baseline past half its 458,752-byte cap without crossing the cap itself.
      const cards = Array.from({ length: 1_400 }, (_, index) =>
        makeWorkerV9Card({ id: `fixture-bulk-${String(index).padStart(4, "0")}` }));
      const publication = makeWorkerSafetyScoreV9Publication({ cards });
      const projections = buildSafetyScoreV9AcceptedProjections(publication);
      const encoder = new TextEncoder();
      const cohortBytes = encoder.encode(projections.cohort).byteLength;
      const baselineBytes = encoder.encode(projections.baseline).byteLength;
      const lenderBytes = encoder.encode(projections.lender).byteLength;
      expect(baselineBytes).toBeGreaterThan(SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES / 2);
      expect(baselineBytes).toBeLessThanOrEqual(SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES);
      expect(lenderBytes).toBeLessThan(SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES / 2);
      const warnings = logger.mock.calls.filter(([event]) => event.event === "safety_score_v9_accepted_projection_size_warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]![0]).toEqual({
        scope: "lib", level: "warn", event: "safety_score_v9_accepted_projection_size_warning",
        message: "Accepted Safety Score v9 projection exceeds half its byte cap",
        metadata: {
          cohortBytes, cohortMaxBytes: SAFETY_SCORE_COHORT_MAX_BYTES,
          baselineBytes, baselineMaxBytes: SAFETY_SCORE_V9_ACCEPTED_BASELINE_PROJECTION_MAX_BYTES,
          lenderBytes, lenderMaxBytes: SAFETY_SCORE_V9_LENDER_COLLATERAL_PROJECTION_MAX_BYTES,
        },
      });
      expect(parseSafetyScoreV9AcceptedBaselineProjection({
        value: projections.baseline, updatedAt: publication.publishedAtSec,
      }).expectedCount).toBe(cards.length);
    } finally {
      logger.mockRestore();
    }
  });

  it("rejects a lender inventory larger than the accepted card count or keyed by another asset", () => {
    const projection = buildSafetyScoreV9LenderCollateralProjection(makeWorkerSafetyScoreV9Publication());
    const [assetId, row] = Object.entries(projection.byAssetId)[0]!;
    const overCount = structuredClone(projection);
    overCount.expectedCount = Object.keys(overCount.byAssetId).length - 1;
    expect(() => serializeSafetyScoreV9LenderCollateralProjection(overCount)).toThrow(/exceeds accepted card count/);
    const rekeyed = structuredClone(projection);
    delete rekeyed.byAssetId[assetId];
    rekeyed.byAssetId[`${assetId}-other`] = row;
    expect(() => serializeSafetyScoreV9LenderCollateralProjection(rekeyed)).toThrow(/key must match asset ID/);
  });

  it("retains pillar reasons, deployment adjustments and role dependencies in the cohort view", () => {
    // Retained publications may still carry these lanes; the cohort read model
    // must keep them and drop the ids a retained-publication reader cannot resolve.
    const roleDependency: NonNullable<SafetyScoreV9CurrentCard["dependencies"]["roles"]>[number] = {
      edgeKey: "control-operator:mechanism:operator",
      exposureKey: "control-operator:mechanism:operator",
      riskEventKey: "dependency-event:mint-control:operator:shared",
      upstreamAssetId: "operator",
      role: "control-operator",
      weight: 0.5,
      targetPillar: "control",
      inheritedDimensions: ["control"],
      unavailableDimensions: [],
      score: 76,
      ratingStatus: "rated",
      partialEvidence: null,
      boundedUnknown: false,
      cycleBlocked: false,
      evidenceRefIds: ["evidence:operator-review"],
      failureDomains: [{ kind: "mint-control", key: "operator:shared" }],
    };
    const adjustment: SafetyScoreV9CurrentCard["scoreTrace"]["deploymentRisk"]["adjustments"][number] = {
      signalKey: "holder-slice:fixture", sourceSignalKeys: ["holder-slice:fixture"],
      exposureKey: "exposure:fixture", riskEventKey: "risk-event:fixture", failureDomainKey: "holder-slice:fixture",
      nominalExposureShare: 0.1, exposureShare: 0.1, exposedScore: 80,
      scoreBefore: 80, scoreAfter: 78, adjustmentPoints: 2, modeledLossPoints: 2,
      reason: "Reviewed holder-slice exposure.",
    };
    const card = makeWorkerV9Card({ id: "alpha" });
    card.pillars.backing.reasons = [{ code: "stale-audited-reserve-composition", message: "Reserve composition is stale.", path: "backing.reserves" }];
    card.pillars.exit.reasons = [{ code: "insufficient-evidence", message: "Exit evidence is incomplete.", path: null }];
    card.scoreTrace.deploymentRisk.adjustments = [adjustment];
    card.scoreTrace.deploymentRisk.totalAdjustmentPoints = 2;
    card.scoreTrace.stages.deploymentAdjustmentPoints = 2;
    card.dependencies.roles = [roleDependency];
    const publication = makeWorkerSafetyScoreV9Publication({ cards: [card] });

    const cohort = buildSafetyScoreV9CohortProjection(publication);
    expect(cohort.cards[0]!.pillars.backing.reasons).toEqual([
      { code: "stale-audited-reserve-composition", message: "Reserve composition is stale." },
    ]);
    expect(cohort.cards[0]!.pillars.exit.reasons).toEqual([
      { code: "insufficient-evidence", message: "Exit evidence is incomplete." },
    ]);
    expect(cohort.cards[0]!.scoreTrace.deploymentRisk.adjustments).toEqual([
      { scoreBefore: 80, scoreAfter: 78, adjustmentPoints: 2 },
    ]);
    expect(cohort.cards[0]!.dependencies.roles).toEqual([
      { upstreamAssetId: "operator", role: "control-operator", weight: 0.5 },
    ]);
    expect(JSON.parse(serializeSafetyScoreV9CohortProjection(cohort)).cards[0].dependencies.roles).toEqual([
      { upstreamAssetId: "operator", role: "control-operator", weight: 0.5 },
    ]);

    const bare = buildSafetyScoreV9CohortProjection(makeWorkerSafetyScoreV9Publication({ cards: [makeWorkerV9Card({ id: "alpha" })] }));
    expect(bare.cards[0]!.dependencies).not.toHaveProperty("roles");
    expect(bare.cards[0]!.pillars.backing.reasons).toEqual([]);
    expect(bare.cards[0]!.scoreTrace.deploymentRisk.adjustments).toEqual([]);
  });

});
