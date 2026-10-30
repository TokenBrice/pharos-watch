import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import {
  deploymentSupplyCensusMaxAgeSec,
  SafetyScoreV9DeploymentSupplyCensusByIdSchema,
  type SafetyScoreV9DeploymentSupplyCensusById,
  type SafetyScoreV9DeploymentSupplyCensusBinding,
  type V9DeploymentSupplyCensusRejectionReason,
} from "@shared/types/safety-score-v9-deployment-supply-census";
import {
  BaseInputGenerationIdSchema,
  Sha256Schema,
  UnixSecondsSchema,
  issue,
} from "@shared/types/safety-schema-primitives";
import { z } from "zod";
import { throwIfAborted } from "../abort";
import { createCanonicalGenerationCodec } from "../canonical-generation-codec";
import { getCache, setCacheIfNewer } from "../db-cache";

/**
 * Durable store for one `deployment-supply-census-v1` generation (plan §4.6
 * Interfaces, design §3.3).
 *
 * The generation is the current row of a new `cache` key family (no migration;
 * the table is already the generation transport for transfer materiality and
 * supply attribution), mirrored from the transfer-materiality generation: the
 * whole cohort travels in one ≤1 MiB, content-addressed value bound to the
 * base-input generation, registry fingerprint and capture clock. Every read
 * re-verifies the canonical `generationId`, so a hand-edited row is rejected
 * rather than served.
 *
 * Staleness (R3). Every stored bound keeps its pinned block/ledger and its
 * packet's `observedAtSec`. A read never carries a bound forward or re-dates
 * it: packets older than the per-source chain-supply ceiling are returned as
 * exclusions, missing generations stay missing, and a malformed row is
 * `invalid`, never an empty (zero) census.
 */

export const SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_GENERATION_CACHE_KEY =
  "safety-score-v9:deployment-supply-census-generation:v1";

/** Stored-generation cap; the whole cohort shares this one cache row. */
export const SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_GENERATION_MAX_BYTES = 1_024 * 1_024;

const supplyAttributionPolicy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;

/**
 * A stored bound ages against the per-source chain-supply ceiling (plan §4.6
 * Interfaces), read through the one shared accessor the consumer also uses.
 */
export const SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC =
  deploymentSupplyCensusMaxAgeSec();

const GenerationPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-deployment-supply-census-generation"),
    sourceBaseInputGenerationId: BaseInputGenerationIdSchema,
    registryFingerprint: Sha256Schema,
    capturedAtSec: UnixSecondsSchema,
    censusById: SafetyScoreV9DeploymentSupplyCensusByIdSchema,
  })
  .strict()
  .superRefine((generation, ctx) => {
    for (const [assetId, packet] of Object.entries(generation.censusById)) {
      // A generation is a capture, not a carrier: a bound observed before the
      // generation clock by more than the census window is already stale and
      // must not be re-dated into a new generation.
      if (packet.observedAtSec > generation.capturedAtSec) {
        issue(ctx, ["censusById", assetId, "observedAtSec"], "A census packet cannot postdate its generation");
      } else if (generation.capturedAtSec - packet.observedAtSec > supplyAttributionPolicy.observationMaxAgeSec) {
        issue(
          ctx,
          ["censusById", assetId, "observedAtSec"],
          `A census packet older than ${supplyAttributionPolicy.observationMaxAgeSec} s cannot enter a new generation`,
        );
      }
    }
  });

const generationCodec = createCanonicalGenerationCodec({
  payloadSchema: GenerationPayloadSchema,
  generationIdSchema: z.string().regex(/^safety-score-v9-deployment-supply-census:v1:[a-f0-9]{64}$/),
  generationIdPrefix: "safety-score-v9-deployment-supply-census:v1:",
  digestPayload: (payload) => ({
    domain: "safety-score-v9.deployment-supply-census-generation.v1",
    payload,
  }),
  mismatchMessage: "Deployment supply census generation ID does not match its canonical payload",
  maxBytes: {
    limit: SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_GENERATION_MAX_BYTES,
    schemaMessage:
      `Deployment supply census generation exceeds ${SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_GENERATION_MAX_BYTES} bytes`,
    inputMessage: "Deployment supply census generation cache value is oversized",
  },
  validateSerialization: true,
});

export type SafetyScoreV9DeploymentSupplyCensusGeneration = z.infer<
  typeof generationCodec.schema
>;

export const createSafetyScoreV9DeploymentSupplyCensusGeneration = generationCodec.create;
export const serializeSafetyScoreV9DeploymentSupplyCensusGeneration = generationCodec.serialize;

export interface SafetyScoreV9DeploymentSupplyCensusWriteResult {
  generationId: string;
  capturedAtSec: number;
  assetIds: readonly string[];
  storedBytes: number;
  /** False when a generation at or after `capturedAtSec` already occupied the row. */
  written: boolean;
  skippedBecauseNewer: boolean;
}

/**
 * The two keys the attribution generation spreads into the fixed input
 * (`safetyScoreV9DeploymentSupplyCensusById` + `...Binding`). They always travel
 * together: the consumer rejects a map alone as `generation-unbound`, and a
 * binding naming another registry/base input as `generation-mismatch`.
 */
export interface SafetyScoreV9DeploymentSupplyCensusCarry {
  readonly byId: SafetyScoreV9DeploymentSupplyCensusById;
  readonly binding: SafetyScoreV9DeploymentSupplyCensusBinding;
}

