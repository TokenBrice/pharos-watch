import { describe, expect, it } from "vitest";
import type { SafetyScoreV9ReplayArtifact } from "../../replay-safety-score-v9";
type Mutable<T> = { -readonly [Key in keyof T]: Mutable<T[Key]> };
import { execFileSync } from "node:child_process";
import { buildSafetyScoreV9ReplayArtifact } from "../../replay-safety-score-v9";
import { createNativeSafetyScoreV9FullRegistryInput } from "../../../src/lib/__tests__/fixtures/safety-score-v9-full-registry-input";
import { createReplayFixedInput } from "../../__tests__/safety-score-v9-replay.test-support";
import { v9TestClockSec } from "../../../src/test-helpers/v9-fixed-input";
import { localRegistrySnapshot } from "../safety-score-v9-registry";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { computeV9ResultDigest } from "@shared/lib/safety-score-v9/trace";
import { validateSafetyScoreV9ReplayIntegrity, reproduceSafetyScoreV9Replay } from "../safety-score-v9-replay-validation";
import { runSafetyScoreV9AnchorGateCli } from "../../check-safety-score-v9-anchor-gate";

function fixture() {
  const fixedInput = createReplayFixedInput(v9TestClockSec());
  return structuredClone(buildSafetyScoreV9ReplayArtifact({ fixedInput, publishedAtSec: fixedInput.clockSec })) as Mutable<SafetyScoreV9ReplayArtifact>;
}

describe("permanent replay integrity", () => {
  // This admission test first compiles/evaluates the entire registry, matching
  // the coverage budget of safety-score-v9-native-input-pipeline.test.ts.
  it("validates the native v4 digest contract without legacy-only maps", () => {
    const fixedInput = createNativeSafetyScoreV9FullRegistryInput();
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

  it("requires intended source, registry, clock and explicit enrichment for reproduction", () => {
    const artifact = fixture();
    const p = artifact.pipeline;
    const context = {
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      policyId: p.candidateIdentity.policyId,
      policyDigest: p.candidateIdentity.policyDigest,
      evaluationBuildDigest: p.candidateIdentity.evaluationBuildDigest,
      registrySnapshot: localRegistrySnapshot(),
      publishedAtSec: p.candidate.publishedAtSec,
      transferMaterialityGeneration: null,
    };
    expect(() => reproduceSafetyScoreV9Replay(artifact, context)).not.toThrow();
    expect(() => reproduceSafetyScoreV9Replay(artifact, { ...context, sourceRevision: "a".repeat(40) })).toThrow("source revision");
    expect(() => reproduceSafetyScoreV9Replay(artifact, { ...context, policyDigest: "a".repeat(64) })).toThrow("intended policy/build/clock");
    expect(() => reproduceSafetyScoreV9Replay(artifact, { ...context, transferMaterialityGeneration: undefined } as unknown as typeof context)).toThrow();
    expect(() => reproduceSafetyScoreV9Replay(artifact, { ...context, publishedAtSec: context.publishedAtSec + 1 })).toThrow("intended policy/build/clock");
  });

  it("rejects the retired anchor ruling option before reading a report", async () => {
    await expect(runSafetyScoreV9AnchorGateCli(["--replay", "unused", "--apply-ruling", "D-test"])).rejects.toThrow();
  });
});
