import {
  CompiledV9FactSetV2Schema,
  V9FactSetCoreV2Schema,
  type CompiledV9FactSetV2,
  type V9FactSetCoreV2,
} from "../../types/safety-score-v9-facts";
import { computeV9FactSetDigest, parseCompiledV9FactSetV2 } from "./facts";

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Compile every exact active asset once into a canonical, policy-independent fact set. */
export function compileV9FactSetV2(input: unknown): Readonly<CompiledV9FactSetV2> {
  const core: V9FactSetCoreV2 = V9FactSetCoreV2Schema.parse(input);
  const compiled = CompiledV9FactSetV2Schema.parse({
    ...core,
    v9FactSetDigest: computeV9FactSetDigest(core),
  });
  return deepFreeze(parseCompiledV9FactSetV2(compiled));
}

export function assertExactV9ActiveAssetSet(
  factSet: Pick<CompiledV9FactSetV2, "activeAssetIds" | "assets">,
  expectedActiveAssetIds: readonly string[],
): void {
  const expected = [...new Set(expectedActiveAssetIds)].sort();
  const actualIds = factSet.assets.map((asset) => asset.assetId);
  if (
    JSON.stringify(factSet.activeAssetIds) !== JSON.stringify(expected) ||
    JSON.stringify(actualIds) !== JSON.stringify(expected)
  ) {
    throw new Error("Safety Score v9 fact set does not match the expected exact active asset set");
  }
}
