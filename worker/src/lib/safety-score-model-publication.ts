import { sha256Hex } from "@shared/lib/sha256";
import {
  SafetyScoreModelManifestSchema,
  SafetyScoreV9ResponseSchema,
  type SafetyScoreModelManifest,
} from "@shared/types/safety-score-v9-public";
import { ReportCardsResponseSchema } from "@shared/types/report-cards";
import { z } from "zod";

export const SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION = 1;

export const SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS = {
  full: "report-cards:snapshot",
  compact: "report_card_cache",
  alert: "alert:safety-source-cache",
} as const;

export const SAFETY_SCORE_MODEL_CACHE_ARTIFACT_KINDS = ["full", "compact", "alert", "fixed-input"] as const;

export type SafetyScoreModel = "v8" | "v9";
export type SafetyScoreModelCacheArtifactKind = (typeof SAFETY_SCORE_MODEL_CACHE_ARTIFACT_KINDS)[number];
export type SafetyScoreActiveAliasKind = keyof typeof SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GenerationIdSchema = z.string().trim().min(1);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
const SafetyScoreModelSchema = z.enum(["v8", "v9"]);
const ArtifactKindSchema = z.enum(SAFETY_SCORE_MODEL_CACHE_ARTIFACT_KINDS);

const V8ModelIdentitySchema = z
  .object({
    model: z.literal("v8"),
    methodologyVersion: z.string().trim().min(1),
    evaluationBuildDigest: Sha256Schema,
    policyDigest: z.null(),
  })
  .strict();

const V9ModelIdentitySchema = z
  .object({
    model: z.literal("v9"),
    lifecycle: z.enum(["candidate", "active", "retired"]),
    policyId: z.string().trim().min(1),
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
  })
  .strict();

export const SafetyScoreModelIdentitySchema = z.discriminatedUnion("model", [
  V8ModelIdentitySchema,
  V9ModelIdentitySchema,
]);
export type SafetyScoreModelIdentity = z.infer<typeof SafetyScoreModelIdentitySchema>;

export function safetyScoreModelCacheKey(
  model: SafetyScoreModel,
  artifactKind: SafetyScoreModelCacheArtifactKind,
  generationId: string,
): string {
  return `safety-score:${model}:${artifactKind}:${encodeURIComponent(generationId)}`;
}

export const SafetyScoreModelArtifactPointerSchema = z
  .object({
    artifactKind: ArtifactKindSchema,
    cacheKey: z.string().min(1),
    payloadDigest: Sha256Schema,
  })
  .strict();
export type SafetyScoreModelArtifactPointer = z.infer<typeof SafetyScoreModelArtifactPointerSchema>;

export const SafetyScoreModelFamilyPointerSchema = z
  .object({
    model: SafetyScoreModelSchema,
    generationId: GenerationIdSchema,
    familyGeneration: z.number().int().positive(),
    publicationEpoch: z.number().int().nonnegative(),
    baseInputGenerationId: BaseInputGenerationIdSchema,
    publishedAtSec: z.number().int().nonnegative(),
    identity: SafetyScoreModelIdentitySchema,
    artifacts: z
      .object({
        full: SafetyScoreModelArtifactPointerSchema,
        compact: SafetyScoreModelArtifactPointerSchema,
        alert: SafetyScoreModelArtifactPointerSchema,
        fixedInput: SafetyScoreModelArtifactPointerSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((family, ctx) => {
    if (family.identity.model !== family.model) {
      ctx.addIssue({
        code: "custom",
        path: ["identity", "model"],
        message: "Family identity model does not match its model key",
      });
    }

    const artifacts: readonly [SafetyScoreModelCacheArtifactKind, SafetyScoreModelArtifactPointer][] = [
      ["full", family.artifacts.full],
      ["compact", family.artifacts.compact],
      ["alert", family.artifacts.alert],
      ["fixed-input", family.artifacts.fixedInput],
    ];
    for (const [expectedKind, artifact] of artifacts) {
      if (artifact.artifactKind !== expectedKind) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", expectedKind, "artifactKind"],
          message: `Expected ${expectedKind} artifact`,
        });
      }
      const expectedKey = safetyScoreModelCacheKey(family.model, expectedKind, family.generationId);
      if (artifact.cacheKey !== expectedKey) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", expectedKind, "cacheKey"],
          message: `Expected model-keyed cache key ${expectedKey}`,
        });
      }
    }
  });
