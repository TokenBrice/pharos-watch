import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { StablecoinListResponseSchema } from "@shared/types/market";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { createReportCardEvidenceJournalV1 } from "@shared/lib/report-card-evidence-journal";
import { createSupplyAttributionJournalV1 } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { computePegScore } from "@shared/lib/peg-score";
import { createNativeSafetyScoreV9FullRegistryInput, FULL_REGISTRY_CLOCK_SEC } from "./fixtures/safety-score-v9-full-registry-input";
import { buildNativeV9InputCacheEntry, normalizeNativeV9Input } from "../safety-score-v9/native-input";
import { buildSafetyScoreV9PegProvenanceSeedCacheEntry, captureSafetyScoreV9PegProvenanceById } from "../safety-score-v9/peg-provenance";
import { buildSafetyScoreV9CaptureControl, commitCaptureControl, hasPendingAttribution } from "../safety-score-v9/capture-control";
import { appendSupplyAttributionJournalV1 } from "../safety-score-v9/supply-attribution-journal-store";
import { computeSafetyScoreV9 } from "../../cron/compute-safety-score-v9";
import { loadSafetyScoreV9Publication } from "../safety-score-v9/publication-store";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../safety-score-v9/publication-health";
import { ALERT_SAFETY_V9_SOURCE_CACHE_KEY, parsePersistedAlertSafetyV9SourceEnvelope } from "../alert-safety-source-cache";
import { parseNativeV9InputCacheArtifact } from "../safety-score-v9/native-input";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY } from "../safety-score-v9/publication-codec";
import { parseSafetyScoreV9PublicationReplayCapture } from "../safety-score-v9/publication-replay-capture";
import { resolveV9PublicWitnessTexts } from "@shared/types/safety-score-v9-public-witness-texts";
import { iterateEvidenceResponsibilityFacts } from "@shared/types/safety-score-v9-public-evidence-facts";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9/extension";
import { buildSafetyScoreV9AcceptedPublicationBaseline } from "../safety-score-v9/publication-assessment";
import { measurePublicationByteBudget } from "@shared/lib/safety-score-v9-resource-bytes";

const sqlite = new DatabaseSync(process.env.PHAROS_RESOURCE_DATABASE!);
const db = createSqliteD1(sqlite);
const bucket = { async put(_key: string, body: unknown) {
  assert.equal(typeof body, "string");
  const object = JSON.parse(body as string);
  for (const field of ["base", "delta", "cards"]) {
    const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(object[field].key);
    assert.equal(row?.value, object[field].value, `archive-${field}-transport`);
  }
  return {};
} } as R2Bucket;

