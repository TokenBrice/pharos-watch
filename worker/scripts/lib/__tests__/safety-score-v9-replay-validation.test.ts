import { beforeAll, describe, expect, it } from "vitest";
import type { SafetyScoreV9ReplayArtifact } from "../../replay-safety-score-v9";
type Mutable<T> = { -readonly [Key in keyof T]: Mutable<T[Key]> };
import { execFileSync } from "node:child_process";
import { buildSafetyScoreV9ReplayArtifact } from "../../replay-safety-score-v9";
import {
  FULL_REGISTRY_CLOCK_SEC,
  createNativeSafetyScoreV9CohortInput,
} from "../../../src/lib/__tests__/fixtures/safety-score-v9-full-registry-input";
import { createReplayFixedInput } from "../../__tests__/safety-score-v9-replay.test-support";
import { v9TestClockSec } from "../../../src/test-helpers/v9-fixed-input";
import { localRegistrySnapshot } from "../safety-score-v9-registry";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { computeV9ResultDigest } from "@shared/lib/safety-score-v9/trace";
import { validateSafetyScoreV9ReplayIntegrity, reproduceSafetyScoreV9Replay } from "../safety-score-v9-replay-validation";
import {
  SafetyScoreV9CompilerFactSchemaIdentityV1Schema,
  SafetyScoreV9ProducerCapabilityIdentityV1Schema,
  hashSafetyScoreV9CompilerFactSchemaIdentity,
  hashSafetyScoreV9ProducerCapabilityIdentity,
  computeSafetyScoreV9CandidateId,
  computeSafetyScoreV9PublicationGenerationId,
} from "../../../src/lib/safety-score-v9/candidate-identity";
import { buildSafetyScoreV9ReplayLaneScreening } from "../../../src/lib/safety-score-v9/publication-replay-capture";
import { loadReviewedLaneEmitterCatalog } from "../../../src/lib/safety-score-v9/lane-emitter-catalog";

// One artifact build is shared: every case mutates only its own clone.
let baseArtifact: SafetyScoreV9ReplayArtifact;
beforeAll(() => {
  const fixedInput = createReplayFixedInput(v9TestClockSec());
  baseArtifact = buildSafetyScoreV9ReplayArtifact({ fixedInput, publishedAtSec: fixedInput.clockSec });
});
function fixture() {
  return structuredClone(baseArtifact) as Mutable<SafetyScoreV9ReplayArtifact>;
}

// The local registry is immutable for the run and fingerprinting it scans the
// whole catalog, so reproduction cases reuse one verified snapshot.
let cachedLocalSnapshot: ReturnType<typeof localRegistrySnapshot> | undefined;
function localSnapshot() {
  cachedLocalSnapshot ??= localRegistrySnapshot();
  return cachedLocalSnapshot;
}