export type SafetyScoreModelFamilyPointer = z.infer<typeof SafetyScoreModelFamilyPointerSchema>;

export const SafetyScoreActiveAliasPointerSchema = z
  .object({
    aliasKind: z.enum(["full", "compact", "alert"]),
    aliasCacheKey: z.string().min(1),
    targetCacheKey: z.string().min(1),
    model: SafetyScoreModelSchema,
    generationId: GenerationIdSchema,
    familyGeneration: z.number().int().positive(),
    payloadDigest: Sha256Schema,
  })
  .strict();
export type SafetyScoreActiveAliasPointer = z.infer<typeof SafetyScoreActiveAliasPointerSchema>;

function familyForModel(
  families: SafetyScorePublicationManifest["families"],
  model: SafetyScoreModel,
): SafetyScoreModelFamilyPointer | null {
  return model === "v8" ? families.v8 : families.v9;
}

function artifactForAlias(
  family: SafetyScoreModelFamilyPointer,
  aliasKind: SafetyScoreActiveAliasKind,
): SafetyScoreModelArtifactPointer {
  return family.artifacts[aliasKind];
}

function buildActiveAliases(family: SafetyScoreModelFamilyPointer): SafetyScorePublicationManifest["aliases"] {
  const alias = (aliasKind: SafetyScoreActiveAliasKind): SafetyScoreActiveAliasPointer => {
    const artifact = artifactForAlias(family, aliasKind);
    return {
      aliasKind,
      aliasCacheKey: SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS[aliasKind],
      targetCacheKey: artifact.cacheKey,
      model: family.model,
      generationId: family.generationId,
      familyGeneration: family.familyGeneration,
      payloadDigest: artifact.payloadDigest,
    };
  };
  return {
    full: alias("full"),
    compact: alias("compact"),
    alert: alias("alert"),
  };
}

function manifestIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

export const SafetyScorePublicationManifestSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION),
    selection: SafetyScoreModelManifestSchema,
    families: z
      .object({
        v8: SafetyScoreModelFamilyPointerSchema.nullable(),
        v9: SafetyScoreModelFamilyPointerSchema.nullable(),
      })
      .strict(),
    aliases: z
      .object({
        full: SafetyScoreActiveAliasPointerSchema,
        compact: SafetyScoreActiveAliasPointerSchema,
        alert: SafetyScoreActiveAliasPointerSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.families.v8 && manifest.families.v8.model !== "v8") {
      manifestIssue(ctx, ["families", "v8", "model"], "V8 family must be keyed as v8");
    }
    if (manifest.families.v9 && manifest.families.v9.model !== "v9") {
      manifestIssue(ctx, ["families", "v9", "model"], "V9 family must be keyed as v9");
    }
    if (!manifest.families.v8) {
      manifestIssue(ctx, ["families", "v8"], "Every publisher state must retain a V8 family");
    }
    if (manifest.selection.state !== "v8-active-v9-shadow" && !manifest.families.v9) {
      manifestIssue(ctx, ["families", "v9"], "Warm and restored states must retain a V9 family");
    }
    if (manifest.selection.v8GenerationId !== (manifest.families.v8?.generationId ?? null)) {
      manifestIssue(ctx, ["selection", "v8GenerationId"], "V8 selection generation does not match its family pointer");
    }
    if (manifest.selection.v9GenerationId !== (manifest.families.v9?.generationId ?? null)) {
      manifestIssue(ctx, ["selection", "v9GenerationId"], "V9 selection generation does not match its family pointer");
    }

    for (const [model, family] of [
      ["v8", manifest.families.v8],
      ["v9", manifest.families.v9],
    ] as const) {
      if (family && family.publicationEpoch > manifest.selection.transitionEpoch) {
        manifestIssue(
          ctx,
          ["families", model, "publicationEpoch"],
          "Family publication epoch cannot be ahead of the selected transition epoch",
        );
      }
    }

    const activeFamily = familyForModel(manifest.families, manifest.selection.activeModel);
    if (!activeFamily) {
      manifestIssue(ctx, ["families", manifest.selection.activeModel], "Active family is missing");
      return;
    }
    if (activeFamily.generationId !== manifest.selection.activeGenerationId) {
      manifestIssue(ctx, ["selection", "activeGenerationId"], "Active generation does not match the active family");
    }
    if (
      manifest.selection.state === "v9-active-v8-warm" &&
      (activeFamily.identity.model !== "v9" || activeFamily.identity.lifecycle !== "active")
    ) {
      manifestIssue(
        ctx,
        ["families", "v9", "identity", "lifecycle"],
        "An active V9 selection requires an active V9 envelope",
      );
    }
    if (
      manifest.selection.state === "v8-restored-v9-retained" &&
      manifest.families.v9?.identity.model === "v9" &&
      manifest.families.v9.identity.lifecycle === "candidate"
    ) {
      manifestIssue(
        ctx,
        ["families", "v9", "identity", "lifecycle"],
        "A restored manifest cannot retain a never-activated candidate family",
      );
    }

    for (const aliasKind of ["full", "compact", "alert"] as const) {
      const alias = manifest.aliases[aliasKind];
      const artifact = artifactForAlias(activeFamily, aliasKind);
      const expectedAliasKey = SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS[aliasKind];
      if (
        alias.aliasKind !== aliasKind ||
        alias.aliasCacheKey !== expectedAliasKey ||
        alias.targetCacheKey !== artifact.cacheKey ||
        alias.model !== activeFamily.model ||
        alias.generationId !== activeFamily.generationId ||
        alias.familyGeneration !== activeFamily.familyGeneration ||
        alias.payloadDigest !== artifact.payloadDigest
      ) {
        manifestIssue(
          ctx,
          ["aliases", aliasKind],
          `Active ${aliasKind} alias does not exactly match the selected family`,
        );
      }
    }
  });
export type SafetyScorePublicationManifest = z.infer<typeof SafetyScorePublicationManifestSchema>;

export const SafetyScoreModelCacheEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION),
    model: SafetyScoreModelSchema,
    artifactKind: ArtifactKindSchema,
    generationId: GenerationIdSchema,
    familyGeneration: z.number().int().positive(),
    publicationEpoch: z.number().int().nonnegative(),
    baseInputGenerationId: BaseInputGenerationIdSchema,
    publishedAtSec: z.number().int().nonnegative(),
    identity: SafetyScoreModelIdentitySchema,
    payloadDigest: Sha256Schema,
    payloadJson: z.string(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.identity.model !== envelope.model) {
      ctx.addIssue({
        code: "custom",
        path: ["identity", "model"],
        message: "Cache envelope identity model does not match its model key",
      });
    }
  });
export type SafetyScoreModelCacheEnvelope = z.infer<typeof SafetyScoreModelCacheEnvelopeSchema>;

export type SafetyScoreModelCacheValidationResult =
  | {
      ok: true;
      envelope: SafetyScoreModelCacheEnvelope;
      payload: unknown;
    }
  | {
      ok: false;
      reason:
        | "invalid-envelope-json"
        | "invalid-envelope"
        | "payload-digest-mismatch"
        | "invalid-payload-json"
        | "invalid-full-payload"
        | "family-pointer-mismatch";
      detail: string;
    };

function cacheValidationFailure(
  reason: Extract<SafetyScoreModelCacheValidationResult, { ok: false }>["reason"],
  detail: string,
): SafetyScoreModelCacheValidationResult {
  return { ok: false, reason, detail };
}

