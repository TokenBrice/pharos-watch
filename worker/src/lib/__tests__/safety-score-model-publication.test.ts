import { sha256Hex } from "@shared/lib/sha256";
import { describe, expect, it } from "vitest";
import {
  SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS,
  SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION,
  SafetyScorePublicationManifestSchema,
  planSafetyScorePublicationRefresh,
  planSafetyScorePublicationTransition,
  safetyScoreModelCacheKey,
  safetyScorePublicationFence,
  validateSafetyScoreModelCacheValue,
  type SafetyScoreModel,
  type SafetyScoreModelCacheArtifactKind,
  type SafetyScoreModelCacheEnvelope,
  type SafetyScoreModelFamilyPointer,
  type SafetyScoreModelIdentity,
  type SafetyScorePublicationManifest,
} from "../safety-score-model-publication";

const digest = (character: string) => character.repeat(64);
const baseGeneration = (character: string) => `report-cards-input:v1:${digest(character)}`;

function identity(
  model: SafetyScoreModel,
  lifecycle: "candidate" | "active" | "retired" = "candidate",
): SafetyScoreModelIdentity {
  return model === "v8"
    ? {
        model: "v8",
        methodologyVersion: "8.17",
        evaluationBuildDigest: digest("8"),
        policyDigest: null,
      }
    : {
        model: "v9",
        lifecycle,
        policyId: lifecycle === "candidate" ? "candidate-v1" : "9.0",
        policyDigest: digest("9"),
        evaluationBuildDigest: digest("a"),
      };
}

function artifact(
  model: SafetyScoreModel,
  generationId: string,
  artifactKind: SafetyScoreModelCacheArtifactKind,
  payloadDigest = digest(
    artifactKind === "full" ? "1" : artifactKind === "compact" ? "2" : artifactKind === "alert" ? "3" : "4",
  ),
) {
  return {
    artifactKind,
    cacheKey: safetyScoreModelCacheKey(model, artifactKind, generationId),
    payloadDigest,
  };
}

function family(input: {
  model: SafetyScoreModel;
  sequence: number;
  epoch: number;
  publishedAtSec?: number;
  generationId?: string;
  baseInputGenerationId?: string;
  lifecycle?: "candidate" | "active" | "retired";
  fullPayloadDigest?: string;
}): SafetyScoreModelFamilyPointer {
  const generationId = input.generationId ?? `${input.model}-generation-${input.sequence}`;
  return {
    model: input.model,
    generationId,
    familyGeneration: input.sequence,
    publicationEpoch: input.epoch,
    baseInputGenerationId: input.baseInputGenerationId ?? baseGeneration("b"),
    publishedAtSec: input.publishedAtSec ?? 100 + input.sequence,
    identity: identity(input.model, input.lifecycle),
    artifacts: {
      full: artifact(input.model, generationId, "full", input.fullPayloadDigest),
      compact: artifact(input.model, generationId, "compact"),
      alert: artifact(input.model, generationId, "alert"),
      fixedInput: artifact(input.model, generationId, "fixed-input"),
    },
  };
}

function aliases(active: SafetyScoreModelFamilyPointer) {
  const alias = (aliasKind: "full" | "compact" | "alert") => ({
    aliasKind,
    aliasCacheKey: SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS[aliasKind],
    targetCacheKey: active.artifacts[aliasKind].cacheKey,
    model: active.model,
    generationId: active.generationId,
    familyGeneration: active.familyGeneration,
    payloadDigest: active.artifacts[aliasKind].payloadDigest,
  });
  return { full: alias("full"), compact: alias("compact"), alert: alias("alert") };
}

function manifest(
  input: {
    state?: SafetyScorePublicationManifest["selection"]["state"];
    epoch?: number;
    v8?: SafetyScoreModelFamilyPointer | null;
    v9?: SafetyScoreModelFamilyPointer | null;
    updatedAtSec?: number;
  } = {},
): SafetyScorePublicationManifest {
  const state = input.state ?? "v8-active-v9-shadow";
  const epoch = input.epoch ?? 1;
  const v8 = input.v8 === undefined ? family({ model: "v8", sequence: 1, epoch }) : input.v8;
  const v9 = input.v9 === undefined ? family({ model: "v9", sequence: 1, epoch }) : input.v9;
  const activeModel = state === "v9-active-v8-warm" ? "v9" : "v8";
  const active = activeModel === "v8" ? v8 : v9;
  if (!active) throw new Error("Test manifest requires its active family");
  return SafetyScorePublicationManifestSchema.parse({
    schemaVersion: SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION,
    selection: {
      schemaVersion: 1,
      state,
      activeModel,
      activeGenerationId: active.generationId,
      v8GenerationId: v8?.generationId ?? null,
      v9GenerationId: v9?.generationId ?? null,
      transitionEpoch: epoch,
      updatedAtSec: input.updatedAtSec ?? 110,
    },
    families: { v8, v9 },
    aliases: aliases(active),
  });
}

