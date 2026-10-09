import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeRedemptionPayloadFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { computePegScore } from "@shared/lib/peg-score";
import { buildSafetyScoreV9PegProvenanceSummary, projectSafetyScoreV9PegScoreResult } from "../safety-score-v9/peg-provenance";
import { pegSummary } from "./safety-score-v9-peg-provenance.test-support";
import { redemptionLossOutcome } from "../redemption-backstop/loss";
import { makeRedemptionWriteRecord } from "./redemption-backstops-store.test-support";
import { assessReserveFetchFreshness } from "../live-reserves/store-snapshot-state";
import {
  buildNativeV9InputCacheEntry,
  computeNativeDexLiquidityPayloadFingerprint,
  deriveNativeV9BaseInputGenerationId,
  NATIVE_V9_INPUT_CACHE_KEY,
  NativeSafetyScoreV9InputSchema,
  normalizeNativeV9Input,
  parseNativeV9InputCacheArtifact,
  parseNativeV9InputCacheValue,
  parseSafetyScoreV9InputCacheValue,
  type NativeSafetyScoreV9Input,
} from "../safety-score-v9/native-input";
import { parseReportCardsFixedInputCacheValue } from "../report-cards-fixed-input";
import {
  buildReportCardsFixedInputCacheEntry,
  createReportCardsFixedInput,
} from "../../test-helpers/report-cards-fixed-input";

import { createAssetBuildContext, createRuntimeGapVerdict } from "../safety-score-v9/fact-set-context";
import { createReportCardEvidenceJournalV1 } from "@shared/lib/report-card-evidence-journal";
import { captureReservePipelineGaps } from "../safety-score-v9/capture";
import { reserveLossLineage, reserveLossOutcome } from "../live-reserves/loss";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { materializeSafetyScoreV9FactSetExtension } from "../safety-score-v9/fact-set";
import { buildReserves } from "../safety-score-v9/fact-set-backing";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
const CLOCK_SEC = 1_783_891_200;
const DEX_UPDATED_AT = 1_783_891_100;
const SOURCE_GENERATION = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${CLOCK_SEC}`;
const ACTIVE_IDS = ACTIVE_STABLECOINS.map((coin) => coin.id);
const RESERVE_REPLAY_META = new Map(["usdc-circle", "usdt-tether"].map((id) =>
  [id, { id, mechanismArchetype: "fiat-cash" as const, launchDate: "2020-01-01" }]));
const RESERVE_REPLAY_REGISTRY_FINGERPRINT = domainDigest("safety-score-v9.reserve-loss-fixture-registry.v1", [...RESERVE_REPLAY_META]);

function nativeDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dexLiqMap = {
    "usdc-circle": { updatedAt: DEX_UPDATED_AT },
    "usdt-tether": { updatedAt: DEX_UPDATED_AT },
  };
  return {
    schemaVersion: 4,
    captureKind: "native-v9-inputs",
    capturedAt: new Date(CLOCK_SEC * 1_000).toISOString(),
    sourceGeneration: SOURCE_GENERATION,
    registryRevision: `sha256:${"c".repeat(64)}`,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: CLOCK_SEC,
    updatedAt: CLOCK_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: CLOCK_SEC - DEX_UPDATED_AT, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    v9PublicationInputHealth: {
      dex: { state: "current", generationId: `dex-liquidity-${DEX_UPDATED_AT}`, updatedAtSec: DEX_UPDATED_AT },
      redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
      liveReserves: { state: "available", coverageRatio: 1 },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    redemptionBackstopMap: {},
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {
      "usdc-circle": { ethereum: { current: 1_000 } },
    },
    aggregateCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    liveToFallbackCoins: [],
    activeAssetIds: ["usdc-circle", "usdt-tether"],
    dexGenerationId: `dex-liquidity-${DEX_UPDATED_AT}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
      dexLiqMap,
      `dex-liquidity-${DEX_UPDATED_AT}`,
    ),
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint({}, "redemption-backstops-unavailable"),
    registryFingerprint: "c".repeat(64),
    inputMethodologyVersions: {
      safetyScore: SAFETY_SCORE_METHODOLOGY_VERSION,
      dexLiquidity: ["1.0"],
      pegScore: [],
      redemptionBackstop: [],
    },
    dexLiqMap,
    ...overrides,
  };
}

function nativeInput(overrides: Record<string, unknown> = {}): NativeSafetyScoreV9Input {
  return normalizeNativeV9Input(nativeDraft(overrides));
}