function validateFullPayload(envelope: SafetyScoreModelCacheEnvelope, payload: unknown): string | null {
  if (envelope.model === "v8") {
    const wrappedPayload =
      payload !== null &&
      typeof payload === "object" &&
      "payload" in payload &&
      "generation" in payload &&
      "methodologyVersion" in payload
        ? (payload as { payload: unknown }).payload
        : payload;
    const parsed = ReportCardsResponseSchema.safeParse(wrappedPayload);
    if (!parsed.success) return parsed.error.message;
    if (envelope.identity.model !== "v8") return "V8 envelope has a non-V8 identity";
    if (parsed.data.methodology.version !== envelope.identity.methodologyVersion) {
      return "V8 methodology does not match the cache identity";
    }
    if (!parsed.data.publication) return "V8 full payload has no publication completeness manifest";
    if (parsed.data.publication.generationId !== envelope.generationId) {
      return "V8 publication generation does not match the cache envelope";
    }
    if (parsed.data.publication.methodologyVersion !== envelope.identity.methodologyVersion) {
      return "V8 publication methodology does not match the cache identity";
    }
    if (parsed.data.updatedAt > envelope.publishedAtSec) {
      return "V8 cache publication predates its full payload";
    }
    return null;
  }

  const parsed = SafetyScoreV9ResponseSchema.safeParse(payload);
  if (!parsed.success) return parsed.error.message;
  if (envelope.identity.model !== "v9") return "V9 envelope has a non-V9 identity";
  if (parsed.data.publicationGenerationId !== envelope.generationId) {
    return "V9 publication generation does not match the cache envelope";
  }
  if (parsed.data.baseInputGenerationId !== envelope.baseInputGenerationId) {
    return "V9 base input generation does not match the cache envelope";
  }
  if (
    parsed.data.policy.id !== envelope.identity.policyId ||
    parsed.data.policy.semanticDigest !== envelope.identity.policyDigest
  ) {
    return "V9 policy identity does not match the cache envelope";
  }
  if (parsed.data.evaluationBuildDigest !== envelope.identity.evaluationBuildDigest) {
    return "V9 evaluation build does not match the cache envelope";
  }
  if (parsed.data.lifecycle !== envelope.identity.lifecycle) {
    return "V9 lifecycle does not match the cache envelope";
  }
  if (parsed.data.publishedAtSec !== envelope.publishedAtSec) {
    return "V9 publication time does not match the cache envelope";
  }
  return null;
}

export function validateSafetyScoreModelCacheValue(
  value: string,
  expectedFamily?: SafetyScoreModelFamilyPointer,
): SafetyScoreModelCacheValidationResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    return cacheValidationFailure("invalid-envelope-json", error instanceof Error ? error.message : String(error));
  }

  const parsedEnvelope = SafetyScoreModelCacheEnvelopeSchema.safeParse(decoded);
  if (!parsedEnvelope.success) {
    return cacheValidationFailure("invalid-envelope", parsedEnvelope.error.message);
  }
  const envelope = parsedEnvelope.data;

  if (sha256Hex(envelope.payloadJson) !== envelope.payloadDigest) {
    return cacheValidationFailure("payload-digest-mismatch", "The payload does not match its SHA-256 digest");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(envelope.payloadJson);
  } catch (error) {
    return cacheValidationFailure("invalid-payload-json", error instanceof Error ? error.message : String(error));
  }

  if (envelope.artifactKind === "full") {
    const fullPayloadFailure = validateFullPayload(envelope, payload);
    if (fullPayloadFailure) {
      return cacheValidationFailure("invalid-full-payload", fullPayloadFailure);
    }
  }

  if (expectedFamily) {
    const parsedExpectedFamily = SafetyScoreModelFamilyPointerSchema.safeParse(expectedFamily);
    if (!parsedExpectedFamily.success) {
      return cacheValidationFailure(
        "family-pointer-mismatch",
        `Expected family pointer is invalid: ${parsedExpectedFamily.error.message}`,
      );
    }
    const canonicalExpectedFamily = parsedExpectedFamily.data;
    const expectedArtifact =
      canonicalExpectedFamily.artifacts[envelope.artifactKind === "fixed-input" ? "fixedInput" : envelope.artifactKind];
    if (
      envelope.model !== canonicalExpectedFamily.model ||
      envelope.generationId !== canonicalExpectedFamily.generationId ||
      envelope.familyGeneration !== canonicalExpectedFamily.familyGeneration ||
      envelope.publicationEpoch !== canonicalExpectedFamily.publicationEpoch ||
      envelope.baseInputGenerationId !== canonicalExpectedFamily.baseInputGenerationId ||
      envelope.publishedAtSec !== canonicalExpectedFamily.publishedAtSec ||
      JSON.stringify(envelope.identity) !== JSON.stringify(canonicalExpectedFamily.identity) ||
      envelope.artifactKind !== expectedArtifact.artifactKind ||
      envelope.payloadDigest !== expectedArtifact.payloadDigest
    ) {
      return cacheValidationFailure(
        "family-pointer-mismatch",
        "Cache envelope does not exactly match the expected family pointer",
      );
    }
  }

  return { ok: true, envelope, payload };
}