function nextFamily(
  current: SafetyScorePublicationManifest,
  model: SafetyScoreModel,
  overrides: Partial<Parameters<typeof family>[0]> = {},
): SafetyScoreModelFamilyPointer {
  const previous = current.families[model];
  return family({
    model,
    sequence: (previous?.familyGeneration ?? 0) + 1,
    epoch: current.selection.transitionEpoch,
    publishedAtSec: current.selection.updatedAtSec + 10,
    baseInputGenerationId: baseGeneration("c"),
    lifecycle: model === "v9" && current.selection.state !== "v8-active-v9-shadow" ? "active" : "candidate",
    ...overrides,
  });
}

describe("Safety Score model publication manifest", () => {
  it("requires every active alias to point at one exact model family", () => {
    const current = manifest();
    expect(SafetyScorePublicationManifestSchema.safeParse(current).success).toBe(true);

    const tampered = structuredClone(current);
    tampered.aliases.compact.targetCacheKey = tampered.families.v9!.artifacts.compact.cacheKey;
    expect(SafetyScorePublicationManifestSchema.safeParse(tampered).success).toBe(false);
  });

  it("allows the initial shadow state before a V9 family has been published", () => {
    const current = manifest({ v9: null });
    expect(current.selection).toMatchObject({
      state: "v8-active-v9-shadow",
      activeModel: "v8",
      v9GenerationId: null,
    });
  });

  it("rejects unknown manifest properties and non-model-keyed family artifacts", () => {
    const current = manifest();
    expect(SafetyScorePublicationManifestSchema.safeParse({ ...current, surprise: true }).success).toBe(false);

    const tampered = structuredClone(current);
    tampered.families.v8!.artifacts.full.cacheKey = SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.full;
    expect(SafetyScorePublicationManifestSchema.safeParse(tampered).success).toBe(false);
  });

  it("requires an active V9 lifecycle in the V9-active state", () => {
    expect(() =>
      manifest({
        state: "v9-active-v8-warm",
        epoch: 2,
        v9: family({ model: "v9", sequence: 1, epoch: 1, lifecycle: "candidate" }),
      }),
    ).toThrow("active V9 envelope");
  });
});

