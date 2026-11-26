import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { buildFixedInputCacheEntry } from "../../src/lib/report-cards-fixed-input-cache-codec";
import { buildSafetyScoreV9BaselineExtension } from "../../src/lib/safety-score-v9/extension";
import { buildNativeV9InputCacheEntry, computeNativeDexLiquidityPayloadFingerprint } from "../../src/lib/safety-score-v9/native-input";
import { createNativeSafetyScoreV9CohortInput } from "../../src/lib/__tests__/fixtures/safety-score-v9-full-registry-input";
import { buildReportCardsFixedInputCacheEntry } from "../../src/test-helpers/report-cards-fixed-input";
import {
  findFutureDatedCuratedReviews,
  buildSafetyScoreV9ReplayArtifact,
  parseSafetyScoreV9PublishedAtSec,
  parseSafetyScoreV9ReplayFixedInput,
  resolveSafetyScoreV9ReplayInput,
  runSafetyScoreV9ReplayCli,
  serializeSafetyScoreV9ReplayArtifact,
  rederiveUndisclosedFeeObservations,
  type SafetyScoreV9ReplayArtifact,
} from "../replay-safety-score-v9";
import { createR2MeasurementsClient } from "../../../scripts/lib/r2-measurements-client";
import { generateV9MissingDataRegistry } from "../../../scripts/maintenance/generate-safety-score-v9-missing-data-registry";
import { v9TestClockSec } from "../../src/test-helpers/v9-fixed-input";
import { localRegistrySnapshot, registrySnapshotFingerprint } from "../lib/safety-score-v9-registry";
import { createReplayFixedInput } from "./safety-score-v9-replay.test-support";
import { assertReportCardsCaptureCurrent, runReportCardsFixedInputCaptureCli } from "../capture-report-cards-fixed-input";
import { SOURCE_FIXED_INPUT_MAX_AGE_SEC } from "../../src/lib/safety-score-v9/supply-attribution-source-contract";
import { buildSafetyScoreV9PublicationReplayCapture } from "../../src/lib/safety-score-v9/publication-replay-capture";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY } from "../../src/lib/safety-score-v9/publication-codec";
import { createSafetyScoreV9TransferMaterialityGeneration } from "../../src/lib/safety-score-v9/transfer-materiality";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../src/test-helpers/report-cards-v9";
import { buildSafetyScoreV9AcceptedPublicationBaseline } from "../../src/lib/safety-score-v9/publication-assessment";
import { makeV9FixedInput } from "../../src/test-helpers/v9-fixed-input";
import { makeSupplyFullRedemption } from "../../src/lib/__tests__/redemption-backstops-store.test-support";
import { deriveSupplyModelExitRouteObservation } from "../../src/lib/redemption-exit-route-observations";
import { computeRedemptionPayloadFingerprint, projectReportCardsFixedInputMethodologyVersions } from "@shared/lib/report-cards-fixed-input-identity";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { normalizeSafetyScoreV9CompilerInput } from "../../src/lib/safety-score-v9/native-input";
import {
  NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC,
  NewAssetAdmissionReceiptSchema,
  PROSPECTIVE_ABSENT_RUNTIME_LANES,
} from "../../../scripts/ci/check-new-asset-evidence-packet";
import {
  buildProductionCaptureAdmissionReceipt,
  buildProspectiveAdmissionReceipt,
  buildProspectiveOfflineFixedInput,
  collectProspectiveCohortIds,
  computeProspectiveAdmissionInputId,
  maxCuratedReviewSecForCohort,
  projectReceiptEvidenceFromPipeline,
  runSafetyScoreV9AdmissionReceiptCli,
  verifyProspectiveAdmissionReceipt,
} from "../build-safety-score-v9-admission-receipt";

const CLOCK_SEC = v9TestClockSec();
const PUBLISHED_AT_SEC = CLOCK_SEC + 10;
const PUBLISHED_AT_ISO = new Date(PUBLISHED_AT_SEC * 1_000).toISOString();

// The parser cases need the native v4 shape, not the full ~386-asset registry.
const nativeInput = createNativeSafetyScoreV9CohortInput(["usdc-circle", "usdt-tether"]);

// The local registry is immutable for the run; fingerprinting it per case costs
// seconds at this registry size.
let cachedLocalRegistrySnapshot: ReturnType<typeof localRegistrySnapshot> | undefined;
function localSnapshot() {
  cachedLocalRegistrySnapshot ??= localRegistrySnapshot();
  return cachedLocalRegistrySnapshot;
}

/**
 * Documented cohort registry snapshot: a replay only reads the rows of the
 * assets it captures, while `verifyRegistrySnapshot` re-fingerprints every row
 * on each verification. The rows below are real registry entries filtered to
 * the cohort — never synthesized — and the fingerprint is recomputed, so the
 * snapshot stays fingerprint-bound exactly like a captured one.
 */
function cohortSnapshot(assetIds: readonly string[]) {
  const local = localSnapshot();
  const rows = {
    activeStablecoins: local.activeStablecoins.filter((coin) => assetIds.includes(coin.id)),
    frozenStablecoins: [],
    deadStablecoins: [],
  };
  return { ...local, ...rows, fingerprint: registrySnapshotFingerprint(rows) };
}

function exactFixedInput() {
  return createReplayFixedInput(CLOCK_SEC, {
    sourceGeneration: "report-cards:fixture:v9-replay",
    registryRevision: "registry:fixture",
  });
}

// The CLIs are exercised in-process elsewhere; these two spawns keep the real
// entrypoint guard, argv wiring and usage exit code under PR-time proof.
describe("operator CLI entrypoints", () => {
  it.each([
    ["worker/scripts/replay-safety-score-v9.ts", ["--input", "missing.json", "--output", "out.json"], "--published-at is required"],
    ["worker/scripts/capture-report-cards-fixed-input.ts", ["--not-a-flag"], "Unknown option"],
  ] as const)("exits 2 with a usage error from the real %s entrypoint", (script, args, message) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8", timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(message);
  });
});