/**
 * Carries a stored generation only when its identity names *this* compiler
 * input. Anything else (missing, foreign registry, another prepare cycle, no
 * packets) carries nothing at all — never half of it.
 */
export function safetyScoreV9DeploymentSupplyCensusCarry(input: {
  readonly byId: SafetyScoreV9DeploymentSupplyCensusById;
  readonly generationId: string | null;
  readonly registryFingerprint: string | null;
  readonly sourceBaseInputGenerationId: string | null;
  readonly expected: {
    readonly registryFingerprint: string;
    readonly baseInputGenerationId: string;
  };
}): SafetyScoreV9DeploymentSupplyCensusCarry | null {
  const { byId, generationId, registryFingerprint, sourceBaseInputGenerationId, expected } = input;
  if (generationId === null) return null;
  if (registryFingerprint === null || registryFingerprint !== expected.registryFingerprint) return null;
  if (sourceBaseInputGenerationId === null ||
    sourceBaseInputGenerationId !== expected.baseInputGenerationId) return null;
  if (Object.keys(byId).length === 0) return null;
  return { byId, binding: { generationId, registryFingerprint, sourceBaseInputGenerationId } };
}

/**
 * Persists the newest cohort generation. An older producer clock can never
 * overwrite a newer generation (`if-newer`), so a slow cron run cannot regress
 * the store.
 */
export async function writeSafetyScoreV9DeploymentSupplyCensusGeneration(
  db: D1Database,
  generation: SafetyScoreV9DeploymentSupplyCensusGeneration,
  signal?: AbortSignal,
): Promise<SafetyScoreV9DeploymentSupplyCensusWriteResult> {
  throwIfAborted(signal);
  const value = serializeSafetyScoreV9DeploymentSupplyCensusGeneration(generation);
  const { written, skippedBecauseNewer } = await setCacheIfNewer(
    db,
    SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_GENERATION_CACHE_KEY,
    value,
    generation.capturedAtSec,
    signal,
  );
  return {
    generationId: generation.generationId,
    capturedAtSec: generation.capturedAtSec,
    assetIds: Object.keys(generation.censusById).sort(compareText),
    storedBytes: new TextEncoder().encode(value).byteLength,
    written,
    skippedBecauseNewer,
  };
}

/**
 * Why one stored packet was not served. Both reasons are the census rejection
 * vocabulary so a caller can publish them as `census-rejected:<reason>`.
 */
export interface SafetyScoreV9DeploymentSupplyCensusExclusion {
  assetId: string;
  reason: Extract<V9DeploymentSupplyCensusRejectionReason, "future-dated-pin" | "observation-stale">;
}

export interface SafetyScoreV9DeploymentSupplyCensusReadResult {
  /** `invalid` means the stored row failed its content-addressed parse: never treat it as empty. */
  state: "ok" | "missing" | "invalid";
  generationId: string | null;
  capturedAtSec: number | null;
  /** The registry the generation measured; `null` when no valid generation was served. */
  registryFingerprint: string | null;
  /** The compiler base input generation the census was built against. */
  sourceBaseInputGenerationId: string | null;
  maxAgeSec: number;
  byId: SafetyScoreV9DeploymentSupplyCensusById;
  excluded: readonly SafetyScoreV9DeploymentSupplyCensusExclusion[];
}

/**
 * Serves the bound projection at `clockSec`. Expired packets are omitted (and
 * named in `excluded`) instead of being re-dated; an absent row is `missing`,
 * not an empty census. A D1 read failure throws (unavailable), so it can never
 * look like a missing generation.
 */
export async function readSafetyScoreV9DeploymentSupplyCensus(
  db: D1Database,
  options: { clockSec: number; signal?: AbortSignal },
): Promise<SafetyScoreV9DeploymentSupplyCensusReadResult> {
  const { clockSec, signal } = options;
  if (!Number.isSafeInteger(clockSec) || clockSec < 0) {
    throw new Error("Deployment supply census read requires a nonnegative integer clock");
  }
  throwIfAborted(signal);
  const cached = await getCache(db, SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_GENERATION_CACHE_KEY, signal);
  const unavailable = (state: "missing" | "invalid"): SafetyScoreV9DeploymentSupplyCensusReadResult => ({
    state,
    generationId: null,
    capturedAtSec: null,
    registryFingerprint: null,
    sourceBaseInputGenerationId: null,
    maxAgeSec: SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC,
    byId: {},
    excluded: [],
  });
  if (!cached) return unavailable("missing");

  let generation: SafetyScoreV9DeploymentSupplyCensusGeneration;
  try {
    generation = generationCodec.parse(cached.value);
  } catch {
    return unavailable("invalid");
  }

  const byId: SafetyScoreV9DeploymentSupplyCensusById = {};
  const excluded: SafetyScoreV9DeploymentSupplyCensusExclusion[] = [];
  for (const assetId of Object.keys(generation.censusById).sort(compareText)) {
    const packet = generation.censusById[assetId]!;
    const ageSec = clockSec - packet.observedAtSec;
    if (ageSec < 0) {
      excluded.push({ assetId, reason: "future-dated-pin" });
    } else if (ageSec > SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC) {
      excluded.push({ assetId, reason: "observation-stale" });
    } else {
      byId[assetId] = packet;
    }
  }
  return {
    state: "ok",
    generationId: generation.generationId,
    capturedAtSec: generation.capturedAtSec,
    registryFingerprint: generation.registryFingerprint,
    sourceBaseInputGenerationId: generation.sourceBaseInputGenerationId,
    maxAgeSec: SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC,
    byId,
    excluded,
  };
}