describe("Safety Score publication refresh planning", () => {
  it("advances active aliases only for the state-authorized model", () => {
    const current = manifest();
    const v8 = nextFamily(current, "v8");
    const v9 = nextFamily(current, "v9", {
      baseInputGenerationId: v8.baseInputGenerationId,
    });

    const plan = planSafetyScorePublicationRefresh({
      current,
      fence: safetyScorePublicationFence(current),
      nowSec: 120,
      attempts: {
        v8: { status: "success", family: v8 },
        v9: { status: "success", family: v9 },
      },
    });

    expect(plan.kind).toBe("accepted");
    expect(plan.activeAdvanced).toBe(true);
    expect(plan.modelSwitched).toBe(false);
    expect(plan.manifest.selection.activeModel).toBe("v8");
    expect(plan.manifest.selection.activeGenerationId).toBe(v8.generationId);
    expect(plan.manifest.families.v9?.generationId).toBe(v9.generationId);
    expect(plan.aliasWrites).toHaveLength(3);
    expect(plan.aliasWrites.every((entry) => entry.model === "v8")).toBe(true);
  });

  it.each([
    {
      state: "v8-active-v9-shadow" as const,
      activeFailure: "v8" as const,
      inactiveSuccess: "v9" as const,
    },
    {
      state: "v9-active-v8-warm" as const,
      activeFailure: "v9" as const,
      inactiveSuccess: "v8" as const,
    },
    {
      state: "v8-restored-v9-retained" as const,
      activeFailure: "v8" as const,
      inactiveSuccess: "v9" as const,
    },
  ])(
    "never turns an active $activeFailure failure into an implicit switch in $state",
    ({ state, activeFailure, inactiveSuccess }) => {
      const epoch = state === "v8-active-v9-shadow" ? 1 : 2;
      const current = manifest({
        state,
        epoch,
        v8: family({ model: "v8", sequence: 1, epoch: 1 }),
        v9: family({
          model: "v9",
          sequence: 1,
          epoch: 1,
          lifecycle: state === "v8-active-v9-shadow" ? "candidate" : "active",
        }),
      });
      const successfulFamily = nextFamily(current, inactiveSuccess, {
        lifecycle: inactiveSuccess === "v9" ? "active" : undefined,
      });
      const activeGenerationId = current.selection.activeGenerationId;
      const activeAliases = structuredClone(current.aliases);

      const plan = planSafetyScorePublicationRefresh({
        current,
        fence: safetyScorePublicationFence(current),
        nowSec: 120,
        attempts: {
          [activeFailure]: { status: "failed", reason: "compute-failed" },
          [inactiveSuccess]: { status: "success", family: successfulFamily },
        },
      });

      expect(plan.kind).toBe("accepted");
      expect(plan.activeAdvanced).toBe(false);
      expect(plan.modelSwitched).toBe(false);
      expect(plan.manifest.selection.state).toBe(state);
      expect(plan.manifest.selection.activeGenerationId).toBe(activeGenerationId);
      expect(plan.manifest.aliases).toEqual(activeAliases);
      expect(plan.aliasWrites).toEqual([]);
      expect(plan.failures).toEqual({ [activeFailure]: "compute-failed" });
    },
  );

  it("makes failure-only attempts a diagnostic no-op", () => {
    const current = manifest();
    const plan = planSafetyScorePublicationRefresh({
      current,
      fence: safetyScorePublicationFence(current),
      nowSec: 120,
      attempts: { v9: { status: "failed", reason: "serialization-failed" } },
    });

    expect(plan).toMatchObject({
      kind: "no-op",
      manifest: current,
      aliasWrites: [],
      familyWrites: [],
      activeAdvanced: false,
      modelSwitched: false,
      failures: { v9: "serialization-failed" },
    });
  });

  it("rejects dual results that do not share one exact base generation", () => {
    const current = manifest();
    const plan = planSafetyScorePublicationRefresh({
      current,
      fence: safetyScorePublicationFence(current),
      nowSec: 120,
      attempts: {
        v8: { status: "success", family: nextFamily(current, "v8", { baseInputGenerationId: baseGeneration("c") }) },
        v9: { status: "success", family: nextFamily(current, "v9", { baseInputGenerationId: baseGeneration("d") }) },
      },
    });

    expect(plan).toMatchObject({
      kind: "rejected",
      reason: "base-generation-mismatch",
      aliasWrites: [],
      familyWrites: [],
    });
  });

  it("rejects a same-epoch stale generation race after the first writer advances", () => {
    const current = manifest();
    const oldFence = safetyScorePublicationFence(current);
    const first = planSafetyScorePublicationRefresh({
      current,
      fence: oldFence,
      nowSec: 120,
      attempts: { v8: { status: "success", family: nextFamily(current, "v8") } },
    });
    expect(first.kind).toBe("accepted");

    const stale = planSafetyScorePublicationRefresh({
      current: first.manifest,
      fence: oldFence,
      nowSec: 121,
      attempts: { v8: { status: "success", family: nextFamily(current, "v8") } },
    });
    expect(stale).toMatchObject({
      kind: "rejected",
      reason: "fence-mismatch",
      aliasWrites: [],
      familyWrites: [],
    });
  });

  it("requires the exact next per-model family generation", () => {
    const current = manifest();
    const skipped = nextFamily(current, "v8", { sequence: 3 });
    const plan = planSafetyScorePublicationRefresh({
      current,
      fence: safetyScorePublicationFence(current),
      nowSec: 120,
      attempts: { v8: { status: "success", family: skipped } },
    });
    expect(plan).toMatchObject({ kind: "rejected", reason: "generation-not-monotonic" });
  });
});