export interface SafetyScorePublicationFence {
  transitionEpoch: number;
  state: SafetyScoreModelManifest["state"];
  activeGenerationId: string;
  familyGenerations: {
    v8: { generationId: string; familyGeneration: number } | null;
    v9: { generationId: string; familyGeneration: number } | null;
  };
}

export function safetyScorePublicationFence(manifest: SafetyScorePublicationManifest): SafetyScorePublicationFence {
  const familyFence = (family: SafetyScoreModelFamilyPointer | null) =>
    family ? { generationId: family.generationId, familyGeneration: family.familyGeneration } : null;
  return {
    transitionEpoch: manifest.selection.transitionEpoch,
    state: manifest.selection.state,
    activeGenerationId: manifest.selection.activeGenerationId,
    familyGenerations: {
      v8: familyFence(manifest.families.v8),
      v9: familyFence(manifest.families.v9),
    },
  };
}

function exactFenceMatch(current: SafetyScorePublicationManifest, claimed: SafetyScorePublicationFence): boolean {
  return JSON.stringify(safetyScorePublicationFence(current)) === JSON.stringify(claimed);
}

export type SafetyScoreModelRefreshAttempt =
  | { status: "success"; family: SafetyScoreModelFamilyPointer }
  | { status: "failed"; reason: string }
  | { status: "not-run"; reason?: string };

export interface SafetyScorePublicationRefreshInput {
  current: SafetyScorePublicationManifest;
  fence: SafetyScorePublicationFence;
  nowSec: number;
  attempts: Partial<Record<SafetyScoreModel, SafetyScoreModelRefreshAttempt>>;
}

export type SafetyScorePublicationPlanRejectionReason =
  | "invalid-current-manifest"
  | "fence-mismatch"
  | "invalid-time"
  | "invalid-family"
  | "generation-not-monotonic"
  | "base-generation-mismatch"
  | "invalid-state-transition"
  | "target-family-missing"
  | "target-family-not-active";

export type SafetyScorePublicationPlan =
  | {
      kind: "accepted";
      manifest: SafetyScorePublicationManifest;
      familyWrites: SafetyScoreModelFamilyPointer[];
      aliasWrites: SafetyScoreActiveAliasPointer[];
      activeAdvanced: boolean;
      modelSwitched: boolean;
      failures: Partial<Record<SafetyScoreModel, string>>;
    }
  | {
      kind: "no-op";
      manifest: SafetyScorePublicationManifest;
      familyWrites: [];
      aliasWrites: [];
      activeAdvanced: false;
      modelSwitched: false;
      failures: Partial<Record<SafetyScoreModel, string>>;
    }
  | {
      kind: "rejected";
      reason: SafetyScorePublicationPlanRejectionReason;
      detail: string;
      manifest: SafetyScorePublicationManifest;
      familyWrites: [];
      aliasWrites: [];
      activeAdvanced: false;
      modelSwitched: false;
      failures: Partial<Record<SafetyScoreModel, string>>;
    };

function rejectedPlan(
  current: SafetyScorePublicationManifest,
  reason: SafetyScorePublicationPlanRejectionReason,
  detail: string,
  failures: Partial<Record<SafetyScoreModel, string>> = {},
): SafetyScorePublicationPlan {
  return {
    kind: "rejected",
    reason,
    detail,
    manifest: current,
    familyWrites: [],
    aliasWrites: [],
    activeAdvanced: false,
    modelSwitched: false,
    failures,
  };
}