async function seedCycle(cycle: number, clockSec: number) {
  const cache = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
  sqlite.exec("DELETE FROM report_card_evidence_journal; DELETE FROM safety_score_v9_supply_attribution_journal;");
  Date.now = () => clockSec * 1_000;
  const raw = createNativeSafetyScoreV9FullRegistryInput(clockSec);
  const { baseInputGenerationId: _oldBase, ...withoutIdentity } = raw;
  // This is authored synthetic producer evidence, not a production success claim.
  const input = normalizeNativeV9Input({ ...withoutIdentity, v9PublicationInputHealth: {
    dex: { state: "current", generationId: raw.dexGenerationId, updatedAtSec: clockSec - 100 },
    redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
    liveReserves: { state: "available", coverageRatio: 1 },
  } });
  for (const peg of Object.values(input.pegDataById)) {
    Object.assign(peg, computePegScore([], peg.historyCoverage!.startedAt!, clockSec));
  }
  // Peg score evidence is part of the base identity: normalize again after authoring it.
  const { baseInputGenerationId: _base, ...finalPayload } = input;
  const normalized = normalizeNativeV9Input(finalPayload);
  const identity = buildSafetyScoreV9InputIdentity({ methodologyVersion: normalized.methodologyVersion,
    baseInputGenerationId: normalized.baseInputGenerationId, publicationGenerationId: normalized.sourceGeneration });
  const entry = await buildNativeV9InputCacheEntry(normalized, identity);
  const seed = buildSafetyScoreV9PegProvenanceSeedCacheEntry({ sourceGeneration: normalized.sourceGeneration,
    clockSec, safetyScoreIdentity: identity, pegProvenanceById: captureSafetyScoreV9PegProvenanceById(normalized, { clockSec, eventsByCoin: new Map() }) });
  const control = buildSafetyScoreV9CaptureControl({ baseInputGenerationId: normalized.baseInputGenerationId,
    sourceGeneration: normalized.sourceGeneration, clockSec, registryFingerprint: normalized.registryFingerprint,
    safetyScoreIdentity: identity, workerVersion: "resource-fixture", workerUploadedAtSec: clockSec - 3600 }, clockSec);
  assert(hasPendingAttribution(control, normalized, clockSec), "fixture must explicitly bind pending attribution");
  await commitCaptureControl(db, [entry, seed], control, true, clockSec);
  const peggedAssets = ACTIVE_STABLECOINS.map((coin) => ({ id: coin.id, name: coin.name, symbol: coin.symbol,
    pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 1, priceSource: "resource-fixture", priceObservedAt: clockSec - 100,
    circulating: { peggedUSD: 10_000_000 }, circulatingPrevDay: { peggedUSD: 10_000_000 },
    circulatingPrevWeek: { peggedUSD: 10_000_000 }, circulatingPrevMonth: { peggedUSD: 10_000_000 },
    chains: ["Ethereum"], chainCirculating: { Ethereum: { current: 10_000_000 } } }));
  cache.run("stablecoins", JSON.stringify(StablecoinListResponseSchema.parse({ peggedAssets, fxFallbackRates: {} })), clockSec);
  const dexAt = clockSec - 100;
  sqlite.prepare(`INSERT OR REPLACE INTO dex_liquidity_publication_generations
    (generation_id, started_at, state, expected_row_count, written_row_count, current_row_count, created_at, published_at)
    VALUES (?, ?, 'published', ?, ?, ?, ?, ?)`).run(normalized.dexGenerationId, dexAt, ACTIVE_STABLECOINS.length, ACTIVE_STABLECOINS.length, ACTIVE_STABLECOINS.length, dexAt, dexAt);
  const dexRow = sqlite.prepare(`INSERT OR REPLACE INTO dex_liquidity
    (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state, liquidity_score, coverage_class,
     coverage_confidence, methodology_version, pool_count, chain_count, effective_tvl_usd, balance_measured_tvl_usd,
     organic_measured_tvl_usd, score_components_json) VALUES (?, ?, ?, ?, 'published', 80, 'primary', 1, 'resource-fixture', 1, 1, 10000000, 10000000, 10000000, ?)`);
  for (const coin of ACTIVE_STABLECOINS) {
    dexRow.run(coin.id, coin.symbol, dexAt, normalized.dexGenerationId, JSON.stringify({ exitRouteObservations: normalized.dexLiqMap[coin.id].exitRouteObservations,
      exitRouteObservationCoverage: normalized.dexLiqMap[coin.id].exitRouteObservationCoverage }));
    sqlite.prepare("INSERT OR REPLACE INTO reserve_composition (stablecoin_id, slices, fetched_at, source) VALUES (?, ?, ?, ?)")
      .run(coin.id, JSON.stringify(normalized.liveReserveMap[coin.id]), dexAt, "resource-fixture");
    for (let index = 0; index < (ACTIVE_STABLECOINS.indexOf(coin) < 100 ? 2 : 1); index += 1) {
      const journal = createReportCardEvidenceJournalV1({ schemaVersion: 1, lane: "reserve", assetId: coin.id,
        attemptId: `resource-reserve:${clockSec}:${index}`, sourceId: "resource-reserve-adapter", sourceOriginClass: "onchain-observation",
        attemptCode: "reserve.collector.attempted", admissionCode: "reserve.admission.accepted", fallbackCode: "reserve.fallback.not-used",
        attemptedAtSec: clockSec - 20 + index, completedAtSec: clockSec - 10 + index, sourceTimestampSec: clockSec - 20 + index,
        sourceBlock: null, contentSha256: "a".repeat(64), sidecarMaterializationSha256: null });
      const payload = JSON.stringify(journal);
      sqlite.prepare(`INSERT INTO report_card_evidence_journal (journal_id, schema_version, lane, asset_id, attempt_id,
        attempted_at, completed_at, source_id, attempt_code, admission_code, fallback_code, payload_json, payload_bytes, recorded_at)
        VALUES (?, 1, 'reserve', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(journal.journalId, coin.id, journal.attemptId,
          journal.attemptedAtSec, journal.completedAtSec, journal.sourceId, journal.attemptCode, journal.admissionCode,
          journal.fallbackCode, payload, Buffer.byteLength(payload), clockSec);
    }
  }
  await appendSupplyAttributionJournalV1(db, [createSupplyAttributionJournalV1({ schemaVersion: 1, lane: "supply-attribution", assetId: "wm-m0",
    attemptId: `resource-supply:${clockSec}`, sourceId: "wm.reviewed-deployment-unit-partition.v1", sourceOriginClass: "onchain-observation",
    baseInputGenerationId: normalized.baseInputGenerationId, sourceGeneration: normalized.sourceGeneration,
    registryFingerprint: normalized.registryFingerprint, routeInventoryDigest: "b".repeat(64),
    attemptCode: "supply-attribution.collector.attempted", admissionCode: "supply-attribution.admission.accepted", fallbackCode: "supply-attribution.fallback.not-used",
    attemptedAtSec: clockSec - 20, completedAtSec: clockSec - 10, scoringClockSec: clockSec,
    sourceObservedAtSec: clockSec - 20, failedRouteId: null, contentSha256: "c".repeat(64) })], clockSec);
  if (cycle > 0) {
    sqlite.prepare("INSERT INTO resource_fixture_cache SELECT ?, key, value, updated_at FROM cache WHERE key IN (?, ?, ?, 'stablecoins')")
      .run(cycle, entry.key, seed.key, "report-cards:v9:capture-control:v1");
    sqlite.prepare("INSERT INTO resource_fixture_sql VALUES (?, 0, ?)").run(cycle,
      `UPDATE dex_liquidity SET updated_at = ${dexAt}, publication_generation_id = '${normalized.dexGenerationId}'; UPDATE reserve_composition SET fetched_at = ${dexAt};`);
    sqlite.prepare("INSERT INTO resource_fixture_clocks VALUES (?, ?)").run(cycle, clockSec);
    for (const [index, table] of ["report_card_evidence_journal", "safety_score_v9_supply_attribution_journal"].entries()) {
      sqlite.exec(`CREATE TABLE IF NOT EXISTS resource_fixture_${table} AS SELECT 0 AS cycle, * FROM ${table} WHERE 0`);
      sqlite.prepare(`INSERT INTO resource_fixture_${table} SELECT ?, * FROM ${table}`).run(cycle);
      const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((row) => `"${row.name}"`).join(", ");
      sqlite.prepare("INSERT INTO resource_fixture_sql VALUES (?, ?, ?)").run(cycle, index + 1,
        `DELETE FROM ${table}; INSERT INTO ${table} (${columns}) SELECT ${columns} FROM resource_fixture_${table} WHERE cycle = ${cycle};`);
    }
  }
  return { cycle, clockSec, identity, registryFingerprint: normalized.registryFingerprint, activeAssets: normalized.activeAssetIds.length,
    nativeStoredBytes: Buffer.byteLength(entry.value), nativePayloadSha256: createHash("sha256").update(entry.value).digest("hex") };
}

try {
  if (process.env.PHAROS_RESOURCE_ACTION === "inspect") {
    const publication = await loadSafetyScoreV9Publication(db);
    assert(publication);
    assert.deepEqual(publication.cards.map((card) => card.id).sort(), ACTIVE_STABLECOINS.map((coin) => coin.id).sort());
    assert(publication.completeness.ratedCount >= 271);
    const rows = sqlite.prepare("SELECT key, value, updated_at FROM cache").all();
    const index = rows.find((row) => row.key === SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex);
    assert(index, "score-index-required");
    const decodedIndex = JSON.parse(String(index.value));
    assert.equal(decodedIndex.publicationResultDigest, publication.resultDigest);
    assert.equal(decodedIndex.safetyScoreIdentity.publicationGenerationId, publication.publicationGenerationId);
    assert.deepEqual(Object.keys(decodedIndex.scores).sort(), publication.cards.map((card) => card.id).sort());
    const baseRow = rows.find((row) => row.key === SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY);
    const deltaRow = rows.find((row) => row.key === SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY);
    assert(baseRow && deltaRow, "paired-replay-required");
    const base = await parseNativeV9InputCacheArtifact(String(baseRow.value));
    const replay = await parseSafetyScoreV9PublicationReplayCapture(String(deltaRow.value), base.input);
    assert.equal(base.input.baseInputGenerationId, publication.baseInputGenerationId);
    const alertRow = rows.find((row) => row.key === ALERT_SAFETY_V9_SOURCE_CACHE_KEY);
    assert(alertRow);
    const alert = parsePersistedAlertSafetyV9SourceEnvelope({ value: String(alertRow.value), updatedAt: Number(alertRow.updated_at) });
    assert(alert);
    assert.equal(alert.publicationGenerationId, publication.publicationGenerationId);
    assert.equal(Number(sqlite.prepare("SELECT count(*) AS count FROM safety_score_capture_archive").get()!.count), 3);
    const transport = String(rows.find((row) => row.key === SAFETY_SCORE_V9_CACHE_KEYS.publication)!.value);
    const envelope = JSON.parse(transport);
    const enrichment = JSON.parse(String(deltaRow.value));
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(replay.fixedInput);
    const researchEvidenceCount = extension.assets.reduce((count, asset) => count + asset.researchEvidence.length, 0);
    const componentEvidenceCount = extension.assets.reduce((count, asset) => count + asset.componentEvidence.length, 0);
    let witnessTextSavingsBytes = 0;
    let factVocabularySavingsBytes = 0;
    const witnessViewBytes: Record<string, number> = {};
    for (const card of publication.cards) {
      const semantic = resolveV9PublicWitnessTexts(card);
      witnessTextSavingsBytes += Buffer.byteLength(JSON.stringify(semantic)) - Buffer.byteLength(JSON.stringify(card));
      const decoded = [...iterateEvidenceResponsibilityFacts(card.scoreTrace.evidenceResponsibility)];
      const originalFacts = card.scoreTrace.evidenceResponsibility.facts.map((row, index) => {
        const fact = decoded[index];
        return [fact[0], row[1], row[2], fact[3], fact[4], fact[5], fact[6]];
      });
      factVocabularySavingsBytes += Buffer.byteLength(JSON.stringify(originalFacts)) - Buffer.byteLength(JSON.stringify(card.scoreTrace.evidenceResponsibility.facts));
      for (const [view, value] of Object.entries({
        pillarReasons: Object.values(semantic.pillars).flatMap((pillar) => pillar.reasons),
        evidenceReasons: semantic.evidence.reasons, adverseAttribution: semantic.scoreTrace.adverseAttribution.items,
        boundedAttribution: semantic.scoreTrace.boundedUncertaintyAttribution.items,
        evidenceFacts: semantic.scoreTrace.evidenceResponsibility.facts,
      })) witnessViewBytes[view] = (witnessViewBytes[view] ?? 0) + Buffer.byteLength(JSON.stringify(value));
    }
    const acceptedBaselineBytes = Buffer.byteLength(JSON.stringify(buildSafetyScoreV9AcceptedPublicationBaseline(publication)));
    assert(publication.pillarFreshness, "pillar-freshness-operands-required");
    const pillarFreshnessBytes = Buffer.byteLength(`,"pillarFreshness":${JSON.stringify(publication.pillarFreshness)}`);
    assert(pillarFreshnessBytes <= 15_000, "pillar-freshness-byte-budget");
    const publicationBytes = measurePublicationByteBudget(publication, envelope.uncompressedBytes);
    assert(envelope.compressedBytes < 1_350_000, "publication-compressed-byte-budget");
    assert(Buffer.byteLength(transport) > 0, "publication-stored-bytes");
    assert(enrichment.uncompressedBytes > 300_000, "replay-enrichment-size-floor");
    assert(acceptedBaselineBytes < 500_000, "accepted-baseline-byte-budget");
    assert.equal(extension.assets.length, ACTIVE_STABLECOINS.length);
    assert(researchEvidenceCount > 5_000 && componentEvidenceCount > 3_000, "full-evidence-fixture");
    assert.match(publication.factSetDigest, /^[a-f0-9]{64}$/);
    assert.match(publication.resultDigest, /^[a-f0-9]{64}$/);
    console.log(JSON.stringify({ cards: publication.cards.length, rated: publication.completeness.ratedCount,
      generation: publication.publicationGenerationId, candidateBytes: envelope.uncompressedBytes,
      compressedBytes: envelope.compressedBytes, storedBytes: Buffer.byteLength(transport),
      publicationBytes,
      replayCaptureUncompressedBytes: enrichment.uncompressedBytes, acceptedBaselineBytes,
      extensionAssets: extension.assets.length, researchEvidenceCount, componentEvidenceCount,
      witnessTextSavingsBytes, factVocabularySavingsBytes, witnessViewBytes, pillarFreshnessBytes,
      expandedWitnessCandidateBytes: envelope.uncompressedBytes + witnessTextSavingsBytes + factVocabularySavingsBytes }));
  } else {
    for (const name of readdirSync(resolve(process.cwd(), "worker/migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(resolve(process.cwd(), "worker/migrations", name), "utf8"));
    sqlite.exec("CREATE TABLE resource_fixture_cache (cycle INTEGER, key TEXT, value TEXT, updated_at INTEGER); CREATE TABLE resource_fixture_sql (cycle INTEGER, ordinal INTEGER, sql TEXT); CREATE TABLE resource_fixture_clocks (cycle INTEGER, clock INTEGER)");
    const baseClock = Math.ceil(FULL_REGISTRY_CLOCK_SEC / 1800) * 1800 + 22 * 60;
    const prior = await seedCycle(0, baseClock);
    const result = await computeSafetyScoreV9(db, undefined, undefined, { captureArchiveBucket: bucket });
    const metadata = typeof result.metadata === "string" ? JSON.parse(result.metadata) : result.metadata;
    assert.equal(metadata?.publication?.status, "published", JSON.stringify(metadata));
    assert.equal(metadata?.publication?.outcome, "clean", JSON.stringify(metadata));
    assert.equal(metadata?.captureArchive?.status, "written", JSON.stringify(metadata));
    const publication = await loadSafetyScoreV9Publication(db);
    assert(publication);
    const rawBytes = Number(JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.value)).uncompressedBytes);
    const cycles = [await seedCycle(1, baseClock + 1800), await seedCycle(2, baseClock + 3600)];
    writeFileSync(process.env.PHAROS_RESOURCE_MANIFEST!, JSON.stringify({ prior, cycles, fixtureRawPublicationBytes: rawBytes,
      publicationBytes: measurePublicationByteBudget(publication, rawBytes),
      reserveJournalAssets: ACTIVE_STABLECOINS.length, reserveJournalRows: ACTIVE_STABLECOINS.length + 100, supplyJournalAssets: 1 }));
  }
} finally { sqlite.close(); }
