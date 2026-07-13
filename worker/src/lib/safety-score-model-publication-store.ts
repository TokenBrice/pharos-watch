import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./cron-lease";
import { executeAtomicBatch } from "./db";
import { getCaches, type CacheEntryWrite } from "./db-cache";
import {
  SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS,
  SAFETY_SCORE_MODEL_CACHE_ARTIFACT_KINDS,
  SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION,
  SafetyScoreModelCacheEnvelopeSchema,
  SafetyScoreModelFamilyPointerSchema,
  SafetyScorePublicationManifestSchema,
  planSafetyScorePublicationRefresh,
  planSafetyScorePublicationTransition,
  safetyScoreModelCacheKey,
  safetyScorePublicationFence,
  validateSafetyScoreModelCacheValue,
  type SafetyScoreModelCacheArtifactKind,
  type SafetyScoreModelCacheEnvelope,
  type SafetyScoreModelFamilyPointer,
  type SafetyScorePublicationFence,
  type SafetyScorePublicationManifest,
} from "./safety-score-model-publication";

export const SAFETY_SCORE_PUBLICATION_STATE_SINGLETON_ID = 1;
export const SAFETY_SCORE_FIXED_INPUT_ACTIVE_ALIAS_CACHE_KEY = "report-cards:fixed-input:exact";

interface SafetyScorePublicationStateRow {
  transition_epoch: number;
  state: string;
  active_model: string;
  active_generation_id: string;
  manifest_json: string;
  manifest_sha256: string;
  updated_at_sec: number;
}

export interface SafetyScoreV8FamilyPayloads {
  full: CacheEntryWrite;
  compact: CacheEntryWrite;
  alert: CacheEntryWrite;
  fixedInput: CacheEntryWrite;
}

export interface PublishSafetyScoreV8FamilyInput {
  db: D1Database;
  generationId: string;
  baseInputGenerationId: string;
  publishedAtSec: number;
  methodologyVersion: string;
  evaluationBuildDigest: string;
  payloads: SafetyScoreV8FamilyPayloads;
  signal?: AbortSignal;
}

export type PublishSafetyScoreV8FamilyResult =
  | {
      status: "published";
      manifest: SafetyScorePublicationManifest;
      family: SafetyScoreModelFamilyPointer;
      activeAliasesAdvanced: boolean;
    }
  | {
      status: "unchanged";
      manifest: SafetyScorePublicationManifest;
      family: SafetyScoreModelFamilyPointer;
      activeAliasesAdvanced: false;
    };

export type SafetyScorePublicationTransitionResult =
  | {
      status: "transitioned";
      manifest: SafetyScorePublicationManifest;
    }
  | {
      status: "blocked";
      reason: "candidate-contract-not-promotable";
      detail: string;
      manifest: SafetyScorePublicationManifest;
    };