function validatePlanningPrelude(
  current: SafetyScorePublicationManifest,
  fence: SafetyScorePublicationFence,
  nowSec: number,
): SafetyScorePublicationPlan | null {
  const parsed = SafetyScorePublicationManifestSchema.safeParse(current);
  if (!parsed.success) {
    return rejectedPlan(current, "invalid-current-manifest", parsed.error.message);
  }
  if (!exactFenceMatch(parsed.data, fence)) {
    return rejectedPlan(current, "fence-mismatch", "Publication fence is stale or incomplete");
  }
  if (!Number.isInteger(nowSec) || nowSec < parsed.data.selection.updatedAtSec) {
    return rejectedPlan(current, "invalid-time", "Publication time precedes the current manifest");
  }
  return null;
}

function failuresFromAttempts(
  attempts: SafetyScorePublicationRefreshInput["attempts"],
): Partial<Record<SafetyScoreModel, string>> {
  const failures: Partial<Record<SafetyScoreModel, string>> = {};
  for (const model of ["v8", "v9"] as const) {
    const attempt = attempts[model];
    if (attempt?.status === "failed") failures[model] = attempt.reason;
  }
  return failures;
}

function expectedNextFamilyGeneration(family: SafetyScoreModelFamilyPointer | null): number {
  return (family?.familyGeneration ?? 0) + 1;
}

function stateAllowsFamily(state: SafetyScoreModelManifest["state"], family: SafetyScoreModelFamilyPointer): boolean {
  if (family.model !== "v9" || family.identity.model !== "v9") return true;
  if (state === "v9-active-v8-warm") return family.identity.lifecycle === "active";
  if (state === "v8-restored-v9-retained") return family.identity.lifecycle !== "candidate";
  return true;
}

