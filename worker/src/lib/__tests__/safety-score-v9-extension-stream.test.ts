import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { createV9PublicationAssetCompactor, createV9PublicationResearchHashRebinder, safeParseV9AssetFactsV3 } from "@shared/lib/safety-score-v9/compile";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import { makeV9FixedInput, makeV9ThreeAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import { createSafetyScoreV9BaselineExtensionSource, type V9ExtensionRegistryMeta } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromExtensionSource, compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension, materializeSafetyScoreV9FactSetExtension } from "../safety-score-v9/fact-set";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";

function fixture() {
  const fixedInput = normalizeSafetyScoreV9CompilerInput(makeV9ThreeAssetFixedInput());
  const metaById = new Map<string, V9ExtensionRegistryMeta>(fixedInput.activeAssetIds.map((id) => [id, {
    id, mechanismArchetype: "fiat-cash", launchDate: "1970-01-01",
    dependencies: id === "alpha" ? [{ id: "beta", type: "wrapper", weight: 1 }]
      : id === "beta" ? [{ id: "alpha", type: "wrapper", weight: 1 }] : [],
  }]));
  return { fixedInput, source: createSafetyScoreV9BaselineExtensionSource(fixedInput, { metaById }) };
}

describe("per-asset extension compilation", () => {
  it.each([false, true])("preserves full facts, digests, graph and quarantine on retry=%s", (retry) => {
    const { fixedInput, source } = fixture();
    const failures = retry ? new Map([["gamma", "fixture evaluation failure"]]) : undefined;
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: [...source.assets()] });
    const full = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension, failures);
    let traversals = 0;
    const streamed = compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, {
      ...source, *assets() { traversals++; yield* source.assets(); },
    }, failures);
    expect(traversals).toBe(1);
    expect(stableJsonStringifyV1(streamed.factSet)).toBe(stableJsonStringifyV1(full.factSet));
    const finalizedHash = streamed.factSet.sourceFingerprints.researchOverlays!.payloadSha256;
    for (const asset of streamed.factSet.assets) {
      for (const reference of asset.evidence) {
        expect(reference.contentSha256).not.toBe("0".repeat(64));
        if (reference.sourceId === "safety-score-v9-research-overlay" || reference.sourceId === "safety-score-v9-compiler") {
          expect(reference.contentSha256).toBe(finalizedHash);
        }
      }
    }
    expect(streamed.quarantines).toEqual(full.quarantines);
    expect(streamed.bridgeJoinDiagnostics).toEqual(extension.assets.flatMap((asset) => {
      const diagnostics = asset.economicControlReview?.bridge.diagnostics;
      return diagnostics === undefined ? [] : [{ assetId: asset.assetId, ...diagnostics }];
    }));
    expect(source.extension.assets).toEqual([]);
    expect([...source.assets()]).toEqual(extension.assets);
  });

  it("preserves the independent shock-coverage digest and original observation time", () => {
    const fixedInput = normalizeSafetyScoreV9CompilerInput(makeV9FixedInput({ assetId: "lusd-liquity", clockSec: 1_784_225_942 }));
    const source = createSafetyScoreV9BaselineExtensionSource(fixedInput);
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: [...source.assets()] });
    const full = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension);
    const streamed = compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, source);
    expect(full.factSet.sourceFingerprints.shockCoverage).toBeDefined();
    expect(stableJsonStringifyV1(streamed.factSet)).toBe(stableJsonStringifyV1(full.factSet));
  });

  it("quarantines malformed asset-local input without changing healthy siblings", () => {
    const { fixedInput, source } = fixture();
    const rows = [...source.assets()];
    rows[0] = { ...rows[0]!, launchedAtSec: -1 };
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: rows });
    const full = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension);
    const streamed = compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, { ...source, *assets() { yield* rows; } });
    expect(streamed.quarantines).toEqual(full.quarantines);
    expect(streamed.quarantines).toEqual([expect.objectContaining({ assetId: "alpha", code: "fact-validation-failed" })]);
    expect(stableJsonStringifyV1(streamed.factSet)).toBe(stableJsonStringifyV1(full.factSet));
  });

  it("rejects empty, missing, duplicate or out-of-order cohorts and invalid envelopes", () => {
    const { fixedInput, source } = fixture();
    const rows = [...source.assets()];
    for (const assets of [[], rows.slice(1), [rows[0]!, rows[0]!, rows[2]!], [...rows].reverse()]) {
      expect(() => compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, { ...source, *assets() { yield* assets; } })).toThrow();
    }
    expect(() => compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, {
      ...source, extension: { ...source.extension, compiledAtSec: -1 },
    })).toThrow();
    expect(() => compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, {
      ...source, extension: { ...source.extension, registryFingerprint: "a".repeat(64) },
    })).toThrow(/registry fingerprint/);
  });

  it("rebinds only admitted research evidence while preserving compact getters and other sources", () => {
    const { fixedInput, source } = fixture();
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: [...source.assets()] });
    const { factSet } = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension);
    const previousHash = factSet.sourceFingerprints.researchOverlays!.payloadSha256;
    const finalHash = "f".repeat(64);
    const input = JSON.parse(stableJsonStringifyV1(factSet.assets[0])) as V9AssetFactsV3;
    const research = input.evidence.find((reference) => reference.sourceId === "safety-score-v9-research-overlay")!;
    expect(research).toBeDefined();
    input.evidence.push({ ...research, evidenceId: "alpha:unrelated-source", sourceId: "another-source" });
    input.evidence.push({ ...research, evidenceId: "alpha:unrelated-research-evidence" });
    input.evidence.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    const parsed = safeParseV9AssetFactsV3(input);
    if (!parsed.success) throw parsed.error;
    const compact = createV9PublicationAssetCompactor();
    const admitted = compact(parsed.data);
    const before = stableJsonStringifyV1(admitted);
    const rebind = createV9PublicationResearchHashRebinder(previousHash, finalHash);
    const finalized = rebind(admitted);
    expect(Object.getOwnPropertyDescriptor(finalized, "gaps")!.get).toBe(Object.getOwnPropertyDescriptor(admitted, "gaps")!.get);
    expect(finalized.evidence.find((reference) => reference.evidenceId === research.evidenceId)!.contentSha256).toBe(finalHash);
    expect(finalized.evidence.find((reference) => reference.evidenceId === "alpha:unrelated-source")!.contentSha256).toBe(previousHash);
    expect(finalized.evidence.find((reference) => reference.evidenceId === "alpha:unrelated-research-evidence")!.contentSha256).toBe(previousHash);
    expect(Object.isFrozen(finalized)).toBe(true);
    expect(Object.isFrozen(finalized.evidence)).toBe(true);
    expect(safeParseV9AssetFactsV3(finalized).success).toBe(true);
    expect(stableJsonStringifyV1(admitted)).toBe(before);
    expect(() => rebind(input)).toThrow(/admitted immutable asset/);
    expect(() => createV9PublicationResearchHashRebinder(previousHash, "invalid")).toThrow();
    expect(() => createV9PublicationResearchHashRebinder(previousHash, "0".repeat(64))(admitted).evidence).toThrow(/cannot retain a pending research hash/);
    expect(() => createV9PublicationResearchHashRebinder(finalHash, previousHash)(admitted).evidence).toThrow(/pending cohort/);
  });

  it.each([
    { sourceId: "another-source", evidenceId: "alpha:unrelated-source" },
    { sourceId: "safety-score-v9-research-overlay", evidenceId: "alpha:unrelated-research-evidence" },
  ])("rejects a pending hash on unmatched evidence $evidenceId without poisoning the cache", (unmatched) => {
    const { fixedInput, source } = fixture();
    const extension = materializeSafetyScoreV9FactSetExtension(fixedInput, { ...source.extension, assets: [...source.assets()] });
    const { factSet } = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(fixedInput, extension);
    const previousHash = factSet.sourceFingerprints.researchOverlays!.payloadSha256;
    const input = JSON.parse(stableJsonStringifyV1(factSet.assets[0])) as V9AssetFactsV3;
    const research = input.evidence.find((reference) => reference.sourceId === "safety-score-v9-research-overlay")!;
    input.evidence.push({ ...research, ...unmatched, contentSha256: "0".repeat(64) });
    const parsed = safeParseV9AssetFactsV3(input);
    if (!parsed.success) throw parsed.error;
    const compact = createV9PublicationAssetCompactor();
    const rebind = createV9PublicationResearchHashRebinder(previousHash, "f".repeat(64));
    const healthy = rebind(compact(factSet.assets[0]!));
    const healthyEvidence = healthy.evidence;
    const rejected = rebind(compact(parsed.data));
    expect(() => rejected.evidence).toThrow(/cannot retain a pending research hash/);
    expect(healthy.evidence).toBe(healthyEvidence);
    expect(() => rejected.evidence).toThrow(/cannot retain a pending research hash/);
  });
});
