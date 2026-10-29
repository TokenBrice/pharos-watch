import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { projectV9Table, projectV9Detail } from "@shared/lib/report-cards-v9-projections";
import { projectV9CompactPartialEvidence } from "@shared/types/safety-score-v9-causes";
import { SafetyScoreIndexSchema } from "@shared/types/safety-score-index";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import type { ReportCardsV9CurrentResponse, V9PublicationHealth } from "@shared/types/report-cards-v9";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { handleDependencyGraph } from "../../api/dependency-graph";
import { loadDependencyMapOgPage } from "../../api/og-page/dependency-map";
import { loadDdrContext } from "../../cron/depeg-resolver/context";
import { activeRow } from "../../cron/depeg-resolver/__tests__/depeg-resolver.test-support";
import { collectSafetyScores } from "../../cron/daily-digest/collectors-risk";
import { computeDigestMintBurnFtqFlows } from "../../cron/daily-digest/mint-burn-ftq";
import { snapshotSafetyGradeHistory } from "../../cron/snapshot-safety-grade-history";
import { loadDigestSafetyContext, checkDigestSafetyContextForDelivery } from "../digest-safety-context";
import { checkSafetyScoreV9Publication } from "../canary-checks";
import { loadPublicationHealth } from "../publication-contract";
import { getDatasetFreshness } from "../status/derived-data";
import { buildDewsStablecoinIdsDigest } from "../dews-publication-pointer";
import * as activeSource from "../safety-score-active-source";
import * as scoreIndex from "../safety-score-index";
import { projectSafetyScoreV9PublicationToPublicSnapshot } from "../report-cards-v9-cache";
import { admitAndSerializeSafetyScoreV9Publication, parseSafetyScoreV9Publication } from "../safety-score-v9/publication-codec";
import {
  loadSafetyScoreV9PublicationStoredRow, shardSafetyScoreV9CohortStoredValue,
  reassembleSafetyScoreV9CohortStoredValue, SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES,
} from "../safety-score-v9/publication-chunks";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../safety-score-v9/publication-health";
import { buildSafetyScoreV9CohortProjection, serializeSafetyScoreV9CohortProjection } from "../safety-score-v9/accepted-projections";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { vi.restoreAllMocks(); fixtures.closeAll(); });

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJsonStringifyV1(value)).digest("hex");
}

function publicByteDigests(snapshot: ReportCardsV9CurrentResponse) {
  const table = projectV9Table(snapshot);
  return {
    full: sha256(snapshot), table: sha256(table),
    details: snapshot.cards.map(card => [card.id, sha256(projectV9Detail(snapshot, card.id, table.dependencyGraph))]),
  };
}

async function readStoredPublication(kind: "fixture" | "capture" | "database"): Promise<string> {
  if (kind === "fixture") return (await admitAndSerializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication())).stored;
  if (kind === "capture") {
    const archive = JSON.parse(readFileSync(process.env.PHAROS_SAFETY_COHORT_CAPTURE!, "utf8"));
    return archive.cards.value;
  }
  const sqlite = new DatabaseSync(process.env.PHAROS_SAFETY_COHORT_DATABASE!, { readOnly: true });
  try {
    const row = await loadSafetyScoreV9PublicationStoredRow(createSqliteD1(sqlite));
    if (row === null) throw new Error("Cohort parity database has no accepted publication");
    return row.value;
  } finally { sqlite.close(); }
}

function currentHealth(publication: SafetyScoreV9CurrentResponse): V9PublicationHealth {
  return {
    schemaVersion: 2, status: "current", acceptedPublicationGenerationId: publication.publicationGenerationId,
    acceptedAtSec: publication.publishedAtSec, attemptedAtSec: publication.publishedAtSec,
    heldSinceSec: null, reasons: [],
  };
}

