import { z } from "zod";
import {
  V9FactSetCoreV2Schema,
  V9AssetFactsV3Schema,
  createV9FactSetCoreV3Schema,
  type V9AssetFactsV3,
  type CompiledV9FactSetV2,
  type CompiledV9FactSetV3,
  type V9FactSetCoreV2,
  type V9FactSetCoreV3,
} from "../../types/safety-score-v9-facts";
import { isV9AdmittedControlExecutionScope } from "../../types/safety-score-v9-control-scope";
import { computeValidatedV9FactSetDigest } from "./facts";
import { createV9ValueInterner, deepFreeze, V9_EMPTY_ARRAY } from "../../types/safety-score-v9-immutable";
import { findV9CauseEvidenceBindingIssues, requiredV9Applicability } from "./evidence";
import { V9_UNRESEARCHED_CAUSE_PROOF } from "../../types/safety-score-v9-causes";

const COMMON_REQUIRED_APPLICABILITY = new Map([
  "v9.control.review",
  "v9.exit.route-factors",
  "v9.backing.reserve-classification",
  "v9.backing.reserve-composition",
].map((rule) => [rule, Object.freeze(requiredV9Applicability(rule))]));
const EMPTY_UNKNOWN_EVIDENCE_HISTORY: NonNullable<V9AssetFactsV3["gaps"][number]["evidenceHistory"]> = {
  publishedBy: "unknown",
  evidenceRefIds: V9_EMPTY_ARRAY,
};
Object.freeze(EMPTY_UNKNOWN_EVIDENCE_HISTORY);

/**
 * Zod admission clones nested records. Share equal immutable values only after
 * that clone, without retaining a cache (or source generations) between assets.
 */
function internCompiledAssetFacts(asset: V9AssetFactsV3): V9AssetFactsV3 {
  const intern = createV9ValueInterner((value, keys) => {
    const record = value as Record<string, unknown>;
    if (
      keys.length === 3 && record.cause === "U" &&
      record.reason === "not-yet-researched" &&
      Array.isArray(record.evidenceRefIds) && record.evidenceRefIds.length === 0
    ) {
      return V9_UNRESEARCHED_CAUSE_PROOF;
    }
    if (
      keys.length === 4 && record.state === "required" &&
      record.rationale === null && record.gapId === null &&
      typeof record.policyRuleId === "string"
    ) {
      const common = COMMON_REQUIRED_APPLICABILITY.get(record.policyRuleId);
      if (common !== undefined) return common;
    }
    if (
      keys.length === 2 && record.publishedBy === "unknown" &&
      Array.isArray(record.evidenceRefIds) && record.evidenceRefIds.length === 0
    ) {
      return EMPTY_UNKNOWN_EVIDENCE_HISTORY;
    }
    return undefined;
  }, isV9AdmittedControlExecutionScope);
  return intern(asset);
}

const validatedCompiledFactSets = new WeakSet<object>();
const validatedAssetFacts = new WeakSet<object>();
const admittedAssetSchema = V9AssetFactsV3Schema.superRefine((asset, ctx) => {
  for (const { gapIndex, message } of findV9CauseEvidenceBindingIssues(asset)) {
    ctx.addIssue({ code: "custom", path: ["gaps", gapIndex, "causeProof"], message });
  }
}).transform(internCompiledAssetFacts);
const inProcessFactSetSchema = createV9FactSetCoreV3Schema(z.union([
  z.custom<V9AssetFactsV3>((value) =>
    value !== null && typeof value === "object" && validatedAssetFacts.has(value)),
  admittedAssetSchema,
]));

/** Admit once, then retain only immutable identity proof, never an extra fact graph. */
export function safeParseV9AssetFactsV3(input: unknown) {
  const parsed = admittedAssetSchema.safeParse(input);
  if (parsed.success) {
    deepFreeze(parsed.data);
    validatedAssetFacts.add(parsed.data);
  }
  return parsed;
}

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

/** Compile the proof-bearing current family into a schema-4 envelope. */
export function compileV9FactSetV3(input: unknown): Readonly<CompiledV9FactSetV3> {
  const core: V9FactSetCoreV3 = inProcessFactSetSchema.parse(input);
  const compiled: CompiledV9FactSetV3 = {
    ...core,
    v9FactSetDigest: computeValidatedV9FactSetDigest(core),
  };
  const sealed = sealValidatedFactSet(compiled);
  for (const asset of sealed.assets) validatedAssetFacts.add(asset);
  return sealed;
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