describe("Safety Score explicit model transitions", () => {
  it("activates only an explicitly active V9 family and increments the epoch", () => {
    const current = manifest({
      v9: family({ model: "v9", sequence: 1, epoch: 1, lifecycle: "active" }),
    });
    const oldFence = safetyScorePublicationFence(current);
    const plan = planSafetyScorePublicationTransition({
      current,
      fence: oldFence,
      targetState: "v9-active-v8-warm",
      nowSec: 120,
    });

    expect(plan.kind).toBe("accepted");
    expect(plan.modelSwitched).toBe(true);
    expect(plan.manifest.selection).toMatchObject({
      state: "v9-active-v8-warm",
      activeModel: "v9",
      activeGenerationId: current.families.v9!.generationId,
      transitionEpoch: 2,
    });
    expect(plan.aliasWrites.every((entry) => entry.model === "v9")).toBe(true);

    const staleOldPublisher = planSafetyScorePublicationRefresh({
      current: plan.manifest,
      fence: oldFence,
      nowSec: 121,
      attempts: {
        v8: {
          status: "success",
          family: nextFamily(current, "v8", { publishedAtSec: 121 }),
        },
      },
    });
    expect(staleOldPublisher).toMatchObject({
      kind: "rejected",
      reason: "fence-mismatch",
      modelSwitched: false,
      aliasWrites: [],
    });
  });

  it("rejects activation of a candidate V9 family", () => {
    const current = manifest();
    const plan = planSafetyScorePublicationTransition({
      current,
      fence: safetyScorePublicationFence(current),
      targetState: "v9-active-v8-warm",
      nowSec: 120,
    });
    expect(plan).toMatchObject({
      kind: "rejected",
      reason: "target-family-not-active",
      aliasWrites: [],
    });
  });

  it("rolls back only through an explicit fenced transition and rejects the old V9 epoch", () => {
    const current = manifest({
      state: "v9-active-v8-warm",
      epoch: 2,
      v8: family({ model: "v8", sequence: 2, epoch: 2 }),
      v9: family({ model: "v9", sequence: 2, epoch: 2, lifecycle: "active" }),
    });
    const oldFence = safetyScorePublicationFence(current);
    const rollback = planSafetyScorePublicationTransition({
      current,
      fence: oldFence,
      targetState: "v8-restored-v9-retained",
      nowSec: 130,
    });

    expect(rollback.kind).toBe("accepted");
    expect(rollback.manifest.selection).toMatchObject({
      state: "v8-restored-v9-retained",
      activeModel: "v8",
      activeGenerationId: current.families.v8!.generationId,
      transitionEpoch: 3,
    });
    expect(rollback.aliasWrites.every((entry) => entry.model === "v8")).toBe(true);

    const staleV9 = planSafetyScorePublicationRefresh({
      current: rollback.manifest,
      fence: oldFence,
      nowSec: 131,
      attempts: { v9: { status: "success", family: nextFamily(current, "v9", { lifecycle: "active" }) } },
    });
    expect(staleV9).toMatchObject({ kind: "rejected", reason: "fence-mismatch" });
  });

  it("rejects unrecognized transition edges", () => {
    const current = manifest();
    const plan = planSafetyScorePublicationTransition({
      current,
      fence: safetyScorePublicationFence(current),
      targetState: "v8-restored-v9-retained",
      nowSec: 120,
    });
    expect(plan).toMatchObject({ kind: "rejected", reason: "invalid-state-transition" });
  });
});

function v9Payload(generationId: string, baseInputGenerationId: string) {
  return {
    model: "v9-critical-path" as const,
    schemaVersion: 1 as const,
    lifecycle: "candidate" as const,
    candidateId: "candidate-v1",
    policyVersion: "candidate-v1",
    publicationGenerationId: generationId,
    publicationEpoch: 1,
    baseInputGenerationId,
    factSetDigest: digest("b"),
    resultDigest: digest("c"),
    policy: { id: "candidate-v1", semanticDigest: digest("9") },
    evaluationBuildDigest: digest("a"),
    sourceGenerations: { registry: "registry:g1" },
    asOfSec: 100,
    publishedAtSec: 101,
    completeness: { expectedCount: 0, ratedCount: 0, notRatedCount: 0, notRatedIds: [] },
    cards: [],
  };
}

function v8Payload(generationId: string) {
  return {
    cards: [],
    methodology: {
      version: "8.17",
      weights: {
        pegStability: 0.2,
        liquidity: 0.2,
        resilience: 0.2,
        decentralization: 0.2,
        dependencyRisk: 0.2,
      },
      pegMultiplierExponent: 1,
      thresholds: [],
    },
    dependencyGraph: { edges: [] },
    updatedAt: 100,
    publication: {
      generationId,
      methodologyVersion: "8.17",
      expectedCount: 0,
      scoredCount: 0,
      notRatedCount: 0,
      notRatedIds: [],
    },
  };
}