export function planSafetyScorePublicationRefresh(
  input: SafetyScorePublicationRefreshInput,
): SafetyScorePublicationPlan {
  const failures = failuresFromAttempts(input.attempts);
  const preludeFailure = validatePlanningPrelude(input.current, input.fence, input.nowSec);
  if (preludeFailure) return { ...preludeFailure, failures };

  const current = SafetyScorePublicationManifestSchema.parse(input.current);
  const nextFamilies = { ...current.families };
  const familyWrites: SafetyScoreModelFamilyPointer[] = [];

  for (const model of ["v8", "v9"] as const) {
    const attempt = input.attempts[model];
    if (attempt?.status !== "success") continue;
    const parsedFamily = SafetyScoreModelFamilyPointerSchema.safeParse(attempt.family);
    if (!parsedFamily.success || parsedFamily.data.model !== model) {
      return rejectedPlan(
        current,
        "invalid-family",
        `Invalid ${model} family: ${parsedFamily.success ? "model mismatch" : parsedFamily.error.message}`,
        failures,
      );
    }
    const family = parsedFamily.data;
    const previous = familyForModel(current.families, model);
    if (
      family.familyGeneration !== expectedNextFamilyGeneration(previous) ||
      family.generationId === previous?.generationId ||
      family.publishedAtSec < (previous?.publishedAtSec ?? 0)
    ) {
      return rejectedPlan(
        current,
        "generation-not-monotonic",
        `${model} family must advance the exact next generation`,
        failures,
      );
    }
    if (family.publicationEpoch !== current.selection.transitionEpoch) {
      return rejectedPlan(
        current,
        "fence-mismatch",
        `${model} family was produced under a different transition epoch`,
        failures,
      );
    }
    if (family.publishedAtSec > input.nowSec) {
      return rejectedPlan(current, "invalid-time", `${model} family is future-dated`, failures);
    }
    if (!stateAllowsFamily(current.selection.state, family)) {
      return rejectedPlan(
        current,
        "invalid-family",
        `${model} lifecycle is incompatible with ${current.selection.state}`,
        failures,
      );
    }
    nextFamilies[model] = family;
    familyWrites.push(family);
  }

  if (familyWrites.length === 2 && familyWrites[0]!.baseInputGenerationId !== familyWrites[1]!.baseInputGenerationId) {
    return rejectedPlan(
      current,
      "base-generation-mismatch",
      "V8 and V9 refreshes must derive from one exact base input generation",
      failures,
    );
  }

  if (familyWrites.length === 0) {
    return {
      kind: "no-op",
      manifest: current,
      familyWrites: [],
      aliasWrites: [],
      activeAdvanced: false,
      modelSwitched: false,
      failures,
    };
  }

  const successfulActiveFamily = familyWrites.find((family) => family.model === current.selection.activeModel);
  const activeFamily = successfulActiveFamily ?? familyForModel(nextFamilies, current.selection.activeModel);
  if (!activeFamily) {
    return rejectedPlan(current, "target-family-missing", "Active family disappeared", failures);
  }
  const aliases = successfulActiveFamily ? buildActiveAliases(activeFamily) : current.aliases;
  const selection: SafetyScoreModelManifest = {
    ...current.selection,
    activeGenerationId: successfulActiveFamily
      ? successfulActiveFamily.generationId
      : current.selection.activeGenerationId,
    v8GenerationId: nextFamilies.v8?.generationId ?? null,
    v9GenerationId: nextFamilies.v9?.generationId ?? null,
    updatedAtSec: input.nowSec,
  };
  const manifest = SafetyScorePublicationManifestSchema.parse({
    schemaVersion: SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION,
    selection,
    families: nextFamilies,
    aliases,
  });

  return {
    kind: "accepted",
    manifest,
    familyWrites,
    aliasWrites: successfulActiveFamily ? Object.values(aliases) : [],
    activeAdvanced: Boolean(successfulActiveFamily),
    modelSwitched: false,
    failures,
  };
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<SafetyScoreModelManifest["state"], readonly SafetyScoreModelManifest["state"][]>
> = {
  "v8-active-v9-shadow": ["v9-active-v8-warm"],
  "v9-active-v8-warm": ["v8-restored-v9-retained"],
  "v8-restored-v9-retained": ["v9-active-v8-warm"],
};

function activeModelForState(state: SafetyScoreModelManifest["state"]): SafetyScoreModel {
  return state === "v9-active-v8-warm" ? "v9" : "v8";
}

export interface SafetyScorePublicationTransitionInput {
  current: SafetyScorePublicationManifest;
  fence: SafetyScorePublicationFence;
  targetState: SafetyScoreModelManifest["state"];
  nowSec: number;
}

export function planSafetyScorePublicationTransition(
  input: SafetyScorePublicationTransitionInput,
): SafetyScorePublicationPlan {
  const preludeFailure = validatePlanningPrelude(input.current, input.fence, input.nowSec);
  if (preludeFailure) return preludeFailure;

  const current = SafetyScorePublicationManifestSchema.parse(input.current);
  if (!ALLOWED_TRANSITIONS[current.selection.state].includes(input.targetState)) {
    return rejectedPlan(
      current,
      "invalid-state-transition",
      `${current.selection.state} cannot transition to ${input.targetState}`,
    );
  }

  const activeModel = activeModelForState(input.targetState);
  const activeFamily = familyForModel(current.families, activeModel);
  if (!activeFamily) {
    return rejectedPlan(
      current,
      "target-family-missing",
      `No retained ${activeModel} family is available for the transition`,
    );
  }
  if (activeModel === "v9" && (activeFamily.identity.model !== "v9" || activeFamily.identity.lifecycle !== "active")) {
    return rejectedPlan(current, "target-family-not-active", "A candidate or retired V9 family cannot become active");
  }

  const aliases = buildActiveAliases(activeFamily);
  const selection: SafetyScoreModelManifest = {
    ...current.selection,
    state: input.targetState,
    activeModel,
    activeGenerationId: activeFamily.generationId,
    transitionEpoch: current.selection.transitionEpoch + 1,
    updatedAtSec: input.nowSec,
  };
  const manifest = SafetyScorePublicationManifestSchema.parse({
    schemaVersion: SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION,
    selection,
    families: current.families,
    aliases,
  });

  return {
    kind: "accepted",
    manifest,
    familyWrites: [],
    aliasWrites: Object.values(aliases),
    activeAdvanced: false,
    modelSwitched: true,
    failures: {},
  };
}
