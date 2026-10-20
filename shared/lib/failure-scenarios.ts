import { z } from "zod";
import type { FailureScenario, FailureScenariosById } from "../types/failure-scenarios";
import { FailureScenarioStructuralSchema, FailureScenarioStageSchema } from "../types/failure-scenarios";
import { CanonicalTextSchema } from "../types/safety-schema-primitives";
import { canonicalEvmAddress } from "./evm-address";
import { sha256HexFromUtf8Chunks } from "./sha256";
import { stableJsonStringifyChunksV1 } from "./stable-json";
import { CLIENT_TRACKED_IDS } from "./stablecoins/client-registry";

const AddressSchema = z.string().refine(
  (value) => value.trim() === value && canonicalEvmAddress(value) !== null,
  "Expected a 20-byte hex EVM address",
).transform((value) => value as `0x${string}`);
const StageSchema = FailureScenarioStageSchema.extend({
  targets: z.array(FailureScenarioStageSchema.shape.targets.unwrap().element.extend({
    address: AddressSchema,
  })).optional(),
});

export const FailureScenarioSchema = FailureScenarioStructuralSchema.extend({
  coinId: CanonicalTextSchema.refine((id) => CLIENT_TRACKED_IDS.has(id), "Unknown tracked stablecoin id"),
  stages: z.array(StageSchema).min(1),
  branchPoint: FailureScenarioStructuralSchema.shape.branchPoint.unwrap().extend({
    branches: z.array(FailureScenarioStructuralSchema.shape.branchPoint.unwrap().shape.branches.element.extend({
      stages: z.array(StageSchema).min(1),
    })).min(2),
  }).optional(),
}).superRefine((scenario, ctx) => {
  const falsifierIds = new Set<string>();
  scenario.falsifiers.forEach((falsifier, index) => {
    if (falsifierIds.has(falsifier.id)) {
      ctx.addIssue({ code: "custom", path: ["falsifiers", index, "id"], message: "Duplicate falsifier id" });
    }
    falsifierIds.add(falsifier.id);
  });
  const sourceIds = new Set<string>();
  scenario.sources.forEach((source, index) => {
    if (sourceIds.has(source.id)) {
      ctx.addIssue({ code: "custom", path: ["sources", index, "id"], message: "Duplicate source id" });
    }
    sourceIds.add(source.id);
  });
  function validateSourceIds(ids: string[], path: (string | number)[]) {
    ids.forEach((id, index) => {
      if (!sourceIds.has(id)) {
        ctx.addIssue({
          code: "custom", path: [...path, "sourceIds", index], message: `Unknown source id: ${id}`,
        });
      }
    });
  }
  const stageIds = new Map<string, number>();
  let stageOrder = 0;
  function registerStage(stage: FailureScenario["stages"][number], path: (string | number)[]) {
    if (stageIds.has(stage.id)) {
      ctx.addIssue({ code: "custom", path: [...path, "id"], message: "Duplicate stage id" });
    }
    stageIds.set(stage.id, stageOrder++);
    validateSourceIds(stage.sourceIds, path);
  }
  let branchAfterIndex = -1;
  if (scenario.branchPoint) {
    branchAfterIndex = scenario.stages.findIndex((stage) => stage.id === scenario.branchPoint!.afterStageId);
    if (branchAfterIndex < 0 || branchAfterIndex === scenario.stages.length - 1) {
      ctx.addIssue({
        code: "custom", path: ["branchPoint", "afterStageId"],
        message: "Branch point must follow a trunk stage with a subsequent trunk stage",
      });
    }
    const branchIds = new Set<string>();
    scenario.branchPoint.branches.forEach((branch, index) => {
      if (branchIds.has(branch.id)) {
        ctx.addIssue({ code: "custom", path: ["branchPoint", "branches", index, "id"], message: "Duplicate branch id" });
      }
      branchIds.add(branch.id);
    });
  }
  function registerBranches() {
    scenario.branchPoint?.branches.forEach((branch, branchIndex) => {
      branch.stages.forEach((stage, stageIndex) => {
        registerStage(stage, ["branchPoint", "branches", branchIndex, "stages", stageIndex]);
      });
    });
  }
  // Window order is trunk prefix, branch stages in authored branch order,
  // then trunk suffix. Branches are alternatives, not sequential actions.
  scenario.stages.forEach((stage, index) => {
    registerStage(stage, ["stages", index]);
    if (index === branchAfterIndex) registerBranches();
  });
  // Validate branch stages even if their splice point is invalid.
  if (scenario.branchPoint && branchAfterIndex < 0) registerBranches();
  for (const field of ["defenders", "keyFigures"] as const) {
    scenario[field].forEach((item, index) => validateSourceIds(item.sourceIds, [field, index]));
  }
  if (scenario.window) {
    const from = stageIds.get(scenario.window.fromStageId);
    const to = stageIds.get(scenario.window.toStageId);
    for (const field of ["fromStageId", "toStageId"] as const) {
      if (!stageIds.has(scenario.window[field])) {
        ctx.addIssue({ code: "custom", path: ["window", field], message: "Unknown window stage id" });
      }
    }
    if (from !== undefined && to !== undefined && from > to) {
      ctx.addIssue({ code: "custom", path: ["window", "toStageId"], message: "Window stages must be ordered" });
    }
  }
});

export const FailureScenariosByIdSchema = z
  .record(z.string(), FailureScenarioSchema)
  .superRefine((all, ctx) => {
    for (const [key, scenario] of Object.entries(all)) {
      if (key !== scenario.coinId) {
        ctx.addIssue({ code: "custom", path: [key, "coinId"], message: "Record key must equal coinId" });
      }
    }
  });

/** Reuses the shared synchronous, runtime-neutral canonical JSON and SHA-256 authorities. */
export function computeFailureScenarioContentHash(record: FailureScenario): string {
  const { review: _review, ...content } = record;
  return sha256HexFromUtf8Chunks(stableJsonStringifyChunksV1(content));
}

/** Called only after schema validation; shared by the selector and the CI gate. */
export function failureScenarioApprovalIssues(scenario: FailureScenario, now: Date): string[] {
  if (scenario.review.status !== "approved") return ["Scenario is not approved"];
  const issues: string[] = [];
  const { reviewedAt, contentSha256 } = scenario.review;
  if (Date.parse(reviewedAt) > now.getTime()) issues.push("Review is in the future");
  if (contentSha256 !== computeFailureScenarioContentHash(scenario)) issues.push("Approved content hash mismatch");
  if (scenario.falsifiers.some((falsifier) => falsifier.status === "met")) issues.push("Scenario falsifier is met");
  return issues;
}

export function selectFailureScenario(
  all: FailureScenariosById,
  coinId: string,
  opts: { allowDrafts: boolean; now: Date },
): { scenario: FailureScenario; isDraft: boolean } | null {
  if (!Object.hasOwn(all, coinId)) return null;
  const parsed = FailureScenarioSchema.safeParse(all[coinId]);
  if (!parsed.success || parsed.data.coinId !== coinId) return null;
  const scenario = parsed.data;
  if (scenario.review.status === "draft") {
    if (!opts.allowDrafts || scenario.falsifiers.some((falsifier) => falsifier.status === "met")) return null;
    return { scenario, isDraft: true };
  }
  if (failureScenarioApprovalIssues(scenario, opts.now).length > 0) return null;
  return { scenario, isDraft: false };
}