describe("permanent replay integrity", () => {
  // The native v4 contract is a shape contract — no legacy-only maps survive in
  // the artifact and the digest validates — so a documented cohort proves it.
  // Building all ~386 assets cost 15s of this file (20s in CI).
  it("validates the native v4 digest contract without legacy-only maps", () => {
    const fixedInput = createNativeSafetyScoreV9CohortInput(["usdc-circle", "wm-m0"], FULL_REGISTRY_CLOCK_SEC);
    const artifact = buildSafetyScoreV9ReplayArtifact({ fixedInput, publishedAtSec: fixedInput.clockSec });
    expect(Object.prototype.hasOwnProperty.call(artifact.pipeline.fixedInput, "bluechipMap")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(artifact.pipeline.fixedInput, "resolvedBlacklistStatuses")).toBe(false);
    expect(() => validateSafetyScoreV9ReplayIntegrity(artifact)).not.toThrow();
  }, 120_000);

  it.each(["bluechipMap", "resolvedBlacklistStatuses"])("rejects a legacy capture missing %s", field => {
    const artifact = fixture();
    Reflect.deleteProperty(artifact.pipeline.fixedInput, field);
    expect(() => validateSafetyScoreV9ReplayIntegrity(artifact)).toThrow();
  });

  it("checks canonical digests without compiling or pinning a checkout build", () => {
    const artifact = fixture();
    expect(() => validateSafetyScoreV9ReplayIntegrity(artifact)).not.toThrow();
    const p = artifact.pipeline;
    const otherBuild = "b".repeat(64);
    p.candidateIdentity.evaluationBuildDigest = otherBuild;
    p.compilerFactSchemaIdentity.evaluationBuildDigest = otherBuild;
    p.compilerFactSchemaDigest = domainDigest("safety-score-v9.compiler-fact-schema.v1", p.compilerFactSchemaIdentity);
    p.candidateIdentity.compilerFactSchemaDigest = p.compilerFactSchemaDigest;
    p.evaluatedSet.evaluationBuildDigest = otherBuild;
    for (const asset of p.evaluatedSet.assets) asset.trace.evaluationBuildDigest = otherBuild;
    p.evaluatedSet.scoreResultDigest = computeV9ResultDigest(p.evaluatedSet.assets.map(asset => asset.trace));
    p.candidate.resultDigest = p.evaluatedSet.scoreResultDigest;
    p.candidate.candidateId = `safety-score-v9:v1:${domainDigest("safety-score-v9.publication-id.v1", p.candidateIdentity)}`;
    p.candidate.publicationGenerationId = `report-cards:v9:v1:${domainDigest("safety-score-v9.publication.v1", {
      candidateId: p.candidate.candidateId, baseInputGenerationId: p.fixedInput.baseInputGenerationId,
      factSetDigest: p.compiledFacts.v9FactSetDigest, evaluatedSetDigest: p.evaluatedSet.evaluatedSetDigest,
      resultDigest: p.evaluatedSet.scoreResultDigest, publishedAtSec: p.candidate.publishedAtSec,
    })}`;
    expect(() => validateSafetyScoreV9ReplayIntegrity(artifact)).not.toThrow();
    const historical = structuredClone(p);
    historical.compilerFactSchemaIdentity.compilerAdapter = "historical-adapter" as typeof historical.compilerFactSchemaIdentity.compilerAdapter;
    historical.compilerFactSchemaIdentity.compiledFactSchemaCapabilities = ["historical-capability"] as unknown as typeof historical.compilerFactSchemaIdentity.compiledFactSchemaCapabilities;
    historical.producerCapabilityIdentity.sourceAdapters = { historical: "adapter.v1" } as unknown as typeof historical.producerCapabilityIdentity.sourceAdapters;
    expect(SafetyScoreV9CompilerFactSchemaIdentityV1Schema.safeParse(historical.compilerFactSchemaIdentity).success).toBe(false);
    expect(SafetyScoreV9ProducerCapabilityIdentityV1Schema.safeParse(historical.producerCapabilityIdentity).success).toBe(false);
    historical.compilerFactSchemaDigest = hashSafetyScoreV9CompilerFactSchemaIdentity(historical.compilerFactSchemaIdentity);
    historical.candidateIdentity.compilerFactSchemaDigest = historical.compilerFactSchemaDigest;
    historical.producerCapabilityDigest = hashSafetyScoreV9ProducerCapabilityIdentity(historical.producerCapabilityIdentity);
    historical.candidateIdentity.producerCapabilityDigest = historical.producerCapabilityDigest;
    historical.candidate.candidateId = computeSafetyScoreV9CandidateId(historical.candidateIdentity);
    historical.candidate.publicationGenerationId = computeSafetyScoreV9PublicationGenerationId({
      candidateId: historical.candidate.candidateId, baseInputGenerationId: historical.fixedInput.baseInputGenerationId,
      factSetDigest: historical.compiledFacts.v9FactSetDigest, evaluatedSetDigest: historical.evaluatedSet.evaluatedSetDigest,
      resultDigest: historical.evaluatedSet.scoreResultDigest, publishedAtSec: historical.candidate.publishedAtSec,
    });
    expect(() => validateSafetyScoreV9ReplayIntegrity({ ...artifact, pipeline: historical })).not.toThrow();
  });

  it.each(["duplicate", "asset-set", "base", "fact", "result", "card", "build"])("rejects %s tampering", kind => {
    const artifact = fixture();
    const p = artifact.pipeline;
    if (kind === "duplicate") p.candidate.cards = [...p.candidate.cards, p.candidate.cards[0]!];
    if (kind === "asset-set") p.compiledFacts.activeAssetIds = [];
    if (kind === "base") p.fixedInput.baseInputGenerationId = `report-cards-input:v1:${"a".repeat(64)}`;
    if (kind === "fact") p.compiledFacts.v9FactSetDigest = "a".repeat(64);
    if (kind === "result") p.evaluatedSet.scoreResultDigest = "a".repeat(64);
    if (kind === "card") p.candidate.cards[0]!.score = 99;
    if (kind === "build") p.candidateIdentity.evaluationBuildDigest = "a".repeat(64);
    expect(() => validateSafetyScoreV9ReplayIntegrity(artifact)).toThrow();
  });

  // Reproduction recompiles the registry too, so both reproduction tests share
  // that budget; under V8 coverage they exceed the 20 s default.
  it("retains, validates and reproduces the exact lane-screening provenance", () => {
    const fixedInput = createReplayFixedInput(v9TestClockSec());
    const laneScreening = buildSafetyScoreV9ReplayLaneScreening({
      certificates: new Map(), descriptors: loadReviewedLaneEmitterCatalog().descriptors,
    });
    const artifact = buildSafetyScoreV9ReplayArtifact({ fixedInput, laneScreening, publishedAtSec: fixedInput.clockSec });
    expect(artifact.laneScreening).toEqual(laneScreening);
    const p = artifact.pipeline;
    expect(() => reproduceSafetyScoreV9Replay(artifact, {
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      policyId: p.candidateIdentity.policyId, policyDigest: p.candidateIdentity.policyDigest,
      evaluationBuildDigest: p.candidateIdentity.evaluationBuildDigest, registrySnapshot: localSnapshot(),
      publishedAtSec: p.candidate.publishedAtSec, transferMaterialityGeneration: null,
    })).not.toThrow();
    expect(() => validateSafetyScoreV9ReplayIntegrity({
      ...artifact, laneScreening: { ...laneScreening, digest: "0".repeat(64) },
    })).toThrow("Replay lane screening digest mismatch");
  }, 120_000);

  it("requires intended source, registry, clock and explicit enrichment for reproduction", () => {
    const artifact = fixture();
    const p = artifact.pipeline;
    const context = {
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      policyId: p.candidateIdentity.policyId,
      policyDigest: p.candidateIdentity.policyDigest,
      evaluationBuildDigest: p.candidateIdentity.evaluationBuildDigest,
      registrySnapshot: localSnapshot(),
      publishedAtSec: p.candidate.publishedAtSec,
      transferMaterialityGeneration: null,
    };
    expect(() => reproduceSafetyScoreV9Replay(artifact, context)).not.toThrow();
    expect(() => reproduceSafetyScoreV9Replay(artifact, { ...context, sourceRevision: "a".repeat(40) })).toThrow("source revision");
    expect(() => reproduceSafetyScoreV9Replay(artifact, { ...context, policyDigest: "a".repeat(64) })).toThrow("intended policy/build/clock");
    expect(() => reproduceSafetyScoreV9Replay(artifact, { ...context, transferMaterialityGeneration: undefined } as unknown as typeof context)).toThrow();
    expect(() => reproduceSafetyScoreV9Replay(artifact, { ...context, publishedAtSec: context.publishedAtSec + 1 })).toThrow("intended policy/build/clock");
  }, 120_000);

});