export class SafetyScorePublicationStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyScorePublicationStoreConflictError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateV8PayloadKeys(payloads: SafetyScoreV8FamilyPayloads): void {
  const expected = {
    full: SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.full,
    compact: SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.compact,
    alert: SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.alert,
    fixedInput: SAFETY_SCORE_FIXED_INPUT_ACTIVE_ALIAS_CACHE_KEY,
  } as const;
  for (const kind of ["full", "compact", "alert", "fixedInput"] as const) {
    if (payloads[kind].key !== expected[kind]) {
      throw new Error(`Safety Score v8 ${kind} payload must target ${expected[kind]}`);
    }
    try {
      JSON.parse(payloads[kind].value);
    } catch (error) {
      throw new Error(
        `Safety Score v8 ${kind} payload is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function pointerFor(
  model: "v8" | "v9",
  generationId: string,
  artifactKind: SafetyScoreModelCacheArtifactKind,
  payloadDigest: string,
) {
  return {
    artifactKind,
    cacheKey: safetyScoreModelCacheKey(model, artifactKind, generationId),
    payloadDigest,
  };
}

function buildModelCacheEnvelope(args: {
  artifactKind: SafetyScoreModelCacheArtifactKind;
  family: Omit<SafetyScoreModelFamilyPointer, "artifacts">;
  payloadJson: string;
}): SafetyScoreModelCacheEnvelope {
  return SafetyScoreModelCacheEnvelopeSchema.parse({
    schemaVersion: SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION,
    model: args.family.model,
    artifactKind: args.artifactKind,
    generationId: args.family.generationId,
    familyGeneration: args.family.familyGeneration,
    publicationEpoch: args.family.publicationEpoch,
    baseInputGenerationId: args.family.baseInputGenerationId,
    publishedAtSec: args.family.publishedAtSec,
    identity: args.family.identity,
    payloadDigest: sha256Hex(args.payloadJson),
    payloadJson: args.payloadJson,
  });
}

export function buildSafetyScoreV8ModelFamily(args: {
  generationId: string;
  baseInputGenerationId: string;
  publishedAtSec: number;
  methodologyVersion: string;
  evaluationBuildDigest: string;
  familyGeneration: number;
  publicationEpoch: number;
  payloads: SafetyScoreV8FamilyPayloads;
}): { family: SafetyScoreModelFamilyPointer; envelopes: SafetyScoreModelCacheEnvelope[] } {
  validateV8PayloadKeys(args.payloads);
  const familyBase = {
    model: "v8" as const,
    generationId: args.generationId,
    familyGeneration: args.familyGeneration,
    publicationEpoch: args.publicationEpoch,
    baseInputGenerationId: args.baseInputGenerationId,
    publishedAtSec: args.publishedAtSec,
    identity: {
      model: "v8" as const,
      methodologyVersion: args.methodologyVersion,
      evaluationBuildDigest: args.evaluationBuildDigest,
      policyDigest: null,
    },
  };
  const payloadByKind: Record<SafetyScoreModelCacheArtifactKind, string> = {
    full: args.payloads.full.value,
    compact: args.payloads.compact.value,
    alert: args.payloads.alert.value,
    "fixed-input": args.payloads.fixedInput.value,
  };
  const envelopes = SAFETY_SCORE_MODEL_CACHE_ARTIFACT_KINDS.map((artifactKind) =>
    buildModelCacheEnvelope({ artifactKind, family: familyBase, payloadJson: payloadByKind[artifactKind] }),
  );
  const envelopeByKind = new Map(envelopes.map((envelope) => [envelope.artifactKind, envelope]));
  const family = SafetyScoreModelFamilyPointerSchema.parse({
    ...familyBase,
    artifacts: {
      full: pointerFor("v8", args.generationId, "full", envelopeByKind.get("full")!.payloadDigest),
      compact: pointerFor("v8", args.generationId, "compact", envelopeByKind.get("compact")!.payloadDigest),
      alert: pointerFor("v8", args.generationId, "alert", envelopeByKind.get("alert")!.payloadDigest),
      fixedInput: pointerFor(
        "v8",
        args.generationId,
        "fixed-input",
        envelopeByKind.get("fixed-input")!.payloadDigest,
      ),
    },
  });
  for (const envelope of envelopes) {
    const result = validateSafetyScoreModelCacheValue(stableJsonStringifyV1(envelope), family);
    if (!result.ok) {
      throw new Error(`Invalid retained v8 ${envelope.artifactKind} family payload: ${result.reason}: ${result.detail}`);
    }
  }
  return { family, envelopes };
}

function initialManifest(family: SafetyScoreModelFamilyPointer): SafetyScorePublicationManifest {
  return SafetyScorePublicationManifestSchema.parse({
    schemaVersion: SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION,
    selection: {
      schemaVersion: SAFETY_SCORE_MODEL_PUBLICATION_SCHEMA_VERSION,
      state: "v8-active-v9-shadow",
      activeModel: "v8",
      activeGenerationId: family.generationId,
      v8GenerationId: family.generationId,
      v9GenerationId: null,
      transitionEpoch: family.publicationEpoch,
      updatedAtSec: family.publishedAtSec,
    },
    families: { v8: family, v9: null },
    aliases: {
      full: {
        aliasKind: "full",
        aliasCacheKey: SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.full,
        targetCacheKey: family.artifacts.full.cacheKey,
        model: "v8",
        generationId: family.generationId,
        familyGeneration: family.familyGeneration,
        payloadDigest: family.artifacts.full.payloadDigest,
      },
      compact: {
        aliasKind: "compact",
        aliasCacheKey: SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.compact,
        targetCacheKey: family.artifacts.compact.cacheKey,
        model: "v8",
        generationId: family.generationId,
        familyGeneration: family.familyGeneration,
        payloadDigest: family.artifacts.compact.payloadDigest,
      },
      alert: {
        aliasKind: "alert",
        aliasCacheKey: SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.alert,
        targetCacheKey: family.artifacts.alert.cacheKey,
        model: "v8",
        generationId: family.generationId,
        familyGeneration: family.familyGeneration,
        payloadDigest: family.artifacts.alert.payloadDigest,
      },
    },
  });
}

function manifestJson(manifest: SafetyScorePublicationManifest): string {
  return stableJsonStringifyV1(SafetyScorePublicationManifestSchema.parse(manifest));
}

function parseStateRow(row: SafetyScorePublicationStateRow): SafetyScorePublicationManifest {
  if (sha256Hex(row.manifest_json) !== row.manifest_sha256) {
    throw new Error("Safety Score publication manifest checksum mismatch");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.manifest_json);
  } catch (error) {
    throw new Error(
      `Safety Score publication manifest JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = SafetyScorePublicationManifestSchema.parse(decoded);
  if (
    row.transition_epoch !== manifest.selection.transitionEpoch ||
    row.state !== manifest.selection.state ||
    row.active_model !== manifest.selection.activeModel ||
    row.active_generation_id !== manifest.selection.activeGenerationId ||
    row.updated_at_sec !== manifest.selection.updatedAtSec
  ) {
    throw new Error("Safety Score publication state projection does not match its manifest");
  }
  return manifest;
}

export async function loadSafetyScorePublicationManifest(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScorePublicationManifest | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT transition_epoch, state, active_model, active_generation_id,
                  manifest_json, manifest_sha256, updated_at_sec
           FROM safety_score_publication_state
           WHERE singleton_id = ?`,
        )
        .bind(SAFETY_SCORE_PUBLICATION_STATE_SINGLETON_ID)
        .first<SafetyScorePublicationStateRow>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return row ? parseStateRow(row) : null;
}

function prepareImmutableModelEnvelopeWrite(
  db: D1Database,
  envelope: SafetyScoreModelCacheEnvelope,
): D1PreparedStatement {
  const value = stableJsonStringifyV1(envelope);
  return db
    .prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CASE WHEN cache.value = excluded.value THEN cache.value ELSE NULL END,
         updated_at = MAX(cache.updated_at, excluded.updated_at)`,
    )
    .bind(
      safetyScoreModelCacheKey(envelope.model, envelope.artifactKind, envelope.generationId),
      value,
      envelope.publishedAtSec,
    );
}

function prepareFencedAliasWrite(
  db: D1Database,
  entry: CacheEntryWrite,
  updatedAtSec: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CASE WHEN cache.updated_at <= excluded.updated_at THEN excluded.value ELSE NULL END,
         updated_at = excluded.updated_at`,
    )
    .bind(entry.key, entry.value, updatedAtSec);
}

function prepareStateWrite(
  db: D1Database,
  current: SafetyScorePublicationManifest | null,
  next: SafetyScorePublicationManifest,
): D1PreparedStatement {
  const nextJson = manifestJson(next);
  const nextDigest = sha256Hex(nextJson);
  if (current === null) {
    return db
      .prepare(
        `INSERT INTO safety_score_publication_state
         (singleton_id, transition_epoch, state, active_model, active_generation_id,
          manifest_json, manifest_sha256, updated_at_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        SAFETY_SCORE_PUBLICATION_STATE_SINGLETON_ID,
        next.selection.transitionEpoch,
        next.selection.state,
        next.selection.activeModel,
        next.selection.activeGenerationId,
        nextJson,
        nextDigest,
        next.selection.updatedAtSec,
      );
  }
  const currentJson = manifestJson(current);
  return db
    .prepare(
      `UPDATE safety_score_publication_state SET
         transition_epoch = ?,
         state = ?,
         active_model = ?,
         active_generation_id = ?,
         manifest_json = CASE
           WHEN transition_epoch = ? AND manifest_sha256 = ? THEN ?
           ELSE NULL
         END,
         manifest_sha256 = ?,
         updated_at_sec = ?
       WHERE singleton_id = ?`,
    )
    .bind(
      next.selection.transitionEpoch,
      next.selection.state,
      next.selection.activeModel,
      next.selection.activeGenerationId,
      current.selection.transitionEpoch,
      sha256Hex(currentJson),
      nextJson,
      nextDigest,
      next.selection.updatedAtSec,
      SAFETY_SCORE_PUBLICATION_STATE_SINGLETON_ID,
    );
}

function aliasPayloadEntries(payloads: SafetyScoreV8FamilyPayloads): CacheEntryWrite[] {
  return [payloads.full, payloads.compact, payloads.alert, payloads.fixedInput];
}

export async function publishSafetyScoreV8ModelFamily(
  input: PublishSafetyScoreV8FamilyInput,
): Promise<PublishSafetyScoreV8FamilyResult> {
  throwIfAborted(input.signal);
  const current = await loadSafetyScorePublicationManifest(input.db, input.signal);
  if (current?.families.v8?.generationId === input.generationId) {
    const family = current.families.v8;
    if (
      family.baseInputGenerationId !== input.baseInputGenerationId ||
      family.identity.model !== "v8" ||
      family.identity.methodologyVersion !== input.methodologyVersion ||
      family.identity.evaluationBuildDigest !== input.evaluationBuildDigest
    ) {
      throw new SafetyScorePublicationStoreConflictError(
        `Retained v8 generation ${input.generationId} has a different identity`,
      );
    }
    return { status: "unchanged", manifest: current, family, activeAliasesAdvanced: false };
  }
  const built = buildSafetyScoreV8ModelFamily({
    generationId: input.generationId,
    baseInputGenerationId: input.baseInputGenerationId,
    publishedAtSec: input.publishedAtSec,
    methodologyVersion: input.methodologyVersion,
    evaluationBuildDigest: input.evaluationBuildDigest,
    familyGeneration: (current?.families.v8?.familyGeneration ?? 0) + 1,
    publicationEpoch: current?.selection.transitionEpoch ?? 0,
    payloads: input.payloads,
  });
  let next: SafetyScorePublicationManifest;
  let activeAliasesAdvanced: boolean;
  if (current === null) {
    next = initialManifest(built.family);
    activeAliasesAdvanced = true;
  } else {
    const plan = planSafetyScorePublicationRefresh({
      current,
      fence: safetyScorePublicationFence(current),
      nowSec: input.publishedAtSec,
      attempts: { v8: { status: "success", family: built.family } },
    });
    if (plan.kind === "rejected") {
      throw new SafetyScorePublicationStoreConflictError(`${plan.reason}: ${plan.detail}`);
    }
    if (plan.kind === "no-op") {
      throw new SafetyScorePublicationStoreConflictError("V8 family refresh unexpectedly produced no write");
    }
    next = plan.manifest;
    activeAliasesAdvanced = plan.activeAdvanced;
  }

  const statements = built.envelopes.map((envelope) => prepareImmutableModelEnvelopeWrite(input.db, envelope));
  if (activeAliasesAdvanced) {
    statements.push(
      ...aliasPayloadEntries(input.payloads).map((entry) =>
        prepareFencedAliasWrite(input.db, entry, input.publishedAtSec),
      ),
    );
  }
  statements.push(prepareStateWrite(input.db, current, next));
  await executeAtomicBatch(input.db, statements, { signal: input.signal });
  const persisted = await loadSafetyScorePublicationManifest(input.db, input.signal);
  if (persisted === null || manifestJson(persisted) !== manifestJson(next)) {
    throw new SafetyScorePublicationStoreConflictError("Safety Score publication state did not persist exactly");
  }
  return { status: "published", manifest: persisted, family: built.family, activeAliasesAdvanced };
}

async function loadFamilyAliasPayloads(
  db: D1Database,
  family: SafetyScoreModelFamilyPointer,
  signal?: AbortSignal,
): Promise<CacheEntryWrite[]> {
  throwIfAborted(signal);
  const pointers = [
    ["full", SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.full, family.artifacts.full],
    ["compact", SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.compact, family.artifacts.compact],
    ["alert", SAFETY_SCORE_ACTIVE_ALIAS_CACHE_KEYS.alert, family.artifacts.alert],
    ["fixed-input", SAFETY_SCORE_FIXED_INPUT_ACTIVE_ALIAS_CACHE_KEY, family.artifacts.fixedInput],
  ] as const;
  const rows = await getCaches(
    db,
    pointers.map(([, , pointer]) => pointer.cacheKey),
  );
  throwIfAborted(signal);
  return pointers.map(([artifactKind, aliasKey, pointer]) => {
    const row = rows.get(pointer.cacheKey);
    if (!row) throw new Error(`Retained ${family.model} ${artifactKind} family payload is missing`);
    const validated = validateSafetyScoreModelCacheValue(row.value, family);
    if (!validated.ok || validated.envelope.artifactKind !== artifactKind) {
      throw new Error(
        `Retained ${family.model} ${artifactKind} family payload is invalid: ${
          validated.ok ? "artifact kind mismatch" : `${validated.reason}: ${validated.detail}`
        }`,
      );
    }
    return { key: aliasKey, value: validated.envelope.payloadJson };
  });
}

/**
 * Applies only a fenced rollback/restoration today. Candidate V9 is
 * intentionally non-promotable until an active 9.0 public contract and its
 * release authorization bundle exist.
 */
export async function transitionSafetyScorePublicationState(input: {
  db: D1Database;
  fence: SafetyScorePublicationFence;
  targetState: SafetyScorePublicationManifest["selection"]["state"];
  nowSec: number;
  signal?: AbortSignal;
}): Promise<SafetyScorePublicationTransitionResult> {
  const current = await loadSafetyScorePublicationManifest(input.db, input.signal);
  if (current === null) throw new Error("Safety Score publication state is not initialized");
  if (input.targetState === "v9-active-v8-warm") {
    return {
      status: "blocked",
      reason: "candidate-contract-not-promotable",
      detail: "The checked-in V9 public schema is candidate-only; activation requires the frozen 9.0 contract and release gates",
      manifest: current,
    };
  }
  const plan = planSafetyScorePublicationTransition({
    current,
    fence: input.fence,
    targetState: input.targetState,
    nowSec: input.nowSec,
  });
  if (plan.kind !== "accepted") {
    throw new SafetyScorePublicationStoreConflictError(
      plan.kind === "rejected" ? `${plan.reason}: ${plan.detail}` : "Publication transition produced no write",
    );
  }
  const family = plan.manifest.families[plan.manifest.selection.activeModel];
  if (!family) throw new Error("Publication transition target family is unavailable");
  const aliasPayloads = await loadFamilyAliasPayloads(input.db, family, input.signal);
  const statements = aliasPayloads
    .sort((left, right) => compareText(left.key, right.key))
    .map((entry) => prepareFencedAliasWrite(input.db, entry, input.nowSec));
  statements.push(prepareStateWrite(input.db, current, plan.manifest));
  await executeAtomicBatch(input.db, statements, { signal: input.signal });
  const persisted = await loadSafetyScorePublicationManifest(input.db, input.signal);
  if (persisted === null || manifestJson(persisted) !== manifestJson(plan.manifest)) {
    throw new SafetyScorePublicationStoreConflictError("Safety Score transition did not persist exactly");
  }
  return { status: "transitioned", manifest: persisted };
}