describe("frozen redemption loss lineage", () => {
  it("round-trips a quarantined cohort while preserving the whole-publication stale hold", async () => {
    const runId = "redemption:all-quarantined";
    const loss = redemptionLossOutcome({
      assetId: "usdc-circle", routeKey: "redemption:usdc-circle:offchain-issuer", reason: "malformed-persisted-row",
      disposition: "semantic", runId, observedAtSec: CLOCK_SEC - 100,
    });
    const input = nativeInput({
      redemptionLossOutcomesByAssetId: { "usdc-circle": [loss] },
      inputFreshness: {
        dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: CLOCK_SEC - DEX_UPDATED_AT, stale: false },
        redemptionBackstops: { updatedAt: CLOCK_SEC - 100, ageSeconds: 100, stale: true },
      },
      v9PublicationInputHealth: {
        dex: { state: "current", generationId: `dex-liquidity-${DEX_UPDATED_AT}`, updatedAtSec: DEX_UPDATED_AT },
        redemption: { state: "stale", generationId: runId, updatedAtSec: CLOCK_SEC - 100 },
        liveReserves: { state: "available", coverageRatio: 1 },
      },
    });
    const identity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: input.methodologyVersion, baseInputGenerationId: input.baseInputGenerationId,
      publicationGenerationId: input.sourceGeneration,
    });
    const stored = await buildNativeV9InputCacheEntry(input, identity);
    const replayed = await parseNativeV9InputCacheValue(stored.value);
    expect(replayed.redemptionStale).toBe(true);
    expect(replayed.v9PublicationInputHealth.redemption.state).toBe("stale");
    expect(replayed.redemptionLossOutcomesByAssetId).toEqual({ "usdc-circle": [loss] });
    expect(replayed.baseInputGenerationId).toBe(input.baseInputGenerationId);
    const mutated = structuredClone(input);
    mutated.redemptionLossOutcomesByAssetId!["usdc-circle"][0].reason = "different-rejection";
    expect(() => normalizeNativeV9Input(mutated)).toThrow(/does not match payload/);
  });

  it("fails closed when a nonlegacy loss belongs to a different producer run", () => {
    const loss = redemptionLossOutcome({
      assetId: "usdc-circle", routeKey: "redemption:usdc-circle:offchain-issuer", reason: "sync-error",
      disposition: "unknown", runId: "redemption:wrong-run", observedAtSec: CLOCK_SEC,
    });
    expect(() => nativeInput({ redemptionLossOutcomesByAssetId: { "usdc-circle": [loss] } })).toThrow(/redemption loss identity mismatch/);
  });
});

function reserveProjection(value: NativeSafetyScoreV9Input) {
  const extension = buildSafetyScoreV9BaselineExtension(value, {
    metaById: RESERVE_REPLAY_META, registryFingerprint: RESERVE_REPLAY_REGISTRY_FINGERPRINT,
  });
  const admitted = materializeSafetyScoreV9FactSetExtension(value, extension);
  const context = createAssetBuildContext(value, admitted, admitted.assets.find((asset) => asset.assetId === "usdc-circle")!,
    domainDigest("safety-score-v9.reserve-loss-replay-test.v1", admitted));
  return { facts: buildReserves(context), evidence: [...context.evidence.values()] };
}


