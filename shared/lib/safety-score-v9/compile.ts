import {
  V9FactSetCoreV2Schema,
  V9FactSetCoreV3Schema,
  type CompiledV9FactSetV2,
  type CompiledV9FactSetV3,
  type V9FactSetCoreV2,
  type V9FactSetCoreV3,
} from "../../types/safety-score-v9-facts";
import { computeValidatedV9FactSetDigest } from "./facts";
import { deepFreeze } from "./primitives";

const validatedCompiledFactSets = new WeakSet<object>();

function sealValidatedFactSet<T extends CompiledV9FactSetV2 | CompiledV9FactSetV3>(
  factSet: T,
): Readonly<T> {
  const sealed = deepFreeze(factSet);
  validatedCompiledFactSets.add(sealed);
  return sealed;
}

export function assertV9FactSetCompiledInProcess(
  factSet: CompiledV9FactSetV2 | CompiledV9FactSetV3,
): void {
  if (!validatedCompiledFactSets.has(factSet)) {
    throw new Error("Trusted Safety Score v9 evaluation requires an in-process compiled fact set");
  }
}

/** Compile every exact active asset once into a canonical, policy-independent fact set. */
export function compileV9FactSetV2(input: unknown): Readonly<CompiledV9FactSetV2> {
  const core: V9FactSetCoreV2 = V9FactSetCoreV2Schema.parse(input);
  const compiled: CompiledV9FactSetV2 = {
    ...core,
    v9FactSetDigest: computeValidatedV9FactSetDigest(core),
  };
  return sealValidatedFactSet(compiled);
}

/** Compile the responsibility-bearing V3 fact contract. */
export function compileV9FactSetV3(input: unknown): Readonly<CompiledV9FactSetV3> {
  const core: V9FactSetCoreV3 = V9FactSetCoreV3Schema.parse(input);
  const compiled: CompiledV9FactSetV3 = {
    ...core,
    v9FactSetDigest: computeValidatedV9FactSetDigest(core),
  };
  return sealValidatedFactSet(compiled);
}

export function assertExactV9ActiveAssetSet(
  factSet: Pick<CompiledV9FactSetV2 | CompiledV9FactSetV3, "activeAssetIds" | "assets">,
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
