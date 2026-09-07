import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { SafetyScoreV9CompilerInput } from "./native-input";

interface SafetyScoreV9ExtensionAssetSet {
  readonly assets: readonly Readonly<{ assetId: string }>[];
}

export function assertSafetyScoreV9ExactExtensionAssets(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  extension: Readonly<SafetyScoreV9ExtensionAssetSet>,
): void {
  const expected = fixedInput.activeAssetIds;
  const actual = extension.assets.map((asset) => asset.assetId);
  if (stableJsonStringifyV1(actual) === stableJsonStringifyV1(expected)) return;
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  throw new Error(
    `Safety Score v9 extension active set mismatch: missing=${expected.filter((id) => !actualSet.has(id)).join(",") || "none"}; ` +
      `unexpected=${actual.filter((id) => !expectedSet.has(id)).join(",") || "none"}`,
  );
}