describe("native Safety Score V9 input", () => {
  it("admits healthy older parents and pending attempts but requires each finalized attempt's own operational proof", () => {
    const runId = "redemption:legacy-parent";
    const entry = makeRedemptionWriteRecord({
      stablecoinId: "usdc-circle", updatedAt: CLOCK_SEC,
      reserveInput: { generationId: "reserve:legacy-parent", contentSha256: "a".repeat(64),
        stablecoinId: "usdc-circle", attemptId: "success", configFingerprint: "b".repeat(64),
        freshness: assessReserveFetchFreshness({ fetchedAt: CLOCK_SEC - 60, attemptId: "success",
          metadata: { freshnessMode: "not-applicable" } }, CLOCK_SEC, 172800) },
    });
    const map = { "usdc-circle": entry };
    const overrides = {
      redemptionBackstopMap: map, redemptionGenerationId: runId, redemptionStale: false,
      redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint(map, runId),
      inputMethodologyVersions: { safetyScore: SAFETY_SCORE_METHODOLOGY_VERSION, dexLiquidity: ["1.0"],
        pegScore: [], redemptionBackstop: [entry.methodologyVersion] },
      inputFreshness: { dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: CLOCK_SEC - DEX_UPDATED_AT, stale: false },
        redemptionBackstops: { updatedAt: CLOCK_SEC, ageSeconds: 0, stale: false } },
      v9PublicationInputHealth: {
        dex: { state: "current", generationId: `dex-liquidity-${DEX_UPDATED_AT}`, updatedAtSec: DEX_UPDATED_AT },
        redemption: { state: "current", generationId: runId, updatedAtSec: CLOCK_SEC },
        liveReserves: { state: "available", coverageRatio: 1 },
      },
    };
    expect(nativeInput(overrides).redemptionBackstopMap["usdc-circle"].reserveInput).toEqual(entry.reserveInput);
    expect(nativeInput({ ...overrides, reserveLossLineageById: {} }).redemptionBackstopMap["usdc-circle"].reserveInput).toEqual(entry.reserveInput);
    for (const lineage of [
      { latest: null, invalidations: {} },
      { latest: null, invalidations: {}, authority: { attemptId: null, observedAtSec: CLOCK_SEC, sourceId: "b".repeat(64) } },
      { latest: null, invalidations: {}, authority: { attemptId: "new-success", observedAtSec: CLOCK_SEC, sourceId: "b".repeat(64) } },
    ]) {
      expect(nativeInput({ ...overrides, reserveLossLineageById: { "usdc-circle": lineage } })
        .redemptionBackstopMap["usdc-circle"].reserveInput).toEqual(entry.reserveInput);
    }
    const operationalLoss = (attemptId: string, observedAtSec: number) => reserveLossOutcome({
      assetId: entry.stablecoinId, sourceId: entry.reserveInput!.configFingerprint, attemptId, observedAtSec,
      reason: "budget-deferred", legs: [{ key: "primary", sourceId: entry.reserveInput!.configFingerprint,
        result: "not-started", loss: { key: "primary", sourceId: entry.reserveInput!.configFingerprint,
          disposition: "operational", reason: "budget-deferred", proof: `${attemptId}:before-collector` } }],
      priorEvidence: { ref: "reserve-composition:usdc-circle:success", observedAtSec: CLOCK_SEC - 60,
        expiresAtSec: CLOCK_SEC - 60 + 172801 },
    });
    const previous = operationalLoss("previous-deferral", CLOCK_SEC - 10);
    const state = { stablecoinId: entry.stablecoinId, configFingerprint: entry.reserveInput!.configFingerprint,
      lastSuccessAt: CLOCK_SEC - 60, lastSuccessAttemptId: "success",
      lastAttemptedAt: CLOCK_SEC, lastAttemptId: "current-deferral", pendingAttemptId: "current-deferral",
      metadata: { reserveLoss: previous } };
    const cleanPending = reserveLossLineage({ ...state, metadata: {}, lastStatus: "ok" });
    expect(cleanPending.latest).toBeNull();
    expect(nativeInput({ ...overrides, reserveLossLineageById: { "usdc-circle": cleanPending } })
      .redemptionBackstopMap["usdc-circle"].reserveInput).toEqual(entry.reserveInput);
    const pending = reserveLossLineage(state);
    expect(pending.latest).toEqual(previous);
    expect(nativeInput({ ...overrides, reserveLossLineageById: { "usdc-circle": pending } })
      .redemptionBackstopMap["usdc-circle"].reserveInput).toEqual(entry.reserveInput);
    const unprovedFinalized = reserveLossLineage({ ...state, pendingAttemptId: null, lastStatus: "error" });
    expect(unprovedFinalized.latest).toMatchObject({ disposition: "unknown", attemptId: "current-deferral",
      observedAtSec: CLOCK_SEC, reason: "current-attempt-proof-mismatched" });
    expect(() => nativeInput({ ...overrides, reserveLossLineageById: { "usdc-circle": unprovedFinalized } }))
      .toThrow(/revoked reserve parent/);
    const finalized = reserveLossLineage({ ...state, pendingAttemptId: null,
      metadata: { reserveLoss: operationalLoss("current-deferral", CLOCK_SEC) } });
    expect(nativeInput({ ...overrides, reserveLossLineageById: { "usdc-circle": finalized } })
      .redemptionBackstopMap["usdc-circle"].reserveInput).toEqual(entry.reserveInput);
  });

  it("round-trips complete reserve loss lineage and inherited route proof without renewing original clocks", async () => {
    const loss = reserveLossOutcome({ assetId: "usdc-circle", sourceId: "reserve:fixture",
      attemptId: "reserve:failed", runId: "reserve:run", observedAtSec: CLOCK_SEC - 10,
      reason: "validation-failed", legs: [], rejection: { key: "admission", sourceId: "reserve:fixture",
        disposition: "semantic", reason: "validation-failed", proof: "reserve:failed:admission" },
      priorEvidence: { ref: "reserve-composition:usdc-circle:success", observedAtSec: CLOCK_SEC - 60, expiresAtSec: CLOCK_SEC + 100 } });
    const routeLoss = { ...loss, scope: { assetId: "usdc-circle", kind: "route" as const, key: "redemption:usdc-circle:offchain-issuer" } };
    const lineage = { latest: loss, invalidations: { composition: loss },
      attemptLegs: [{ key: "primary", sourceId: "reserve:fixture", result: "returned" as const, loss: null }] };
    const input = nativeInput({ registryFingerprint: RESERVE_REPLAY_REGISTRY_FINGERPRINT,
      registryRevision: `sha256:${RESERVE_REPLAY_REGISTRY_FINGERPRINT}`, reserveLossLineageById: { "usdc-circle": lineage },
      redemptionLossOutcomesByAssetId: { "usdc-circle": [routeLoss] } });
    const identity = buildSafetyScoreV9InputIdentity({ methodologyVersion: input.methodologyVersion,
      baseInputGenerationId: input.baseInputGenerationId, publicationGenerationId: input.sourceGeneration });
    const stored = await buildNativeV9InputCacheEntry(input, identity);
    const replayed = await parseNativeV9InputCacheValue(stored.value);
    expect(reserveProjection(replayed)).toEqual(reserveProjection(input));
    expect(reserveProjection(replayed).facts.reserveLossLineage).toEqual(lineage);
    expect(replayed).toEqual(input);
    expect(replayed.reserveLossLineageById?.["usdc-circle"]).toEqual(lineage);
    expect(replayed.redemptionLossOutcomesByAssetId?.["usdc-circle"]?.[0]).toEqual(routeLoss);
    const changed = structuredClone(input);
    changed.reserveLossLineageById!["usdc-circle"].latest!.reason = "different-rejection";
    changed.reserveLossLineageById!["usdc-circle"].invalidations.composition.reason = "different-rejection";
    changed.redemptionLossOutcomesByAssetId!["usdc-circle"][0].reason = "different-rejection";
    expect(() => normalizeNativeV9Input(changed)).toThrow(/does not match payload/);
  });
  it("rejects inherited reserve route proof unless its complete parent packet matches", () => {
    const parent = reserveLossOutcome({ assetId: "usdc-circle", sourceId: "reserve:fixture",
      attemptId: "reserve:failed", runId: "reserve:run", observedAtSec: CLOCK_SEC - 10,
      reason: "validation-failed", legs: [], rejection: { key: "admission", sourceId: "reserve:fixture",
        disposition: "semantic", reason: "validation-failed", proof: "reserve:failed:admission" },
      priorEvidence: { ref: "reserve-composition:usdc-circle:success", observedAtSec: CLOCK_SEC - 60, expiresAtSec: CLOCK_SEC + 100 } });
    const routeLoss = { ...parent, scope: { assetId: "usdc-circle", kind: "route" as const, key: "redemption:usdc-circle:offchain-issuer" } };
    const draft = { reserveLossLineageById: { "usdc-circle": { latest: parent, invalidations: { composition: parent } } },
      redemptionLossOutcomesByAssetId: { "usdc-circle": [routeLoss] } };
    expect(() => nativeInput(draft)).not.toThrow();
    for (const changed of [
      { ...routeLoss, reason: "different-parent-reason" },
      { ...routeLoss, observedAtSec: CLOCK_SEC - 9 },
      { ...routeLoss, priorEvidence: { ...routeLoss.priorEvidence!, observedAtSec: CLOCK_SEC - 59 } },
      { ...routeLoss, legs: [{ ...routeLoss.legs[0]!, proof: "different-stage-proof" }, ...routeLoss.legs.slice(1)] },
    ]) {
      expect(() => nativeInput({ ...draft, redemptionLossOutcomesByAssetId: { "usdc-circle": [changed] } }))
        .toThrow(/redemption loss identity mismatch/);
    }
  });

  it("expires operationally retained Backing references at their original eight-hour clock", () => {
    const originalFetch = CLOCK_SEC - 28800;
    const loss = reserveLossOutcome({ assetId: "usdc-circle", sourceId: "fixture-reserve-api",
      attemptId: "reserve-skipped", observedAtSec: CLOCK_SEC - 10, reason: "budget-deferred",
      legs: [{ key: "primary", sourceId: "fixture-reserve-api", result: "not-started", loss: {
        key: "primary", sourceId: "fixture-reserve-api", disposition: "operational",
        reason: "budget-deferred", proof: "reserve-skipped:before-collector" } }],
      priorEvidence: { ref: "reserve-composition:usdc-circle:success", observedAtSec: originalFetch, expiresAtSec: originalFetch + 172801 } });
    for (const [elapsed, freshness] of [[0, "current"], [1, "stale"]] as const) {
      const value = nativeInput({ clockSec: CLOCK_SEC + elapsed, updatedAt: CLOCK_SEC + elapsed,
        registryFingerprint: RESERVE_REPLAY_REGISTRY_FINGERPRINT, registryRevision: `sha256:${RESERVE_REPLAY_REGISTRY_FINGERPRINT}`,
        capturedAt: new Date((CLOCK_SEC + elapsed) * 1000).toISOString(),
        inputFreshness: { dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: CLOCK_SEC + elapsed - DEX_UPDATED_AT, stale: false },
          redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true } },
        liveReserveMap: { "usdc-circle": [{ sourceKey: "fixture:cash", name: "Cash", pct: 100,
          risk: "very-low", assetClass: "cash", issuerOrObligor: "issuer:usdc", liquidityHorizon: "immediate", maturityDaysMax: 0, riskFactors: ["custody"] }] },
        liveReserveProvenanceMap: { "usdc-circle": { source: "fixture-reserve-api", fetchedAt: originalFetch } },
        reserveLossLineageById: { "usdc-circle": { latest: loss, invalidations: {} } } });
      const { facts, evidence } = reserveProjection(value);
      const references = evidence.filter((row) => row.sourceId === "fixture-reserve-api");
      expect(references.length).toBeGreaterThan(0);
      expect(references.every((row) => row.observedAtSec === originalFetch && row.freshness.state === freshness)).toBe(true);
      expect(facts.reserveLossLineage?.latest?.priorEvidence?.observedAtSec).toBe(originalFetch);
    }
  });



  it.each([undefined, null, CLOCK_SEC - 3_601])(
    "round-trips legacy, unknown and original peg clocks (%s) without clock substitution",
    async (priceObservedAt) => {
      const peg = {
        ...pegSummary([], CLOCK_SEC, CLOCK_SEC - 86_400, "6.098"),
        id: "usdc-circle", symbol: "USDC", name: "USD Coin",
        priceSource: "cached", priceObservedAtMode: "upstream" as const,
        ...(priceObservedAt === undefined ? {} : { priceObservedAt }),
      };
      const input = nativeInput({ pegDataById: { "usdc-circle": peg } });
      const identity = buildSafetyScoreV9InputIdentity({
        methodologyVersion: input.methodologyVersion,
        baseInputGenerationId: input.baseInputGenerationId,
        publicationGenerationId: input.sourceGeneration,
      });
      const stored = await buildNativeV9InputCacheEntry(input, identity);
      const replayed = await parseNativeV9InputCacheValue(stored.value);
      expect(replayed.baseInputGenerationId).toBe(input.baseInputGenerationId);
      expect(replayed.pegDataById["usdc-circle"]).toEqual(peg);
      expect(replayed.pegDataById["usdc-circle"]!.priceObservedAt).toBe(priceObservedAt);
      if (priceObservedAt === undefined) {
        expect(Object.prototype.hasOwnProperty.call(replayed.pegDataById["usdc-circle"]!, "priceObservedAt")).toBe(false);
      }
    },
  );

  it("v10.01 captures actual failed attempts but not missing configuration or superseded failures", () => {
    const rejected = createReportCardEvidenceJournalV1({
      schemaVersion: 1, lane: "reserve", assetId: "usdc-circle", attemptId: "attempt:failed", sourceId: "fixture:reserves",
      sourceOriginClass: "onchain-observation", attemptCode: "reserve.collector.attempted",
      admissionCode: "reserve.admission.rejected-upstream", fallbackCode: "reserve.fallback.unavailable",
      attemptedAtSec: CLOCK_SEC - 20, completedAtSec: CLOCK_SEC - 10,
      sourceTimestampSec: null, sourceBlock: null, contentSha256: null, sidecarMaterializationSha256: null,
    });
    const { journalId: _journalId, ...payload } = rejected;
    const absentConfiguration = createReportCardEvidenceJournalV1({
      ...payload, attemptId: "attempt:no-config", attemptCode: "reserve.collector.not-configured",
      admissionCode: "reserve.admission.not-evaluated",
    });
    const accepted = createReportCardEvidenceJournalV1({
      ...payload, attemptId: "attempt:accepted", completedAtSec: CLOCK_SEC - 5,
      admissionCode: "reserve.admission.accepted", fallbackCode: "reserve.fallback.not-used",
      contentSha256: "a".repeat(64),
    });
    const failures = captureReservePipelineGaps({ "usdc-circle": [rejected] }, new Map(), CLOCK_SEC);
    expect(failures["usdc-circle"]![0]!.verdict.proof).toMatchObject({
      cause: "A", sourceGenerationId: rejected.attemptId, observedAtSec: rejected.completedAtSec,
    });
    expect(captureReservePipelineGaps({ "usdc-circle": [absentConfiguration] }, new Map(), CLOCK_SEC)).toEqual({});
    expect(captureReservePipelineGaps({ "usdc-circle": [rejected, accepted] }, new Map(), CLOCK_SEC)).toEqual({});
    expect(captureReservePipelineGaps({ "usdc-circle": [rejected] }, new Map([["usdc-circle", []]]), CLOCK_SEC)).toEqual({});
  });
  it("v10.01 binds producer proof bytes into native identity and rejects forged capture clocks", () => {
    const failure = createRuntimeGapVerdict({
      assetId: "usdc-circle", scope: { pillar: "backing", componentKey: "reserve-composition",
        factorKey: null, routeKey: null, exposureId: null, requiredDatum: "reserve-composition" },
      sourceId: "fixture-reserve-reader", sourceGenerationId: "attempt:1", producerState: "producer-failed",
      observedAtSec: CLOCK_SEC, asOfSec: CLOCK_SEC, rejectionCode: "reader-failed", reason: "The reader failed.",
    });
    const baseline = nativeInput();
    expect(baseline.pipelineGapByAssetId).toBeUndefined();
    const captured = nativeInput({ pipelineGapByAssetId: { "usdc-circle": [failure] } });
    expect(captured.baseInputGenerationId).not.toBe(baseline.baseInputGenerationId);
    const changed = structuredClone(captured);
    changed.pipelineGapByAssetId!["usdc-circle"]![0]!.evidence.rejection!.reason = "Different captured failure.";
    expect(() => normalizeNativeV9Input(changed)).toThrow(/does not match payload/);
    const wrongClock = structuredClone(failure);
    wrongClock.evidence.freshness.ageSec++;
    expect(() => nativeInput({ pipelineGapByAssetId: { "usdc-circle": [wrongClock] } })).toThrow(/freshness clock/);
  });
  it("rejects independently mismatched writer identities", async () => {
    const input = nativeInput();
    const identity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: input.methodologyVersion,
      baseInputGenerationId: input.baseInputGenerationId,
      publicationGenerationId: input.sourceGeneration,
    });
    for (const change of [
      { methodologyVersion: "9.0" },
      { baseInputGenerationId: `report-cards-input:v1:${"f".repeat(64)}` },
      { publicationGenerationId: "another-publication" },
    ]) {
      const mismatched = buildSafetyScoreV9InputIdentity({ ...identity, ...change });
      await expect(buildNativeV9InputCacheEntry(input, mismatched)).rejects.toThrow(/does not match its capture identity/);
    }
  });

  it("rejects reader envelope generation and identity disagreement", async () => {
    const input = nativeInput();
    const identity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: input.methodologyVersion,
      baseInputGenerationId: input.baseInputGenerationId,
      publicationGenerationId: input.sourceGeneration,
    });
    const envelope = JSON.parse((await buildNativeV9InputCacheEntry(input, identity)).value);
    await expect(parseNativeV9InputCacheArtifact(JSON.stringify({
      ...envelope, sourceGeneration: "another-publication",
    }))).rejects.toThrow(/generation mismatch/);
    await expect(parseNativeV9InputCacheArtifact(JSON.stringify({
      ...envelope,
      safetyScoreIdentity: buildSafetyScoreV9InputIdentity({ ...identity, baseInputGenerationId: `report-cards-input:v1:${"f".repeat(64)}` }),
    }))).rejects.toThrow(/identity mismatch/);
  });

  it("stores only the base capture when nonempty provenance enrichment is supplied", async () => {
    const input = nativeInput({
      pegDataById: {
        "usdc-circle": {
          ...pegSummary([], CLOCK_SEC, CLOCK_SEC - 86_400, "6.098"),
          id: "usdc-circle", symbol: "USDC", name: "USD Coin",
        },
      },
    });
    const identity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: input.methodologyVersion,
      baseInputGenerationId: input.baseInputGenerationId,
      publicationGenerationId: input.sourceGeneration,
    });
    const enriched = {
      ...input,
      pegProvenanceById: {
        "usdc-circle": buildSafetyScoreV9PegProvenanceSummary({
          assetId: "usdc-circle", events: [], trackingStartSec: CLOCK_SEC - 86_400,
          clockSec: CLOCK_SEC,
          expectedLegacyInclusive: projectSafetyScoreV9PegScoreResult(computePegScore([], CLOCK_SEC - 86_400, CLOCK_SEC)),
        }),
      },
    };
    const stored = await buildNativeV9InputCacheEntry(enriched, identity);
    expect(stored.value).toBe((await buildNativeV9InputCacheEntry(input, identity)).value);
    await expect(parseNativeV9InputCacheValue(stored.value)).resolves.toEqual(input);
  });

  it("round-trips through the v2 envelope with a verified payload checksum", async () => {
    const input = nativeInput();
    const identity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: input.methodologyVersion,
      baseInputGenerationId: input.baseInputGenerationId,
      publicationGenerationId: input.sourceGeneration,
    });

    const entry = await buildNativeV9InputCacheEntry(input, identity);
    expect(entry.key).toBe(NATIVE_V9_INPUT_CACHE_KEY);
    const envelope = JSON.parse(entry.value) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.safetyScoreIdentity).toEqual(identity);

    const artifact = await parseNativeV9InputCacheArtifact(entry.value);
    expect(artifact.safetyScoreIdentity).toEqual(identity);
    expect(artifact.input).toEqual(input);
    expect(await parseNativeV9InputCacheValue(entry.value)).toEqual(input);
    expect(await parseSafetyScoreV9InputCacheValue(entry.value)).toEqual(input);

    // The stored checksum must actually gate the payload.
    const tampered = JSON.stringify({ ...envelope, payloadSha256: "f".repeat(64) });
    await expect(parseNativeV9InputCacheValue(tampered)).rejects.toThrow(/checksum mismatch/);

    const corruptLength = JSON.stringify({ ...envelope, uncompressedBytes: 1 });
    await expect(parseNativeV9InputCacheValue(corruptLength)).rejects.toThrow(
      "exceeds its declared uncompressed byte length",
    );
  });

  it("refuses a v1 envelope on the native parser", async () => {
    await expect(
      parseNativeV9InputCacheValue(
        JSON.stringify({
          schemaVersion: 1,
          kind: "report-cards-fixed-input-exact",
          encoding: "gzip-base64",
          sourceGeneration: SOURCE_GENERATION,
          payloadSha256: "a".repeat(64),
          uncompressedBytes: 1,
          payload: "x",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects every field the native capture drops", () => {
    for (const dropped of [
      { bluechipMap: {} },
      { resolvedBlacklistStatuses: { "usdc-circle": true } },
      { collateralDriftCoins: [] },
    ]) {
      expect(() => normalizeNativeV9Input(nativeDraft(dropped))).toThrow(/Malformed native V9 input/);
    }
  });

  it("requires the native chain circulating map", () => {
    const draft = nativeDraft();
    delete draft.chainCirculatingById;

    expect(() => normalizeNativeV9Input(draft)).toThrow(
      /Malformed native V9 input/,
    );
  });

  it("rejects a chain circulating bucket field outside `current`", () => {
    expect(() =>
      normalizeNativeV9Input(
        nativeDraft({
          chainCirculatingById: {
            "usdc-circle": { ethereum: { current: 1_000, circulatingPrevDay: 900 } },
          },
        }),
      ),
    ).toThrow(/Malformed native V9 input/);
  });

  it("rejects a v3 DEX row field outside the native exit-route projection", () => {
    expect(() =>
      normalizeNativeV9Input(
        nativeDraft({
          dexLiqMap: {
            "usdc-circle": { updatedAt: DEX_UPDATED_AT, liquidityScore: 80 },
            "usdt-tether": { updatedAt: DEX_UPDATED_AT },
          },
        }),
      ),
    ).toThrow(/Malformed native V9 input/);
  });

  it("inherits the canonical DEX observation-coverage count guard", () => {
    const dexLiqMap = {
      "usdc-circle": {
        updatedAt: DEX_UPDATED_AT,
        exitRouteObservations: [],
        exitRouteObservationCoverage: {
          status: "populated" as const,
          capabilityMatrixVersion: "fixture-v1",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 0,
          unsupportedPoolCount: 0,
          evidenceCounts: {},
          unsupportedReasons: {},
        },
      },
      "usdt-tether": { updatedAt: DEX_UPDATED_AT },
    };
    expect(() =>
      normalizeNativeV9Input(
        nativeDraft({
          dexLiqMap,
          dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
            dexLiqMap,
            `dex-liquidity-${DEX_UPDATED_AT}`,
          ),
        }),
      ),
    ).toThrow(/coverage observation count does not match DEX observations/);
  });

  it("derives one generation id per payload regardless of field order", () => {
    const input = nativeInput();
    expect(input.baseInputGenerationId).toMatch(/^report-cards-input:v1:[a-f0-9]{64}$/);

    const permuted = Object.fromEntries(
      Object.entries(input as unknown as Record<string, unknown>).reverse(),
    ) as unknown as NativeSafetyScoreV9Input;
    expect(deriveNativeV9BaseInputGenerationId(permuted)).toBe(input.baseInputGenerationId);

    const reorderedMaps = {
      ...input,
      chainCirculatingById: { ...input.chainCirculatingById, "usdt-tether": {} },
    };
    expect(deriveNativeV9BaseInputGenerationId(reorderedMaps)).not.toBe(input.baseInputGenerationId);
  });

  it("ignores V9 enrichment fields so an enriched capture keeps its base identity", () => {
    const input = nativeInput();
    expect(
      deriveNativeV9BaseInputGenerationId({
        ...input,
        evidenceJournalById: { "usdc-circle": [] },
        pegProvenanceById: {},
      }),
    ).toBe(input.baseInputGenerationId);
  });

  it("changes the generation id when a consumed value changes", () => {
    const input = nativeInput();
    const moved = nativeInput({
      chainCirculatingById: { "usdc-circle": { ethereum: { current: 1_001 } } },
    });
    expect(moved.baseInputGenerationId).not.toBe(input.baseInputGenerationId);
  });

  it("keeps the schema strict about its own version and capture kind", () => {
    expect(NativeSafetyScoreV9InputSchema.safeParse(nativeDraft({ schemaVersion: 3 })).success).toBe(false);
    expect(
      NativeSafetyScoreV9InputSchema.safeParse(nativeDraft({ captureKind: "exact-publication-inputs" })).success,
    ).toBe(false);
  });

  it("still parses a retained v3 capture through the legacy parser", async () => {
    const legacy = createReportCardsFixedInput({
      captureKind: "exact-publication-inputs",
      capturedAt: new Date(CLOCK_SEC * 1_000).toISOString(),
      sourceGeneration: SOURCE_GENERATION,
      dexGenerationId: `dex-liquidity-${DEX_UPDATED_AT}`,
      redemptionGenerationId: "redemption-backstops-unavailable",
      registryRevision: `sha256:${"c".repeat(64)}`,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      clockSec: CLOCK_SEC,
      updatedAt: CLOCK_SEC,
      liquidityStale: false,
      redemptionStale: true,
      inputFreshness: {
        dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: CLOCK_SEC - DEX_UPDATED_AT, stale: false },
        redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
      },
      pegDataById: {},
      activeDepegPeakBpsById: {},
      dexLiqMap: Object.fromEntries(
        ACTIVE_IDS.map((id) => [
          id,
          {
            liquidityScore: null,
            concentrationHhi: null,
            poolCount: 0,
            chainCount: 0,
            methodologyVersion: "1.0",
            updatedAt: DEX_UPDATED_AT,
          },
        ]),
      ),
      redemptionBackstopMap: {},
      bluechipMap: {},
      resolvedBlacklistStatuses: Object.fromEntries(ACTIVE_IDS.map((id) => [id, false])),
      liveReserveMap: {},
      liveReserveProvenanceMap: {},
      chainCirculatingById: {},
      liveToFallbackCoins: [],
      dexDeploymentSupplyCoverageById: {},
      collateralDriftCoins: [],
    });
    const entry = await buildReportCardsFixedInputCacheEntry(legacy);

    const parsed = await parseReportCardsFixedInputCacheValue(entry.value);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.baseInputGenerationId).toMatch(/^report-cards-input:v1:[a-f0-9]{64}$/);
    await expect(parseSafetyScoreV9InputCacheValue(entry.value)).resolves.toEqual(legacy);
  });
  describe("fail-closed consistency guards", () => {
    // The native capture is the deterministic-replay contract's payload: every
    // guard below is the only thing standing between a mis-assembled capture
    // and a published score derived from it. They were the module's largest
    // untested surface after the Wave-1 cutover.

    it("rejects duplicate active asset identities", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ activeAssetIds: ["usdc-circle", "usdc-circle", "usdt-tether"] })),
      ).toThrow(/active asset identities contain duplicates/);
    });

    it("rejects a NAV price row on a non-NAV asset", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            navPriceById: {
              "usdc-circle": {
                priceUsd: 1,
                sourceId: "test",
                observedAtSec: CLOCK_SEC,
                confidence: "high",
              },
            },
          }),
        ),
      ).toThrow(/NAV price rows target non-NAV assets/);
    });

    it("rejects a DEX row set that does not cover exactly the active assets", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            dexLiqMap: { "usdc-circle": { updatedAt: DEX_UPDATED_AT } },
            dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
              { "usdc-circle": { updatedAt: DEX_UPDATED_AT } },
              `dex-liquidity-${DEX_UPDATED_AT}`,
            ),
          }),
        ),
      ).toThrow(/DEX active rows mismatch/);
    });

    it("rejects a DEX payload fingerprint that does not match the payload", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ dexPayloadFingerprint: "a".repeat(64) })),
      ).toThrow(/DEX payload fingerprint .* does not match payload/);
    });

    it("rejects a redemption payload fingerprint that does not match the payload", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ redemptionPayloadFingerprint: "a".repeat(64) })),
      ).toThrow(/redemption payload fingerprint .* does not match payload/);
    });

    it("rejects an evidence journal record newer than the scoring clock", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            evidenceJournalById: {
              "usdc-circle": [
                {
                  assetId: "usdc-circle",
                  taskKey: "reserve-review",
                  completedAtSec: CLOCK_SEC + 60,
                  evidenceRefIds: [],
                },
              ],
            },
          }),
        ),
      ).toThrow(/Malformed native V9 input|later than the scoring clock/);
    });

    it("rejects an evidence journal keyed to an inactive asset", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ evidenceJournalById: { "not-tracked": [] } })),
      ).toThrow(/Evidence journal targets inactive asset/);
    });

    it("rejects a supply-attribution journal keyed to an inactive asset", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ supplyAttributionJournalById: { "not-tracked": [] } })),
      ).toThrow(/Supply attribution journal targets inactive asset/);
    });

    it("rejects a base generation id that does not match the payload", () => {
      const draft = nativeDraft();
      expect(() =>
        normalizeNativeV9Input({ ...draft, baseInputGenerationId: "report-cards-input:v1:" + "0".repeat(64) }),
      ).toThrow(/Malformed native V9 input|does not match payload/);
    });

    it("rejects DEX rows whose timestamps disagree with the DEX freshness generation", () => {
      const dexLiqMap = {
        "usdc-circle": { updatedAt: DEX_UPDATED_AT },
        "usdt-tether": { updatedAt: DEX_UPDATED_AT - 10 },
      };
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            dexLiqMap,
            dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
              dexLiqMap,
              `dex-liquidity-${DEX_UPDATED_AT}`,
            ),
          }),
        ),
      ).toThrow(/DEX rows do not match the DEX freshness generation/);
    });

    it("rejects a DEX generation id that does not match the active-row generation", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            dexGenerationId: `dex-liquidity-${DEX_UPDATED_AT - 1}`,
            dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
              { "usdc-circle": { updatedAt: DEX_UPDATED_AT }, "usdt-tether": { updatedAt: DEX_UPDATED_AT } },
              `dex-liquidity-${DEX_UPDATED_AT - 1}`,
            ),
          }),
        ),
      ).toThrow(/DEX generation .* does not match active-row generation/);
    });

    it("rejects an empty redemption map that claims current freshness", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            redemptionStale: false,
            inputFreshness: {
              dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: CLOCK_SEC - DEX_UPDATED_AT, stale: false },
              redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: false },
            },
          }),
        ),
      ).toThrow(/no redemption rows but marks redemption freshness as current/);
    });

    it("rejects a redemption generation id that is not producer-bound", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            redemptionGenerationId: "whatever",
            redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint({}, "whatever"),
          }),
        ),
      ).toThrow(/redemption generation .* is not producer-bound/);
    });

    it("rejects top-level freshness flags that disagree with their lanes", () => {
      expect(() => normalizeNativeV9Input(nativeDraft({ liquidityStale: true }))).toThrow(
        /top-level freshness flags do not match lane freshness/,
      );
    });

    it("accepts the producer at the scoring clock and rejects negative schema ages", () => {
      const dexLiqMap = { "usdc-circle": { updatedAt: CLOCK_SEC }, "usdt-tether": { updatedAt: CLOCK_SEC } };
      const draft = nativeDraft({
        dexLiqMap,
        dexGenerationId: `dex-liquidity-${CLOCK_SEC}`,
        dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, `dex-liquidity-${CLOCK_SEC}`),
        inputFreshness: {
          dexLiquidity: { updatedAt: CLOCK_SEC, ageSeconds: 0, stale: false },
          redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
        },
      });
      expect(normalizeNativeV9Input(draft).inputFreshness.dexLiquidity.ageSeconds).toBe(0);
      expect(() => normalizeNativeV9Input(nativeDraft({
        inputFreshness: {
          dexLiquidity: { updatedAt: CLOCK_SEC + 1, ageSeconds: -1, stale: false },
          redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
        },
      }))).toThrow(/Malformed native V9 input at inputFreshness.dexLiquidity.ageSeconds/);
    });

    it("rejects a producer timestamp later than the scoring clock", () => {
      const updatedAt = CLOCK_SEC + 60;
      const dexLiqMap = {
        "usdc-circle": { updatedAt },
        "usdt-tether": { updatedAt },
      };
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            dexLiqMap,
            dexGenerationId: `dex-liquidity-${updatedAt}`,
            dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
              dexLiqMap,
              `dex-liquidity-${updatedAt}`,
            ),
            inputFreshness: {
              dexLiquidity: { updatedAt, ageSeconds: 0, stale: false },
              redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
            },
          }),
        ),
      ).toThrow(/later than scoring clock/);
    });

    it("rejects a lane age that does not match the clock-derived age", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            inputFreshness: {
              dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: 1, stale: false },
              redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
            },
          }),
        ),
      ).toThrow(/does not match clock-derived age/);
    });

    it("rejects supply attribution that targets an inactive asset", () => {
      const attribution = {
        model: "canonical-lock-mint-partition-v1",
        observedAtSec: CLOCK_SEC,
        currentSupplyUsdByChain: { ethereum: 1, arbitrum: 1 },
      };
      expect(normalizeNativeV9Input(nativeDraft({
        safetyScoreV9SupplyAttributionById: { "usdc-circle": attribution },
        aggregateCirculatingById: { "usdc-circle": { circulating: { peggedUSD: 2 }, observedAtSec: CLOCK_SEC } },
      })).safetyScoreV9SupplyAttributionById["usdc-circle"]).toEqual(attribution);
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            safetyScoreV9SupplyAttributionById: {
              "not-tracked": {
                model: "canonical-lock-mint-partition-v1",
                observedAtSec: CLOCK_SEC,
                currentSupplyUsdByChain: { ethereum: 1, arbitrum: 1 },
              },
            },
          }),
        ),
      ).toThrow(/targets inactive asset/);
    });
  });
});
