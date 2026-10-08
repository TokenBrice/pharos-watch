import { describe, expect, it } from "vitest";
import { assertSafetyScoreV9ExactExtensionAssets } from "../safety-score-v9/fact-set-boundary";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";

const fixed = normalizeSafetyScoreV9CompilerInput(makeV9TwoAssetFixedInput());

function assetSet(ids: readonly string[]) {
  return { assets: ids.map((assetId) => ({ assetId })) };
}

describe("exact extension asset boundary", () => {
  it("admits exactly the captured ordered active set", () => {
    expect(() => assertSafetyScoreV9ExactExtensionAssets(fixed, assetSet(["alpha", "beta"]))).not.toThrow();
  });

  it.each([
    { ids: ["alpha"], missing: "beta", unexpected: "none" },
    { ids: ["alpha", "beta", "gamma"], missing: "none", unexpected: "gamma" },
    { ids: ["alpha", "gamma"], missing: "beta", unexpected: "gamma" },
    { ids: ["beta", "alpha"], missing: "none", unexpected: "none" },
    { ids: ["alpha", "beta", "beta"], missing: "none", unexpected: "none" },
  ])("rejects missing, unexpected, reordered or duplicate IDs: $ids", ({ ids, missing, unexpected }) => {
    expect(() => assertSafetyScoreV9ExactExtensionAssets(fixed, assetSet(ids)))
      .toThrow(`Safety Score v9 extension active set mismatch: missing=${missing}; unexpected=${unexpected}`);
  });
});