function cacheValue(input: {
  model: SafetyScoreModel;
  generationId: string;
  baseInputGenerationId: string;
  payload: unknown;
  identity: SafetyScoreModelIdentity;
  extra?: Record<string, unknown>;
}) {
  const payloadJson = JSON.stringify(input.payload);
  const envelope: SafetyScoreModelCacheEnvelope & Record<string, unknown> = {
    schemaVersion: 1,
    model: input.model,
    artifactKind: "full",
    generationId: input.generationId,
    familyGeneration: 1,
    publicationEpoch: 1,
    baseInputGenerationId: input.baseInputGenerationId,
    publishedAtSec: 101,
    identity: input.identity,
    payloadDigest: sha256Hex(payloadJson),
    payloadJson,
    ...input.extra,
  };
  return { value: JSON.stringify(envelope), digest: envelope.payloadDigest };
}

describe("Safety Score model-keyed cache validation", () => {
  it("validates a V9 full envelope through the shared V9 response schema", () => {
    const generationId = "v9-generation-1";
    const baseInputGenerationId = baseGeneration("b");
    const cached = cacheValue({
      model: "v9",
      generationId,
      baseInputGenerationId,
      payload: v9Payload(generationId, baseInputGenerationId),
      identity: identity("v9", "candidate"),
    });
    const expected = family({
      model: "v9",
      sequence: 1,
      epoch: 1,
      generationId,
      baseInputGenerationId,
      lifecycle: "candidate",
      fullPayloadDigest: cached.digest,
    });

    expect(validateSafetyScoreModelCacheValue(cached.value, expected)).toMatchObject({
      ok: true,
      envelope: { model: "v9", generationId, artifactKind: "full" },
    });
  });

  it("validates a V8 full envelope through the retained V8 response contract", () => {
    const generationId = "v8-generation-1";
    const baseInputGenerationId = baseGeneration("b");
    const cached = cacheValue({
      model: "v8",
      generationId,
      baseInputGenerationId,
      payload: v8Payload(generationId),
      identity: identity("v8"),
    });
    const expected = family({
      model: "v8",
      sequence: 1,
      epoch: 1,
      generationId,
      baseInputGenerationId,
      fullPayloadDigest: cached.digest,
    });

    expect(validateSafetyScoreModelCacheValue(cached.value, expected)).toMatchObject({
      ok: true,
      envelope: { model: "v8", generationId, artifactKind: "full" },
    });
  });

  it("rejects digest tampering before parsing the model payload", () => {
    const generationId = "v9-generation-1";
    const baseInputGenerationId = baseGeneration("b");
    const cached = cacheValue({
      model: "v9",
      generationId,
      baseInputGenerationId,
      payload: v9Payload(generationId, baseInputGenerationId),
      identity: identity("v9"),
    });
    const decoded = JSON.parse(cached.value) as SafetyScoreModelCacheEnvelope;
    decoded.payloadJson = `${decoded.payloadJson} `;

    expect(validateSafetyScoreModelCacheValue(JSON.stringify(decoded))).toMatchObject({
      ok: false,
      reason: "payload-digest-mismatch",
    });
  });

  it("rejects model payload identity drift and unexpected envelope fields", () => {
    const generationId = "v9-generation-1";
    const baseInputGenerationId = baseGeneration("b");
    const wrongGeneration = cacheValue({
      model: "v9",
      generationId,
      baseInputGenerationId,
      payload: v9Payload("different-generation", baseInputGenerationId),
      identity: identity("v9", "candidate"),
    });
    expect(validateSafetyScoreModelCacheValue(wrongGeneration.value)).toMatchObject({
      ok: false,
      reason: "invalid-full-payload",
    });

    const unknownField = cacheValue({
      model: "v9",
      generationId,
      baseInputGenerationId,
      payload: v9Payload(generationId, baseInputGenerationId),
      identity: identity("v9", "candidate"),
      extra: { surprise: true },
    });
    expect(validateSafetyScoreModelCacheValue(unknownField.value)).toMatchObject({
      ok: false,
      reason: "invalid-envelope",
    });
  });

  it("rejects a valid envelope when it does not match the claimed family pointer", () => {
    const generationId = "v8-generation-1";
    const baseInputGenerationId = baseGeneration("b");
    const cached = cacheValue({
      model: "v8",
      generationId,
      baseInputGenerationId,
      payload: v8Payload(generationId),
      identity: identity("v8"),
    });
    const expected = family({
      model: "v8",
      sequence: 2,
      epoch: 1,
      generationId,
      baseInputGenerationId,
      fullPayloadDigest: cached.digest,
    });

    expect(validateSafetyScoreModelCacheValue(cached.value, expected)).toMatchObject({
      ok: false,
      reason: "family-pointer-mismatch",
    });
  });
});