describe("Safety Score v9 deterministic replay CLI", () => {
  it("admits captured chain-only supply without an external observation", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-chain-admit-"));
    try {
      const assetId = "dai-makerdao";
      const capture = resolve(dir, "capture.json"), output = resolve(dir, "out.json"), supply = resolve(dir, "supply.json");
      const input = normalizeSafetyScoreV9CompilerInput({ ...nativeInput, baseInputGenerationId: undefined,
        aggregateCirculatingById: { ...nativeInput.aggregateCirculatingById, [assetId]: { circulating: {}, observedAtSec: nativeInput.clockSec } },
        chainCirculatingById: { ...nativeInput.chainCirculatingById, [assetId]: { ethereum: { current: 9_000_000 } } } });
      writeFileSync(capture, JSON.stringify(input));
      const args = ["--input", capture, "--output", output, "--published-at", String(input.clockSec),
        "--allow-future-reviews", "--admit-asset", assetId];
      await runSafetyScoreV9ReplayCli(args);
      const { pipeline } = JSON.parse(readFileSync(output, "utf8")) as SafetyScoreV9ReplayArtifact;
      expect(pipeline.compiledFacts.assets.find((asset) => asset.assetId === assetId)?.supply.circulatingUsd).toBe(9_000_000);
      writeFileSync(supply, JSON.stringify({ [assetId]: { circulating: { peggedUSD: 1_000_000 }, observedAtSec: null,
        url: "https://stablecoins.llama.fi/stablecoins", field: "circulating", retrievedAtSec: input.clockSec + 1 } }));
      await expect(runSafetyScoreV9ReplayCli([...args, "--supply-observations", supply])).rejects.toThrow(`${assetId} already has usable captured supply`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("batch asset admission", () => {
    let dir: string;
    let capture: string, output: string, supply: string;
    const { baseInputGenerationId: _old, ...base } = nativeInput;
    const dexLiqMap = { "usdc-circle": base.dexLiqMap["usdc-circle"]! };
    const input = normalizeSafetyScoreV9CompilerInput({ ...base, dexLiqMap, activeAssetIds: ["usdc-circle"],
      registryFingerprint: "b".repeat(64),
      aggregateCirculatingById: { "usdt-tether": { circulating: { peggedUSD: 10_000_000 }, observedAtSec: base.clockSec } },
      dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, base.dexGenerationId) });
    const observation = { circulating: { peggedUSD: 1_000_000 }, observedAtSec: null,
      url: "https://stablecoins.llama.fi/stablecoins", field: "peggedAssets[42].circulating", retrievedAtSec: input.clockSec + 1 };
    const dai = ["--admit-asset", "dai-makerdao"], usdt = ["--admit-asset", "usdt-tether"];
    let baseArgs: string[], args: string[], bytes: string;
    let replay: SafetyScoreV9ReplayArtifact;

    beforeAll(async () => {
      dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-admit-"));
      capture = resolve(dir, "capture.json");
      output = resolve(dir, "out.json");
      supply = resolve(dir, "supply.json");
      writeFileSync(capture, JSON.stringify(input));
      writeFileSync(supply, JSON.stringify({ "dai-makerdao": observation }));
      baseArgs = ["--input", capture, "--output", output, "--published-at", String(input.clockSec), "--allow-future-reviews", "--allow-registry-mismatch"];
      args = [...baseArgs, "--supply-observations", supply];
      await runSafetyScoreV9ReplayCli([...args, ...usdt, ...dai]);
      bytes = readFileSync(output, "utf8");
      replay = JSON.parse(bytes) as SafetyScoreV9ReplayArtifact;
    });

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("admits captured and explicitly sourced supply and requires missing observations", async () => {
      await expect(runSafetyScoreV9ReplayCli([...baseArgs, ...dai])).rejects.toThrow("requires a --supply-observations entry");
      const { pipeline, replayScenario } = replay;
      expect(pipeline.fixedInput).toMatchObject({
        activeAssetIds: ["dai-makerdao", "usdc-circle", "usdt-tether"],
        chainCirculatingById: input.chainCirculatingById,
      });
      expect(pipeline.fixedInput.aggregateCirculatingById).toEqual(input.aggregateCirculatingById);
      expect(pipeline.fixedInput.replaySupplyObservationsById).toEqual({ "dai-makerdao": observation });
      expect(pipeline.fixedInput.dexLiqMap["dai-makerdao"]).toEqual({ updatedAt: input.inputFreshness.dexLiquidity.updatedAt });
      expect(pipeline.fixedInput.baseInputGenerationId).not.toBe(input.baseInputGenerationId);
      expect(pipeline.quarantines.find(({ assetId }) => assetId === "dai-makerdao")).toBeUndefined();
      const daiFacts = pipeline.compiledFacts.assets.find(({ assetId }) => assetId === "dai-makerdao")!;
      const { circulating: _circulating, ...provenance } = observation;
      const registry = generateV9MissingDataRegistry({
        replay,
        policy: JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../shared/data/safety-score-v9/methodology-policy-candidate-v1.json"), "utf8")),
        catalogEntries: pipeline.fixedInput.activeAssetIds.map((id) => ({
          id, coin: ACTIVE_META_BY_ID.get(id)!, file: `shared/data/stablecoins/coins/${id}.json`,
        })),
      });
      expect(registry.stablecoins.find(({ assetId }) => assetId === "dai-makerdao")?.canonicalSupplyUsd).toBeNull();
      expect(daiFacts.supply).toMatchObject({ circulatingUsd: null, replayObservation: { ...provenance, circulatingUsd: 1_000_000 },
        status: { observationState: "missing", evidenceRefIds: [] } });
      expect(daiFacts.evidence.some(({ evidenceId }) => evidenceId === "dai-makerdao:aggregate-supply")).toBe(false);
      expect(pipeline.candidate.cards).toContainEqual(expect.objectContaining({ id: "dai-makerdao",
        supply: { circulatingUsdAtEvaluation: null, asOfSec: null, generationId: null } }));
      expect(replayScenario).toEqual({
        kind: "asset-admission",
        sourceBaseInputGenerationId: input.baseInputGenerationId,
        registryFingerprint: base.registryFingerprint,
        evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
        assets: [
          { assetId: "dai-makerdao", captureIdSuffix: "+admit:dai-makerdao", supplyObservation: observation },
          { assetId: "usdt-tether", captureIdSuffix: "+admit:usdt-tether" },
        ],
      });
      expect(replayScenario?.kind === "asset-admission" ? replayScenario.evaluationBuildDigest : null)
        .toBe(pipeline.candidateIdentity.evaluationBuildDigest);
    });

    it("rejects a mismatched evaluation build digest", () => {
      const { replayScenario } = replay;
      expect(() => buildSafetyScoreV9ReplayArtifact({
        fixedInput: exactFixedInput(),
        publishedAtSec: input.clockSec,
        allowRegistryMismatch: true,
        replayScenario: {
          ...(replayScenario as Extract<NonNullable<typeof replayScenario>, { kind: "asset-admission" }>),
          evaluationBuildDigest: "0".repeat(64),
        },
      })).toThrow(/evaluationBuildDigest/i);
    });

    it("emits byte-identical output regardless of admit order", async () => {
      await runSafetyScoreV9ReplayCli([...args, ...dai, ...usdt]);
      expect(readFileSync(output, "utf8")).toBe(bytes);
    });

    it("admits clocked supply while refusing captured supply overrides and replay envelopes", async () => {
      const observedAtSec = input.clockSec - 123;
      const aggregateCirculatingById = { "dai-makerdao": { circulating: {}, observedAtSec },
        "usdt-tether": { circulating: { peggedUSD: 0 }, observedAtSec } };
      const { "usdt-tether": _usdtChain, ...chainCirculatingById } = input.chainCirculatingById;
      writeFileSync(capture, JSON.stringify(normalizeSafetyScoreV9CompilerInput({ ...input,
        baseInputGenerationId: undefined, aggregateCirculatingById, chainCirculatingById })));
      writeFileSync(supply, JSON.stringify({ "dai-makerdao": { ...observation, observedAtSec } }));
      await runSafetyScoreV9ReplayCli([...args, ...dai, ...usdt]);
      const clocked = (JSON.parse(readFileSync(output, "utf8")) as SafetyScoreV9ReplayArtifact).pipeline;
      expect(clocked.fixedInput.aggregateCirculatingById).toEqual(aggregateCirculatingById);
      expect(clocked.compiledFacts.assets.find(({ assetId }) => assetId === "dai-makerdao")?.supply.circulatingUsd).toBe(1_000_000);
      expect(clocked.compiledFacts.assets.find(({ assetId }) => assetId === "dai-makerdao")!.evidence)
        .toContainEqual(expect.objectContaining({ evidenceId: "dai-makerdao:aggregate-supply",
          sourceGenerationId: clocked.fixedInput.baseInputGenerationId, url: observation.url, observedAtSec,
          freshness: expect.objectContaining({ state: "current", ageSec: 123 }) }));
      expect(clocked.candidate.cards.find(({ id }) => id === "dai-makerdao")?.supply?.asOfSec).toBe(observedAtSec);
      writeFileSync(supply, JSON.stringify({ "usdt-tether": observation }));
      await expect(runSafetyScoreV9ReplayCli([...args, ...usdt])).rejects.toThrow("usdt-tether already has usable captured supply");

      const scenarioInput = clocked.fixedInput;
      const identity = buildSafetyScoreV9InputIdentity({ methodologyVersion: scenarioInput.methodologyVersion,
        baseInputGenerationId: scenarioInput.baseInputGenerationId, publicationGenerationId: scenarioInput.sourceGeneration });
      writeFileSync(capture, JSON.stringify(scenarioInput));
      await expect(runSafetyScoreV9ReplayCli(args.slice(0, -2))).rejects.toThrow(/replaySupplyObservationsById/);
      await expect(buildNativeV9InputCacheEntry(scenarioInput, identity)).rejects.toThrow(/replaySupplyObservationsById/);
      const envelope = await buildFixedInputCacheEntry({ schemaVersion: 2, sourceGeneration: scenarioInput.sourceGeneration,
        safetyScoreIdentity: identity, payload: scenarioInput, label: "admission input" });
      await expect(parseSafetyScoreV9ReplayFixedInput(envelope.value)).rejects.toThrow(/replaySupplyObservationsById/);
    });
  });

  it("requires explicit current-redemption mode and reseals only targeted captured rows", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-redemption-scenario-"));
    try {
      const entry = makeSupplyFullRedemption({ feeModelKind: "undisclosed-reviewed", feeBps: null, updatedAt: CLOCK_SEC - 100 });
      const observation = deriveSupplyModelExitRouteObservation(entry, CLOCK_SEC)!;
      entry.capacityProfile = { ...entry.capacityProfile!, exitRouteObservations: [{ ...observation, executableUsd: 0 }] };
      const captured = exactFixedInput();
      const draft = {
        ...captured,
        redemptionBackstopMap: { "usdc-circle": entry },
        redemptionGenerationId: "redemption:scenario",
        redemptionStale: false,
        inputFreshness: {
          ...captured.inputFreshness,
          redemptionBackstops: { updatedAt: entry.updatedAt, ageSeconds: CLOCK_SEC - entry.updatedAt, stale: false },
        },
      };
      const { baseInputGenerationId: _stale, ...unsealed } = draft;
      unsealed.redemptionPayloadFingerprint = computeRedemptionPayloadFingerprint(draft.redemptionBackstopMap, draft.redemptionGenerationId);
      unsealed.inputMethodologyVersions = projectReportCardsFixedInputMethodologyVersions(unsealed);
      const input = normalizeSafetyScoreV9CompilerInput(unsealed);
      const next = normalizeSafetyScoreV9CompilerInput(rederiveUndisclosedFeeObservations(input));
      expect(input.redemptionBackstopMap["usdc-circle"]!.capacityProfile!.exitRouteObservations![0]!.executableUsd).toBe(0);
      expect(next.redemptionBackstopMap["usdc-circle"]!.capacityProfile!.exitRouteObservations![0]!.executableUsd).toBeGreaterThan(0);
      expect(next.redemptionPayloadFingerprint).not.toBe(input.redemptionPayloadFingerprint);
      expect(next.baseInputGenerationId).not.toBe(input.baseInputGenerationId);
      expect(rederiveUndisclosedFeeObservations(exactFixedInput())).toEqual(exactFixedInput());

      const capture = resolve(dir, "capture.json"), output = resolve(dir, "output.json");
      writeFileSync(capture, JSON.stringify(input));
      const args = ["--input", capture, "--output", output, "--published-at", String(CLOCK_SEC), "--allow-future-reviews"];
      await runSafetyScoreV9ReplayCli(args);
      const ordinary = JSON.parse(readFileSync(output, "utf8"));
      expect(ordinary.pipeline.fixedInput.redemptionBackstopMap).toEqual(input.redemptionBackstopMap);
      expect(ordinary.replayScenario).toBeUndefined();
      await runSafetyScoreV9ReplayCli([...args, "--rederive-current-redemption"]);
      const scenario = JSON.parse(readFileSync(output, "utf8"));
      expect(scenario.pipeline.fixedInput.redemptionBackstopMap).toEqual(next.redemptionBackstopMap);
      expect(scenario.replayScenario).toEqual({ kind: "current-redemption-rederivation", sourceBaseInputGenerationId: input.baseInputGenerationId });
      // Bind the capture to the asset cohort the case replays, not the whole
      // catalog: the mode refusal below runs after snapshot verification.
      const snapshot = cohortSnapshot(["usdc-circle"]);
      const { baseInputGenerationId: _rebuilt, ...cohortInput } = input;
      const cohortFixedInput = normalizeSafetyScoreV9CompilerInput({ ...cohortInput, registryFingerprint: snapshot.fingerprint });
      writeFileSync(capture, JSON.stringify({ kind: "safety-score-v9-registry-capture", fixedInput: cohortFixedInput, registrySnapshot: snapshot }));
      await expect(runSafetyScoreV9ReplayCli([...args, "--rederive-current-redemption"])).rejects.toThrow("capture-time registry modes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
  it("exports and replays an accepted retained pair with rejected transfer observations and embedded registry", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-accepted-capture-"));
    try {
      const base = makeV9FixedInput({ assetId: "wm-m0", clockSec: CLOCK_SEC, aggregateCirculating: { peggedUSD: 87_020_618.58982982 } });
      const publication = makeWorkerSafetyScoreV9Publication({
        baseInputGenerationId: base.baseInputGenerationId, publishedAtSec: base.clockSec,
        publicationGenerationId: "report-cards:v9:fixture-accepted",
      });
      const transfer = createSafetyScoreV9TransferMaterialityGeneration({
        schemaVersion: 1, kind: "safety-score-v9-transfer-materiality-generation",
        sourceBaseInputGenerationId: base.baseInputGenerationId, registryFingerprint: base.registryFingerprint,
        capturedAtSec: base.clockSec, observationsByAssetId: {
          "wm-m0": [{ deploymentKey: "solana:fixture", rawTokenUnits: null, decimals: null,
            blockNumber: null, observedAtSec: null, status: "rejected" }],
        },
      });
      const baseEntry = await buildReportCardsFixedInputCacheEntry(base);
      // 10.35: the prior accepted baseline retains a measured-route expiry witness on a stub.
      const prior = buildSafetyScoreV9AcceptedPublicationBaseline(makeWorkerSafetyScoreV9Publication({
        cards: [makeWorkerV9Card({ id: "wm-m0", score: null, grade: null, ratingStatus: "pipeline-gap" })],
        publicationGenerationId: "report-cards:v9:fixture-prior", publishedAtSec: base.clockSec - 3_600,
      }), { "wm-m0": [{ routeId: "dex:retired", dexGenerationId: base.dexGenerationId,
        observationWindowEndedAt: base.clockSec - 14_400, freshnessMaxSec: 10_800 }] });
      const delta = await buildSafetyScoreV9PublicationReplayCapture(publication, base, transfer, prior);
      const raw = resolve(dir, "raw.json");
      const capturePath = resolve(dir, "capture.json");
      const replayPath = resolve(dir, "replay.json");
      writeFileSync(raw, JSON.stringify([{ success: true, results: [
        { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY, value: delta.value, updated_at: base.clockSec },
        { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, value: baseEntry.value, updated_at: base.clockSec },
      ] }]));
      await runReportCardsFixedInputCaptureCli(["--accepted-cache-export", raw, "--output", capturePath]);
      const capture = JSON.parse(readFileSync(capturePath, "utf8"));
      expect(capture.kind).toBe("safety-score-v9-accepted-publication-capture");
      expect(capture.publicationGenerationId).toBe(publication.publicationGenerationId);
      expect(capture.fixedInput.safetyScoreV9SupplyAttributionById).toEqual(base.safetyScoreV9SupplyAttributionById);
      expect(capture.transferMaterialityGeneration).toEqual(transfer);
      expect(capture.registrySnapshot.fingerprint).toBe(base.registryFingerprint);
      const args = ["--input", capturePath, "--output", replayPath, "--published-at", String(base.clockSec), "--allow-future-reviews"];
      await runSafetyScoreV9ReplayCli(args);
      const expected = buildSafetyScoreV9ReplayArtifact({
        fixedInput: base, registrySnapshot: capture.registrySnapshot, transferMaterialityGeneration: transfer,
        publishedAtSec: base.clockSec, sourceAdmissionBaseline: prior, laneScreening: null,
      });
      expect(readFileSync(replayPath, "utf8")).toBe(serializeSafetyScoreV9ReplayArtifact(expected));
      // The witness reproduces the publication-time quarantine instead of a raw rating.
      expect(expected.sourceAdmissionBaseline).toEqual(prior);
      expect(expected.pipeline.quarantines).toEqual([expect.objectContaining({ assetId: "wm-m0", code: "evaluation-failed" })]);
      expect(expected.pipeline.measuredExitExpiry.assetIds).toEqual(["wm-m0"]);
      await expect(runSafetyScoreV9ReplayCli([...args, "--rederive-current-redemption"])).rejects.toThrow("accepted captures");
      capture.registrySnapshot.fingerprint = "0".repeat(64);
      writeFileSync(capturePath, JSON.stringify(capture));
      await expect(runSafetyScoreV9ReplayCli(args)).rejects.toThrow("snapshot fingerprint does not match");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  // Repeated full-catalog snapshot verification reached 73s in all-critical V8 coverage.
  }, 180_000);

  it("refuses lossy or ambiguous accepted-capture CLI modes", async () => {
    await expect(runReportCardsFixedInputCaptureCli(["--output", "unused"])).rejects.toThrow("Exactly one");
    await expect(runReportCardsFixedInputCaptureCli([
      "--output", "unused", "--exact-cache-export", "base", "--accepted-cache-export", "pair",
    ])).rejects.toThrow("Exactly one");
    await expect(runReportCardsFixedInputCaptureCli([
      "--output", "unused", "--accepted-cache-export", "pair", "--normalized-only",
    ])).rejects.toThrow("--normalized-only cannot be combined");
  });

  describe("capture --require-current", () => {
    const withCapture = async (nowSec: number, run: (paths: { raw: string; output: string }) => Promise<void>) => {
      const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-require-current-"));
      const now = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1_000);
      try {
        const raw = resolve(dir, "raw.json"), output = resolve(dir, "capture.json");
        writeFileSync(raw, JSON.stringify(exactFixedInput()));
        await run({ raw, output });
      } finally {
        now.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it.each([
      ["current", 0, true], ["exact budget", SOURCE_FIXED_INPUT_MAX_AGE_SEC, true],
      ["budget + 1", SOURCE_FIXED_INPUT_MAX_AGE_SEC + 1, false], ["future by 1s", -1, false],
    ])("%s", async (_name, ageSec, accepted) => {
      await withCapture(CLOCK_SEC + ageSec, async ({ raw, output }) => {
        const run = () => runReportCardsFixedInputCaptureCli([
          "--exact-cache-export", raw, "--output", output, "--normalized-only", "--require-current",
        ]);
        if (accepted) {
          await run();
          expect(JSON.parse(readFileSync(output, "utf8")).clockSec).toBe(CLOCK_SEC);
        } else {
          await expect(run()).rejects.toThrow(ageSec < 0 ? "capture-future" : "capture-stale");
          expect(existsSync(output)).toBe(false);
        }
      });
    });

    it("names the assessment, clock, age, budget and generations in the rejection", () => {
      const input = exactFixedInput();
      const age = SOURCE_FIXED_INPUT_MAX_AGE_SEC + 5;
      expect(() => assertReportCardsCaptureCurrent(input, CLOCK_SEC + age)).toThrow("capture-stale: ");
      let message = "";
      try { assertReportCardsCaptureCurrent(input, CLOCK_SEC + age); } catch (error) { message = (error as Error).message; }
      const fragments = [`"assessedAtSec":${CLOCK_SEC + age}`, `"clockSec":${CLOCK_SEC}`, `"ageSec":${age}`,
        `"budgetSec":${SOURCE_FIXED_INPUT_MAX_AGE_SEC}`, `"sourceGeneration":"report-cards:fixture:v9-replay"`, `"baseInputGenerationId"`];
      const positions = fragments.map((fragment) => message.indexOf(fragment));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it("rejects malformed input and incompatible flag combinations without output", async () => {
      await withCapture(CLOCK_SEC, async ({ raw, output }) => {
        writeFileSync(raw, JSON.stringify({ clockSec: CLOCK_SEC }));
        await expect(runReportCardsFixedInputCaptureCli([
          "--exact-cache-export", raw, "--output", output, "--normalized-only", "--require-current",
        ])).rejects.toThrow();
        expect(existsSync(output)).toBe(false);
        for (const args of [
          ["--exact-cache-export", raw, "--require-current"],
          ["--accepted-cache-export", raw, "--normalized-only", "--require-current"],
          ["--accepted-cache-export", raw, "--require-current"],
        ]) {
          await expect(runReportCardsFixedInputCaptureCli(["--output", output, ...args])).rejects.toThrow();
        }
        expect(existsSync(output)).toBe(false);
      });
    });

    it("keeps default historical capture of an old input unchanged", async () => {
      await withCapture(CLOCK_SEC + 10 * SOURCE_FIXED_INPUT_MAX_AGE_SEC, async ({ raw, output }) => {
        await runReportCardsFixedInputCaptureCli(["--exact-cache-export", raw, "--output", output, "--normalized-only"]);
        expect(JSON.parse(readFileSync(output, "utf8")).clockSec).toBe(CLOCK_SEC);
      });
    });
  });

  it("parses raw exact JSON and the production cache envelope through equivalent paths", async () => {
    const fixedInput = exactFixedInput();
    const cacheEntry = await buildReportCardsFixedInputCacheEntry(fixedInput);

    await expect(parseSafetyScoreV9ReplayFixedInput(fixedInput)).resolves.toEqual(fixedInput);
    await expect(parseSafetyScoreV9ReplayFixedInput(JSON.parse(cacheEntry.value))).resolves.toEqual(fixedInput);
    await expect(parseSafetyScoreV9ReplayFixedInput(cacheEntry.value)).resolves.toEqual(fixedInput);
  });

  it("parses the native v4 capture and its v2 cache envelope through equivalent paths", async () => {
    const native = structuredClone(nativeInput);
    const cacheEntry = await buildNativeV9InputCacheEntry(
      native,
      buildSafetyScoreV9InputIdentity({
        methodologyVersion: native.methodologyVersion,
        baseInputGenerationId: native.baseInputGenerationId,
        publicationGenerationId: native.sourceGeneration,
      }),
    );

    await expect(parseSafetyScoreV9ReplayFixedInput(native)).resolves.toEqual(native);
    await expect(parseSafetyScoreV9ReplayFixedInput(JSON.parse(cacheEntry.value))).resolves.toEqual(native);
    await expect(parseSafetyScoreV9ReplayFixedInput(cacheEntry.value)).resolves.toEqual(native);
  }, 30_000);

  it("keeps the two capture generations on their own parsers", async () => {
    const legacy = exactFixedInput();
    const native = structuredClone(nativeInput);
    const legacyEnvelope = JSON.parse((await buildReportCardsFixedInputCacheEntry(legacy)).value) as {
      schemaVersion: number;
    };
    const nativeEnvelope = JSON.parse(
      (
        await buildNativeV9InputCacheEntry(
          native,
          buildSafetyScoreV9InputIdentity({
            methodologyVersion: native.methodologyVersion,
            baseInputGenerationId: native.baseInputGenerationId,
            publicationGenerationId: native.sourceGeneration,
          }),
        )
      ).value,
    ) as { schemaVersion: number };

    expect(legacyEnvelope.schemaVersion).toBe(1);
    expect(nativeEnvelope.schemaVersion).toBe(2);
    expect((await parseSafetyScoreV9ReplayFixedInput(legacy)).schemaVersion).toBe(3);
    expect((await parseSafetyScoreV9ReplayFixedInput(native)).schemaVersion).toBe(4);
    // A v2 envelope can never carry a V8-shaped capture.
    await expect(parseSafetyScoreV9ReplayFixedInput({ ...nativeEnvelope, schemaVersion: 1 })).rejects.toThrow();
  });

  it("serializes a byte-identical V9 replay artifact from explicit clocks", () => {
    const args = {
      fixedInput: exactFixedInput(),
      publishedAtSec: PUBLISHED_AT_SEC,
    };
    const artifact = buildSafetyScoreV9ReplayArtifact(args);
    const left = serializeSafetyScoreV9ReplayArtifact(artifact);
    const right = serializeSafetyScoreV9ReplayArtifact(buildSafetyScoreV9ReplayArtifact(structuredClone(args)));
    const parsed = JSON.parse(left) as {
      schemaVersion: number;
      kind: string;
      lifecycle: string;
      releaseAuthorization: { authorized: boolean; reason: string };
      pipeline: { candidate: { lifecycle: string; publishedAtSec: number } };
    };

    expect(right).toBe(left);
    expect(left.endsWith("\n")).toBe(true);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "safety-score-v9-candidate-replay",
      lifecycle: "active",
      releaseAuthorization: { authorized: false, reason: "v9-replay-only" },
      pipeline: {
        candidate: {
          lifecycle: "active",
          publishedAtSec: PUBLISHED_AT_SEC,
        },
      },
    });
    const compiledUsdc = artifact.pipeline.compiledFacts.assets[0]!;
    const incompleteControls = compiledUsdc.controls.filter(
      (control) =>
        control.capSemantics.kind === "unknown" ||
        control.claimImpairment === "unknown" ||
        control.economicLossScope === "unknown",
    );
    // SAFETY-SCORE-V9-25 L-08: an unmeasured route share is unattributed,
    // never a measured zero-share exemption.
    expect(compiledUsdc.controlStatus.observationState).toBe("bounded-unknown");
    expect(incompleteControls.length).toBeGreaterThan(0);
    expect(incompleteControls).toEqual([
      expect.objectContaining({
        economicLossScope: "deployment",
        materialSupplyShare: null,
        status: expect.objectContaining({
          applicability: expect.objectContaining({ state: "required" }),
          observationState: "bounded-unknown",
        }),
      }),
    ]);
  });

  it("writes identical canonical output for raw JSON and a cache envelope", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-replay-"));
    try {
      const fixedInput = exactFixedInput();
      const cacheEntry = await buildReportCardsFixedInputCacheEntry(fixedInput);
      const rawPath = resolve(dir, "fixed.json");
      const envelopePath = resolve(dir, "fixed-cache.json");
      const extensionPath = resolve(dir, "extension.json");
      const rawOutput = resolve(dir, "raw-output.json");
      const envelopeOutput = resolve(dir, "envelope-output.json");
      writeFileSync(rawPath, JSON.stringify(fixedInput));
      writeFileSync(envelopePath, cacheEntry.value);
      writeFileSync(extensionPath, JSON.stringify(buildSafetyScoreV9BaselineExtension(fixedInput)));

      const commonArgs = ["--published-at", PUBLISHED_AT_ISO, "--allow-future-reviews"];
      await runSafetyScoreV9ReplayCli([
        "--input",
        rawPath,
        "--output",
        rawOutput,
        "--extension",
        extensionPath,
        ...commonArgs,
      ]);
      await runSafetyScoreV9ReplayCli(["--input", envelopePath, "--output", envelopeOutput, ...commonArgs]);

      expect(readFileSync(envelopeOutput, "utf8")).toBe(readFileSync(rawOutput, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays a capture-time NAV asset that is non-NAV live only with its verified registry snapshot", async () => {
    const snapshot = structuredClone(cohortSnapshot(["usdc-circle"]));
    snapshot.activeStablecoins.find((coin) => coin.id === "usdc-circle")!.flags.navToken = true;
    snapshot.fingerprint = registrySnapshotFingerprint(snapshot);
    const { baseInputGenerationId: _derived, ...capture } = exactFixedInput();
    const historical = {
      ...capture,
      registryFingerprint: snapshot.fingerprint,
      navPriceById: {
        "usdc-circle": { priceUsd: 1.02, observedAtSec: CLOCK_SEC, sourceId: "coingecko", confidence: "high" },
      },
    };
    await expect(parseSafetyScoreV9ReplayFixedInput(historical)).rejects.toThrow("NAV price rows target non-NAV assets: usdc-circle");
    const fixedInput = await parseSafetyScoreV9ReplayFixedInput(historical, snapshot);
    const artifact = buildSafetyScoreV9ReplayArtifact({ fixedInput, registrySnapshot: snapshot, publishedAtSec: PUBLISHED_AT_SEC });
    expect(artifact.pipeline.candidate.cards.map((card) => card.id)).toEqual(["usdc-circle"]);
    expect(fixedInput.navPriceById?.["usdc-circle"]?.priceUsd).toBe(1.02);
    const corrupt = structuredClone(snapshot);
    corrupt.activeStablecoins.find((coin) => coin.id === "usdc-circle")!.flags.navToken = false;
    await expect(parseSafetyScoreV9ReplayFixedInput(historical, corrupt)).rejects.toThrow("snapshot fingerprint does not match");
  }, 60_000);

  it("replays a registry-fingerprint mismatch only behind --allow-registry-mismatch", async () => {
    // A capture frozen before a curation commit carries the registry
    // fingerprint of the tree it was captured from. Simulate that by rewriting
    // the fingerprint and dropping the derived base identity so the normalizer
    // re-derives it from the rewritten payload, exactly like a real capture
    // replayed after the registry moved.
    const { baseInputGenerationId: _derived, ...capture } = exactFixedInput();
    const staleCapture = { ...capture, registryFingerprint: "b".repeat(64) };

    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-replay-registry-"));
    try {
      const input = resolve(dir, "stale-registry.json");
      const output = resolve(dir, "output.json");
      writeFileSync(input, JSON.stringify(staleCapture));
      const args = [
        "--input",
        input,
        "--output",
        output,
        "--published-at",
        String(PUBLISHED_AT_SEC),
        "--allow-future-reviews",
      ];

      await expect(runSafetyScoreV9ReplayCli(args)).rejects.toThrow(
        /registry fingerprint .* does not match fixed input/,
      );

      await runSafetyScoreV9ReplayCli([...args, "--allow-registry-mismatch"]);
      const replayed = JSON.parse(readFileSync(output, "utf8")) as {
        pipeline: {
          extension: { registryFingerprint: string };
          candidate: { cards: { id: string }[] };
        };
      };
      // The override makes the replay adopt the capture's registry identity, so
      // the trusted compile path's extension-vs-input equality check still holds.
      expect(replayed.pipeline.extension.registryFingerprint).toBe("b".repeat(64));
      expect(replayed.pipeline.candidate.cards.map((card) => card.id)).toEqual(["usdc-circle"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts only explicit whole-second times and v9-rc-N overrides", async () => {
    expect(parseSafetyScoreV9PublishedAtSec(PUBLISHED_AT_ISO)).toBe(PUBLISHED_AT_SEC);
    expect(parseSafetyScoreV9PublishedAtSec(String(PUBLISHED_AT_SEC))).toBe(PUBLISHED_AT_SEC);
    expect(() => parseSafetyScoreV9PublishedAtSec(new Date(PUBLISHED_AT_SEC * 1_000 + 1).toISOString())).toThrow(
      /whole Unix seconds/,
    );

    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-replay-rc-"));
    try {
      const input = resolve(dir, "fixed.json");
      const output = resolve(dir, "output.json");
      writeFileSync(input, JSON.stringify(exactFixedInput()));
      await runSafetyScoreV9ReplayCli([
        "--input",
        input,
        "--output",
        output,
        "--published-at",
        String(PUBLISHED_AT_SEC),
        "--allow-future-reviews",
        "--release-candidate-id",
        "v9-rc-2",
      ]);
      expect(JSON.parse(readFileSync(output, "utf8")).pipeline.candidate.candidateId).toBe("v9-rc-2");

      await expect(
        runSafetyScoreV9ReplayCli([
          "--input",
          input,
          "--output",
          output,
          "--published-at",
          String(PUBLISHED_AT_SEC),
          "--release-candidate-id",
          "candidate-latest",
        ]),
      ).rejects.toThrow(/must match v9-rc-N/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("future-dated curated review guard", () => {
  it("flags USDU's scope and TermMax review at the November 19 capture clock", () => {
    const assetId = "usdu-usdu-finance";
    const meta = ACTIVE_META_BY_ID.get(assetId)!;
    const clock = Date.parse("2026-11-19T20:18:12Z") / 1_000;
    expect(findFutureDatedCuratedReviews(clock, new Map([[assetId, meta]]), [])).toEqual([
      { assetId, field: "reviewedAt", date: "2026-11-20" },
    ]);
    expect(meta.reserveReview).toMatchObject({
      compositionAsOf: "2026-10-27", reviewer: "OpenAI Codex #2150 pinned reserve review",
    });
  });

  function anyReviewedAtSec(): { assetId: string; sec: number } {
    for (const [assetId, meta] of ACTIVE_META_BY_ID) {
      const at = (meta as { reserveReview?: { reviewedAt?: string } }).reserveReview?.reviewedAt;
      if (typeof at === "string" && at.length > 0) {
        const sec = Date.parse(`${at}T00:00:00.000Z`) / 1_000;
        if (Number.isFinite(sec)) return { assetId, sec };
      }
    }
    throw new Error("no curated reserve review in the registry");
  }

  it("flags a review dated after the capture clock", () => {
    const { assetId, sec } = anyReviewedAtSec();
    const rows = findFutureDatedCuratedReviews(sec - 86_400);
    expect(rows.some((row) => row.assetId === assetId && row.field === "reviewedAt")).toBe(true);
  });

  it("compares exact overlay and component instants without delaying same-day date-only reviews", () => {
    const clockSec = Date.parse("2026-10-18T12:00:00Z") / 1_000;
    const meta = ACTIVE_META_BY_ID.values().next().value!;
    const rows = findFutureDatedCuratedReviews(clockSec, new Map([["fixture", meta]]), [{
      assetId: "fixture", reviewedAt: "2026-10-18T12:00:00.125Z", components: {
        earlier: { review: { reviewedAt: "2026-10-18T11:59:59Z" } },
        exact: { review: { reviewedAt: "2026-10-18T12:00:00Z" } },
        later: { review: { reviewedAt: "2026-10-18T12:00:01Z" } },
        dateOnly: { review: { reviewedAt: "2026-10-18" } },
      },
    }]);
    expect(rows.filter(row => row.field.startsWith("mechanism."))).toEqual([
      { assetId: "fixture", field: "mechanism.components.later.review.reviewedAt", date: "2026-10-18T12:00:01Z" },
      { assetId: "fixture", field: "mechanism.reviewedAt", date: "2026-10-18T12:00:00.125Z" },
    ]);
  });
});

describe("mechanism capture replay resolution", () => {
  it("resolves a local cache hit, then an R2 hit, and fails closed after expiry", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pharos-measurement-replay-"));
    try {
      const body = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "test-capture", value: 7 }));
      const sha256 = createHash("sha256").update(body).digest("hex");
      const summaryRoot = resolve(dir, "summaries");
      const summaryDirectory = resolve(summaryRoot, "test-mechanism");
      const summaryPath = resolve(summaryDirectory, "2026-09-03.summary.json");
      const cacheDir = resolve(dir, "cache");
      mkdirSync(summaryDirectory, { recursive: true });
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        summaryPath,
        JSON.stringify({
          mechanism: "test-mechanism",
          date: "2026-09-03",
          sha256,
          bytes: body.byteLength,
          r2Key: "captures/test-mechanism/2026-09-03.json.gz",
          summary: { kind: "test-capture", journalPath: "shared/data/safety-score-v9/mechanism-measurements/test-mechanism/2026-09-03.json" },
        }),
      );

      writeFileSync(resolve(cacheDir, `${sha256}.json`), body);
      await expect(resolveSafetyScoreV9ReplayInput(sha256, { cacheDir, summaryRoot })).resolves.toEqual(body);

      rmSync(resolve(cacheDir, `${sha256}.json`));
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(gzipSync(body), { status: 200 }));
      const r2Client = createR2MeasurementsClient({
        accountId: "account-123",
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        fetch: fetchMock,
        now: () => new Date("2026-09-03T12:34:56.000Z"),
      });
      await expect(resolveSafetyScoreV9ReplayInput(sha256, { cacheDir, summaryRoot, r2Client })).resolves.toEqual(body);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/pinned/test-mechanism/2026-09-03.json.gz");

      rmSync(resolve(cacheDir, `${sha256}.json`));
      await expect(
        resolveSafetyScoreV9ReplayInput(sha256, { cacheDir, summaryRoot: resolve(dir, "expired"), r2Client }),
      ).rejects.toThrow(`capture ${sha256} expired: non-replayable`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Safety Score V9 admission receipt builder and verifier", () => {
  const SUPPLY_OBS = (admissionClockSec: number, observedAtSec: number | null = admissionClockSec - 60) => ({
    circulating: { peggedUSD: 5_000_000 },
    observedAtSec,
    url: "https://api.example/phase1a-supply",
    field: "circulating.peggedUSD",
    retrievedAtSec: admissionClockSec,
  });

  it("marks DEX explicitly unavailable (never verified-empty) and counts missing-runtime-route-evidence", () => {
    const assetId = "usdc-circle";
    const cohort = collectProspectiveCohortIds(assetId);
    const maxReview = maxCuratedReviewSecForCohort(cohort);
    const nowSec = Math.max(maxReview + 3_600, Math.floor(Date.now() / 1_000));
    const admissionClockSec = nowSec - 600;
    const supplyObservation = SUPPLY_OBS(admissionClockSec);

    const built = buildProspectiveAdmissionReceipt({
      assetId,
      admissionClockSec,
      supplyObservation,
      nowSec,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const { receipt, pipeline } = built;
    expect(NewAssetAdmissionReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt.receiptMode).toBe("prospective-offline");
    expect(receipt.absentRuntimeLanes).toEqual([...PROSPECTIVE_ABSENT_RUNTIME_LANES]);
    expect(receipt.evaluationBuildDigest).toBe(SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST);
    expect(receipt.prospectiveInputId).toBe(computeProspectiveAdmissionInputId({
      assetId,
      admissionClockSec,
      evaluatedCohortIds: receipt.evaluatedCohortIds,
      supplyObservation,
      registryFingerprint: receipt.registryFingerprint,
      evaluationBuildDigest: receipt.evaluationBuildDigest,
    }));

    // REVIEW-1 #1: offline shell marks DEX unavailable, never verified-empty.
    expect(pipeline.fixedInput.v9PublicationInputHealth.dex.state).toBe("unavailable");
    expect(pipeline.fixedInput.liquidityStale).toBe(true);
    const evaluatedUsdc = pipeline.evaluatedSet.assets.find((asset) => asset.assetId === assetId)!;
    expect(evaluatedUsdc.trace.unresolvedFacts.some((fact) => fact.code === "no-viable-exit-path")).toBe(false);
    const cardIndex = pipeline.candidate.cards.findIndex((entry) => entry.id === assetId);
    expect(cardIndex).toBeGreaterThanOrEqual(0);
    expect(pipeline.candidate.pillarFreshness?.dexObservedAtSec[cardIndex]).toBe(0);
    expect(receipt.questions.some(
      (question) =>
        question.bucket === "open" &&
        !question.inherited &&
        question.codes.some((code) => code.code === "missing-runtime-route-evidence" && !code.documentation),
    )).toBe(true);

    // Also prove DEX-only coins (no configured redemption backstop) stay unavailable, never verified-empty.
    const dexOnlyId = "usdx-axis";
    const dexOnlyClock = Math.max(maxCuratedReviewSecForCohort(collectProspectiveCohortIds(dexOnlyId)) + 600, admissionClockSec);
    const dexOnlyBuilt = buildProspectiveAdmissionReceipt({
      assetId: dexOnlyId,
      admissionClockSec: dexOnlyClock,
      supplyObservation: SUPPLY_OBS(dexOnlyClock),
      nowSec: Math.max(nowSec, dexOnlyClock + 60),
    });
    expect(dexOnlyBuilt.ok).toBe(true);
    if (dexOnlyBuilt.ok) {
      const evaluatedDexOnly = dexOnlyBuilt.pipeline.evaluatedSet.assets.find((asset) => asset.assetId === dexOnlyId)!;
      expect(evaluatedDexOnly.scoreInput.pillars.exit.score).toBeNull();
      expect(evaluatedDexOnly.scoreInput.pillars.exit.aggregationDisposition).toBe("unavailable");
      expect(evaluatedDexOnly.trace.unresolvedFacts.some((fact) => fact.code === "no-viable-exit-path")).toBe(false);
      expect(dexOnlyBuilt.receipt.questions.some(
        (question) => question.questionKey === `${dexOnlyId}|component|exit-routes` && question.bucket === "open",
      )).toBe(true);
    }

    // Offline recomputation passes untouched and fails closed on tampering.
    expect(verifyProspectiveAdmissionReceipt(receipt, { nowSec })).toMatchObject({ ok: true, assetId });
    const tampered = {
      ...receipt,
      card: { ...receipt.card, openBucketQuestionsCarried: Math.max(0, receipt.card.openBucketQuestionsCarried - 1) },
    };
    expect(verifyProspectiveAdmissionReceipt(tampered, { nowSec })).toMatchObject({
      ok: false,
      kind: "recomputed-receipt-mismatch",
    });
    const tamperedQuestions = {
      ...receipt,
      questions: receipt.questions.slice(1),
      card: {
        ...receipt.card,
        openBucketQuestionsCarried: receipt.questions.slice(1).filter((q) => q.bucket === "open").length,
        inheritedOpenBucketQuestionsCarried: receipt.questions.slice(1).filter((q) => q.bucket === "open" && q.inherited).length,
        openBucketObligationsCarried: receipt.questions.slice(1).filter((q) => q.bucket === "open").reduce((s, q) => s + q.obligations, 0),
        documentationObligationsCarried: receipt.questions.slice(1).reduce((s, q) => s + q.codes.filter((c) => c.documentation).reduce((ds, c) => ds + c.obligations, 0), 0),
      },
    };
    expect(verifyProspectiveAdmissionReceipt(tamperedQuestions, { nowSec })).toMatchObject({
      ok: false,
      kind: "recomputed-receipt-mismatch",
    });
  }, 60_000);

  it("enforces admission clock bounds and preserves clockless supply as null canonical supply", () => {
    const assetId = "usdc-circle";
    const maxReview = maxCuratedReviewSecForCohort(collectProspectiveCohortIds(assetId));
    const nowSec = Math.max(maxReview + 7_200, Math.floor(Date.now() / 1_000));

    expect(buildProspectiveAdmissionReceipt({
      assetId,
      admissionClockSec: nowSec + 1,
      supplyObservation: SUPPLY_OBS(nowSec),
      nowSec,
    })).toMatchObject({ ok: false, kind: "stale-admission-clock" });

    expect(buildProspectiveAdmissionReceipt({
      assetId,
      admissionClockSec: nowSec - NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC - 1,
      supplyObservation: SUPPLY_OBS(nowSec - NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC - 1),
      nowSec,
    })).toMatchObject({ ok: false, kind: "stale-admission-clock" });

    if (maxReview > 1) {
      expect(buildProspectiveAdmissionReceipt({
        assetId,
        admissionClockSec: maxReview - 1,
        supplyObservation: SUPPLY_OBS(maxReview - 1),
        nowSec: maxReview + 60,
      })).toMatchObject({ ok: false, kind: "stale-admission-clock" });
    }

    const clockless = buildProspectiveAdmissionReceipt({
      assetId,
      admissionClockSec: nowSec - 60,
      supplyObservation: SUPPLY_OBS(nowSec - 60, null),
      nowSec,
    });
    expect(clockless.ok).toBe(true);
    if (clockless.ok) {
      const compiled = clockless.pipeline.compiledFacts.assets.find((asset) => asset.assetId === assetId)!;
      expect(compiled.supply.circulatingUsd).toBeNull();
      expect(compiled.supply.replayObservation?.observedAtSec).toBeNull();
    }
  }, 60_000);

  it("refuses quarantined candidates and transitive parents in pipeline-gap", () => {
    const usdc = structuredClone(ACTIVE_META_BY_ID.get("usdc-circle")!);
    const nowSec = Math.max(maxCuratedReviewSecForCohort(["usdc-circle"]) + 3_600, Math.floor(Date.now() / 1_000));
    const admissionClockSec = nowSec - 60;

    // Non-quarantined parent with <2 supported pillars offline (no redemption config, no control subject)
    // resolves to ratingStatus="pipeline-gap", which must fail prospective-parent-pipeline-gap.
    const brokenParent: StablecoinMeta = {
      ...structuredClone(usdc),
      id: "parent-gap-test",
      mintAuthority: undefined,
      contracts: undefined,
      bridgeRouteRisk: undefined,
      reserves: undefined,
      reserveReview: undefined,
    };
    const child = {
      ...structuredClone(usdc),
      id: "child-of-gap-test",
      variantOf: "parent-gap-test",
      variantKind: "pure-wrapper" as const,
      dependencies: [{ id: "parent-gap-test", weight: 1, type: "wrapper" as const }],
    };
    const parentGapMeta = new Map<string, StablecoinMeta>([
      [brokenParent.id, brokenParent],
      [child.id, child],
    ]);
    const parentRefusal = buildProspectiveAdmissionReceipt({
      assetId: child.id,
      admissionClockSec,
      supplyObservation: SUPPLY_OBS(admissionClockSec),
      nowSec,
      metaById: parentGapMeta,
      registryFingerprint: "c".repeat(64),
    });
    expect(parentRefusal).toMatchObject({ ok: false, kind: "prospective-parent-pipeline-gap" });

    // Candidate whose extension review fails compilation quarantines fail-closed.
    const quarantinedCandidate: StablecoinMeta = {
      ...structuredClone(usdc),
      id: "quarantine-test",
      mintAuthority: {
        ...structuredClone(usdc.mintAuthority!),
        review: {
          ...structuredClone(usdc.mintAuthority!.review),
          reviewedAt: "not-a-date",
        },
      },
    };
    const quarantineRefusal = buildProspectiveAdmissionReceipt({
      assetId: quarantinedCandidate.id,
      admissionClockSec,
      supplyObservation: SUPPLY_OBS(admissionClockSec),
      nowSec,
      metaById: new Map([[quarantinedCandidate.id, quarantinedCandidate]]),
      registryFingerprint: "d".repeat(64),
    });
    expect(quarantineRefusal).toMatchObject({ ok: false, kind: "prospective-asset-quarantined" });
  }, 60_000);

  it("emits production-capture receipts from replay artifacts and runs strict CLI --verify", async () => {
    const artifact = buildSafetyScoreV9ReplayArtifact({
      fixedInput: exactFixedInput(),
      publishedAtSec: PUBLISHED_AT_SEC,
    });
    const captureReceipt = buildProductionCaptureAdmissionReceipt(artifact, "usdc-circle");
    expect(NewAssetAdmissionReceiptSchema.safeParse(captureReceipt).success).toBe(true);
    expect(captureReceipt.schemaVersion).toBe(3);
    expect(captureReceipt.receiptMode).toBe("production-capture");
    expect(captureReceipt.card).toEqual(projectReceiptEvidenceFromPipeline(artifact.pipeline, "usdc-circle").card);

    // Offline shell helper emits unavailable DEX generation.
    const shell = buildProspectiveOfflineFixedInput({
      assetId: "usdc-circle",
      admissionClockSec: PUBLISHED_AT_SEC,
      cohortIds: ["usdc-circle"],
      supplyObservation: SUPPLY_OBS(PUBLISHED_AT_SEC),
    });
    expect(shell.dexGenerationId).toBe("dex-liquidity-0");
    expect(shell.v9PublicationInputHealth.dex.state).toBe("unavailable");

    const dir = mkdtempSync(resolve(tmpdir(), "pharos-v9-admit-cli-"));
    try {
      const nowSec = Math.max(maxCuratedReviewSecForCohort(["usdc-circle"]) + 3_600, Math.floor(Date.now() / 1_000));
      const supplyPath = resolve(dir, "supply.json");
      const receiptPath = resolve(dir, "usdc-circle.json");
      writeFileSync(supplyPath, JSON.stringify({ "usdc-circle": SUPPLY_OBS(nowSec - 60) }), "utf8");

      const exitBuild = await runSafetyScoreV9AdmissionReceiptCli([
        "--asset", "usdc-circle",
        "--supply-observations", supplyPath,
        "--clock", String(nowSec - 60),
        "--now", String(nowSec),
        "--output", receiptPath,
      ]);
      expect(exitBuild).toBe(0);
      expect(existsSync(receiptPath)).toBe(true);

      const verifySpawn = spawnSync(
        process.execPath,
        [
          "--import", "tsx",
          resolve(import.meta.dirname, "../build-safety-score-v9-admission-receipt.ts"),
          "--verify", receiptPath,
          "--now", String(nowSec),
          "--json",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(verifySpawn.status, verifySpawn.stderr).toBe(0);
      expect(JSON.parse(verifySpawn.stdout)).toMatchObject({ ok: true, assetId: "usdc-circle" });

      const usageSpawn = spawnSync(
        process.execPath,
        [
          "--import", "tsx",
          resolve(import.meta.dirname, "../build-safety-score-v9-admission-receipt.ts"),
          "--verify", receiptPath,
          "--asset", "usdc-circle",
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(usageSpawn.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