async function assertReaderParity(stored: string, label: string) {
  const publication = await parseSafetyScoreV9Publication(stored);
  const canonicalBefore = sha256(publication);
  const health = currentHealth(publication);
  const full = projectSafetyScoreV9PublicationToPublicSnapshot(publication, health);
  const bytesBefore = publicByteDigests(full);
  const projection = buildSafetyScoreV9CohortProjection(publication);
  const cohortValue = serializeSafetyScoreV9CohortProjection(projection);
  expect(projection).not.toHaveProperty("completeness");
  for (const card of projection.cards) {
    for (const key of ["score", "grade", "ratingStatus", "partialEvidence", "bindingCap", "dependencies.serial"]) {
      expect(card).not.toHaveProperty(key);
    }
  }
  const shardedCohort = shardSafetyScoreV9CohortStoredValue(cohortValue);
  const largestChunkBytes = Math.max(...shardedCohort.chunks.map(chunk => Buffer.byteLength(chunk.value)));
  expect(largestChunkBytes).toBeLessThanOrEqual(SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES);
  expect(reassembleSafetyScoreV9CohortStoredValue(shardedCohort.envelope, shardedCohort.chunks)).toBe(cohortValue);
  const indexValue = stableJsonStringifyV1(SafetyScoreIndexSchema.parse({
    schemaVersion: 2, safetyScoreIdentity: full.safetyScoreIdentity,
    publicationResultDigest: publication.resultDigest, asOfSec: publication.asOfSec,
    publishedAtSec: publication.publishedAtSec, expectedCount: publication.cards.length,
    scores: Object.fromEntries(publication.cards.map(card => [card.id, {
      score: card.score, grade: card.grade, ratingStatus: card.ratingStatus,
      partialEvidence: projectV9CompactPartialEvidence(card.partialEvidence),
    }])),
  }));
  const sourceFixture = fixtures.open();
  const insert = sourceFixture.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
  insert.run(SAFETY_SCORE_V9_CACHE_KEYS.publication, stored, publication.publishedAtSec);
  insert.run(SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth, stableJsonStringifyV1(health), health.attemptedAtSec);
  insert.run(SAFETY_SCORE_V9_CACHE_KEYS.cohort, shardedCohort.envelope, publication.publishedAtSec);
  for (const chunk of shardedCohort.chunks) insert.run(chunk.key, chunk.value, publication.publishedAtSec);
  insert.run(SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex, indexValue, publication.publishedAtSec);
  const projectedSource = await activeSource.loadActiveSafetyScoreCohort(sourceFixture.db);
  const indexedSource = await scoreIndex.loadActiveSafetyScoreIndex(sourceFixture.db);
  expect(projectedSource.kind).toBe("v9");
  expect(indexedSource.kind).toBe("v9");
  if (projectedSource.kind !== "v9" || indexedSource.kind !== "v9") throw new Error("Parity source unavailable");
  const cohortLoader = vi.spyOn(activeSource, "loadActiveSafetyScoreCohort");
  const indexLoader = vi.spyOn(scoreIndex, "loadActiveSafetyScoreIndex");
  const now = publication.publishedAtSec + 60;
  vi.spyOn(Date, "now").mockReturnValue(now * 1_000);

  async function outputs(useFull: boolean) {
    cohortLoader.mockResolvedValue(useFull ? { kind: "v9", snapshot: full } : projectedSource);
    indexLoader.mockResolvedValue(useFull ? { kind: "v9", snapshot: full } : indexedSource);
    const { db, sqlite } = fixtures.open();
    const assets = full.cards.map(card => makeAsset({ id: card.id, symbol: card.id, circulating: { peggedUSD: 20_000_000 } }));
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("stablecoins", JSON.stringify({ peggedAssets: assets, fxFallbackRates: {} }), now);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("dews:published-generation", JSON.stringify({
      updatedAt: now, source: "compute-dews", publishStatus: "published", coverageVersion: 2,
      expectedRowCount: assets.length, stablecoinIdsDigest: buildDewsStablecoinIdsDigest(assets.map(asset => asset.id)),
    }), now);
    const dewsRow = sqlite.prepare("INSERT INTO stress_signal_publication_rows (stablecoin_id, score, band, signals_json, computed_at) VALUES (?, 10, 'CALM', '{}', ?)");
    for (const asset of assets) dewsRow.run(asset.id, now);
    const context = await loadDigestSafetyContext(db);
    const graph = await handleDependencyGraph(db);
    const collected = await collectSafetyScores({
      db, trackedStablecoinAssets: assets, trackedStablecoinIds: new Set(assets.map(asset => asset.id)),
      coreAggregateStablecoinAssets: assets, coreAggregateStablecoinIds: new Set(assets.map(asset => asset.id)),
      stablecoinAssetById: new Map(assets.map(asset => [asset.id, asset])),
      mcapById: new Map(assets.map(asset => [asset.id, 20_000_000])), stablecoinsCacheIsFresh: true,
      nowSec: now, todayTs: now, yesterdayTs: now - 86_400,
    }, new Set(assets.map(asset => asset.symbol)));
    const history = await snapshotSafetyGradeHistory(db);
    return {
      graph: { status: graph.status, headers: [...graph.headers], body: await graph.text() },
      og: await loadDependencyMapOgPage(db, now), collected,
      ddr: await loadDdrContext(db, assets.map((asset, index) => activeRow({
        id: index + 1, stablecoin_id: asset.id, symbol: asset.symbol, started_at: Math.max(0, now - 3_600),
      })), now),
      ftq: await computeDigestMintBurnFtqFlows(db, assets.map((asset, index) => ({
        id: asset.id, knownNetUsd: index % 2 === 0 ? 100_000_000 : -100_000_000,
        valuation: { mintCompleteness: "complete", burnCompleteness: "complete" },
        window24hComplete: true,
      }))),
      context, delivery: await checkDigestSafetyContextForDelivery(db, context),
      history, historyRows: sqlite.prepare("SELECT * FROM safety_score_history_v2 ORDER BY stablecoin_id").all(),
      canary: await checkSafetyScoreV9Publication(db),
      publication: (await loadPublicationHealth(db, now)).surfaces["safety-score-v9"],
      freshness: (await getDatasetFreshness(db)).safetyGrades,
    };
  }

  const expected = await outputs(true);
  const actual = await outputs(false);
  expect(actual).toEqual(expected);
  expect(actual.graph.status).toBe(200);
  expect(actual.collected.value.safetyGrades?.length).toBeGreaterThan(0);
  expect(actual.historyRows.length).toBeGreaterThan(0);
  expect(actual.ddr.kind).toBe("ok");
  if (actual.ddr.kind !== "ok") throw new Error(actual.ddr.reason);
  expect(actual.ddr.context.v9ExitByCoin.size).toBe(publication.cards.length);
  expect(actual.ddr.context.structuralContext?.size).toBe(publication.cards.length);
  expect(actual.ddr.context.safetyByCoin.size).toBeGreaterThan(0);
  expect(actual.freshness).toBe(publication.publishedAtSec);
  expect(sha256(publication)).toBe(canonicalBefore);
  expect(publicByteDigests(projectSafetyScoreV9PublicationToPublicSnapshot(publication, health))).toEqual(bytesBefore);
  expect(projection.publicationResultDigest).toBe(publication.resultDigest);
  writeSync(1, `${JSON.stringify({ cohortParity: label, cards: publication.cards.length,
    cohortBytes: Buffer.byteLength(cohortValue), canonicalBytes: JSON.parse(stored).uncompressedBytes,
    cohortEnvelopeBytes: Buffer.byteLength(shardedCohort.envelope), cohortChunks: shardedCohort.chunks.length, largestChunkBytes,
    resultDigest: publication.resultDigest, factSetDigest: publication.factSetDigest,
    payloadSha256: JSON.parse(stored).payloadSha256, publicDetailRepresentations: bytesBefore.details.length })}\n`);
}

describe("accepted cohort reader parity", () => {
  it("preserves migrated reader outputs and canonical/public bytes on the admitted fixture", async () => {
    await assertReaderParity(await readStoredPublication("fixture"), "admitted-fixture");
  });
  it.skipIf(!process.env.PHAROS_SAFETY_COHORT_CAPTURE)("preserves every reader and representation on an accepted R2 capture", async () => {
    await assertReaderParity(await readStoredPublication("capture"), "accepted-r2-capture");
  }, 120_000);
  it.skipIf(!process.env.PHAROS_SAFETY_COHORT_DATABASE)("preserves every reader and representation on the full resource fixture", async () => {
    await assertReaderParity(await readStoredPublication("database"), "full-resource-fixture");
  }, 120_000);
});
