import { z } from "zod";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { REPORT_CARDS_BASE_INPUT_GENERATION_ID_PREFIX } from "@shared/lib/report-cards-base-input-identity";
import {
  FixedDexLiquidityRowSchema,
  ReportCardsFixedInputMethodologyVersionsSchema,
  computeRedemptionPayloadFingerprint,
  normalizeFixedInputExitRouteObservations,
  normalizeFixedRedemptionBackstopMap,
  normalizeReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import { sha256Hex } from "@shared/lib/sha256";
import {
  SafetyScoreV9InputIdentitySchema,
  type SafetyScoreV9InputIdentity,
} from "@shared/types/safety-score-publication";
import { BaseInputGenerationIdSchema, Sha256Schema } from "@shared/types/safety-schema-primitives";
import {
  normalizeFixedInput,
  parseReportCardsFixedInputCacheValue,
} from "./report-cards-fixed-input";
import {
  assertCommonFixedInputConsistency,
  createFixedInputPayloadFields,
  normalizeCommonFixedInputRecords,
  sortedRecord,
} from "./report-cards-fixed-input-contract";
import {
  buildFixedInputCacheEntry,
  FixedInputCacheEnvelopeFields,
  parseFixedInputCacheEntry,
  REPORT_CARDS_FIXED_INPUT_CACHE_KEY,
} from "./report-cards-fixed-input-cache-codec";
import { V9PublicationInputHealthSchema } from "./safety-score-v9-publication-assessment";
import { parseJson } from "./json-parse";

/**
 * DEX liquidity row as the native V9 capture carries it. The V8 report-card
 * projection needed the full producer row (scores, HHI, coverage counts, TVL);
 * the V9 compiler reads exactly these three fields, so nothing else enters a
 * score-bearing capture. Field schemas are copied verbatim from
 * `FixedDexLiquidityRowSchema` so a v3 row stays structurally assignable.
 */
export const NativeDexLiquidityRowSchema = z
  .object({
    exitRouteObservations: FixedDexLiquidityRowSchema.shape.exitRouteObservations,
    exitRouteObservationCoverage: FixedDexLiquidityRowSchema.shape.exitRouteObservationCoverage,
    updatedAt: FixedDexLiquidityRowSchema.shape.updatedAt,
  })
  .strict()
  .superRefine((row, ctx) => {
    // Zod cannot pick from a refined object schema. Supply neutral values for
    // the V3-only fields so the canonical shared row owns the common coverage
    // refinement while the native schema still admits only its narrow fields.
    const canonical = FixedDexLiquidityRowSchema.safeParse({
      liquidityScore: null,
      concentrationHhi: null,
      poolCount: 0,
      chainCount: 0,
      ...row,
    });
    if (!canonical.success) {
      for (const issue of canonical.error.issues) ctx.addIssue(issue);
    }
  });

export type NativeDexLiquidityRow = z.infer<typeof NativeDexLiquidityRowSchema>;

const NativeChainCirculatingRowSchema = z
  .object({
    // Only the current USD bucket is score-bearing. The prev-day/week/month
    // buckets exist for the market table's deltas and never reach the V9
    // compiler, so they are not admissible capture bytes.
    current: z.number().finite().nonnegative(),
  })
  .strict();

const NativeSafetyScoreV9InputPayloadFields = createFixedInputPayloadFields({
  publicationHealthSchema: V9PublicationInputHealthSchema,
  afterRedemptionBackstopMap: {},
  chainCirculatingByIdSchema: z
    .record(z.string(), z.record(z.string(), NativeChainCirculatingRowSchema))
    .default({}),
  beforeLiveToFallbackCoins: {},
});

/**
 * Schema v4: the native Safety Score V9 input. Everything the V8 report-card
 * projection needed and the V9 compiler does not read is gone — `bluechipMap`,
 * `resolvedBlacklistStatuses`, `collateralDriftCoins`, the non-current chain
 * circulating buckets, and every DEX row field outside the exit-route
 * observations.
 */
export const NativeSafetyScoreV9InputSchema = z
  .object({
    schemaVersion: z.literal(4),
    captureKind: z.literal("native-v9-inputs"),
    ...NativeSafetyScoreV9InputPayloadFields,
    activeAssetIds: z.array(z.string().min(1)),
    dexGenerationId: z.string().min(1),
    redemptionGenerationId: z.string().min(1),
    dexPayloadFingerprint: Sha256Schema,
    redemptionPayloadFingerprint: Sha256Schema,
    registryFingerprint: Sha256Schema,
    inputMethodologyVersions: ReportCardsFixedInputMethodologyVersionsSchema,
    dexLiqMap: z.record(z.string(), NativeDexLiquidityRowSchema),
    baseInputGenerationId: BaseInputGenerationIdSchema,
  })
  .strict();

export type NativeSafetyScoreV9Input = z.infer<typeof NativeSafetyScoreV9InputSchema>;

/**
 * The structural input the V9 compiler accepts. The native v4 capture is the
 * production shape; the retained v3 exact fixed input is structurally a
 * superset of it and stays admissible so frozen v3 captures keep replaying
 * byte-for-byte through the same pipeline.
 */
export type SafetyScoreV9CompilerInput = Omit<
  NativeSafetyScoreV9Input,
  "schemaVersion" | "captureKind"
> & {
  schemaVersion: 3 | 4;
  captureKind: "exact-publication-inputs" | "public-reconstruction" | "native-v9-inputs";
};

// Same D1 row key as the retained replay lane; only the envelope version differs.
export const NATIVE_V9_INPUT_CACHE_KEY = REPORT_CARDS_FIXED_INPUT_CACHE_KEY;

// The prefix is a published format namespace (public fact-set schemas, OpenAPI,
// the publication codec, and the `safety_score_history_v2` CHECK all pin it),
// not a projection version — see `SafetyScoreV9InputIdentitySchema`. Both lanes
// share one literal; this is the native alias for it.
export const NATIVE_V9_BASE_INPUT_GENERATION_ID_PREFIX = REPORT_CARDS_BASE_INPUT_GENERATION_ID_PREFIX;
const NATIVE_V9_BASE_INPUT_DIGEST_DOMAIN = "report-cards.native-v9-base-input.v2";

/**
 * Envelope v2. Same transport as v1 (gzip + base64 + payload checksum), but the
 * capture identity is required and is the native `v9-input` identity: a v2
 * envelope can never carry an unidentified or a V8-shaped capture.
 */
const NativeV9InputCacheEnvelopeSchema = z.object({
  schemaVersion: z.literal(2),
  ...FixedInputCacheEnvelopeFields,
  safetyScoreIdentity: SafetyScoreV9InputIdentitySchema,
});

/** Fields excluded from the v2 base-input digest. */
type NativeV9BaseInputDigestSource = Omit<
  NativeSafetyScoreV9Input,
  "baseInputGenerationId"
> & { baseInputGenerationId?: string };

/**
 * `report-cards-input:v1:<sha256>` over the canonicalized payload minus the
 * generation id itself and minus every V9-enrichment field.
 *
 * The digest domain (`report-cards.native-v9-base-input.v2`) is what separates
 * this projection from the v1 lane's structured projection; the id prefix is a
 * format namespace shared by both and cannot collide, since both sides are
 * sha256 over their own canonical content.
 *
 * The four enrichment fields are excluded for the same reason the v1 lane
 * excluded them: the compute cron layers supply attribution, both journals, and
 * the peg-provenance seed onto the accepted capture, and the runner then proves
 * the base input did not move. If enrichment shifted the digest that proof
 * could never hold.
 */
export function deriveNativeV9BaseInputGenerationId(input: NativeV9BaseInputDigestSource): string {
  const {
    baseInputGenerationId: _generationId,
    safetyScoreV9SupplyAttributionById: _supplyAttribution,
    evidenceJournalById: _evidenceJournal,
    supplyAttributionJournalById: _supplyAttributionJournal,
    pegProvenanceById: _pegProvenance,
    ...baseInput
  } = input;
  const digest = sha256Hex(
    stableJsonStringifyV1({ domain: NATIVE_V9_BASE_INPUT_DIGEST_DOMAIN, payload: baseInput }),
  );
  return `${NATIVE_V9_BASE_INPUT_GENERATION_ID_PREFIX}${digest}`;
}

const NATIVE_V9_DEX_PAYLOAD_DIGEST_DOMAIN = "safety-score-v9.native-input.dex-payload.v1";

function normalizeNativeDexLiquidityMap(
  record: Record<string, NativeDexLiquidityRow>,
): Record<string, NativeDexLiquidityRow> {
  return sortedRecord(
    Object.fromEntries(
      Object.entries(record).map(([id, row]) => [
        id,
        {
          ...row,
          ...(row.exitRouteObservations !== undefined
            ? { exitRouteObservations: normalizeFixedInputExitRouteObservations(row.exitRouteObservations) }
            : {}),
        },
      ]),
    ),
  );
}

/**
 * Payload fingerprint over the native DEX rows. It cannot reuse the v3 helper:
 * that one re-parses every row through `FixedDexLiquidityRowSchema`, which
 * still requires the V8 scoring fields the native capture drops.
 */
export function computeNativeDexLiquidityPayloadFingerprint(
  dexLiqMap: Record<string, NativeDexLiquidityRow>,
  dexGenerationId: string,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: NATIVE_V9_DEX_PAYLOAD_DIGEST_DOMAIN,
      dexGenerationId,
      dexLiqMap: normalizeNativeDexLiquidityMap(dexLiqMap),
    }),
  );
}

function assertNativeV9InputConsistency(
  input: NativeSafetyScoreV9Input,
  options: { verifyBaseInputGenerationId: boolean } = { verifyBaseInputGenerationId: true },
): void {
  assertCommonFixedInputConsistency(input, {
    phase: "identity",
    laneLabel: "Native V9 input",
    exactLabel: "Native V9 input",
    requireProducerBindings: true,
    validateNavPriceIds: true,
    dexActiveRowsLabel: "Native V9 input DEX active rows",
  });

  const currentDexPayloadFingerprint = computeNativeDexLiquidityPayloadFingerprint(
    input.dexLiqMap,
    input.dexGenerationId,
  );
  if (input.dexPayloadFingerprint !== currentDexPayloadFingerprint) {
    throw new Error(
      `Native V9 input DEX payload fingerprint ${input.dexPayloadFingerprint} does not match payload ${currentDexPayloadFingerprint}`,
    );
  }
  const currentRedemptionPayloadFingerprint = computeRedemptionPayloadFingerprint(
    input.redemptionBackstopMap,
    input.redemptionGenerationId,
  );
  if (input.redemptionPayloadFingerprint !== currentRedemptionPayloadFingerprint) {
    throw new Error(
      `Native V9 input redemption payload fingerprint ${input.redemptionPayloadFingerprint} does not match payload ${currentRedemptionPayloadFingerprint}`,
    );
  }
  assertCommonFixedInputConsistency(input, {
    phase: "evidence",
    laneLabel: "Native V9 input",
    exactLabel: "Native V9 input",
    requireProducerBindings: true,
    validateNavPriceIds: false,
  });

  // Integrity gate: a *supplied* base generation id must match the payload it
  // claims to identify. Skipped only when this same call just derived the id
  // from the identical payload, where the comparison is true by construction.
  if (options.verifyBaseInputGenerationId) {
    const expectedBaseInputGenerationId = deriveNativeV9BaseInputGenerationId(input);
    if (input.baseInputGenerationId !== expectedBaseInputGenerationId) {
      throw new Error(
        `Native V9 input base generation ${input.baseInputGenerationId} does not match payload ${expectedBaseInputGenerationId}`,
      );
    }
  }
  assertCommonFixedInputConsistency(input, {
    phase: "freshness",
    laneLabel: "Native V9 input",
    exactLabel: "Native V9 input",
    requireProducerBindings: true,
    validateNavPriceIds: false,
  });
}

/**
 * The intake shape: the full native input with an optional base generation id,
 * so a capture may either carry its identity (verified below) or have it derived
 * here. Hoisted to module scope — deriving it per call rebuilt the whole Zod
 * object graph on every publication cycle.
 */
const NativeSafetyScoreV9InputIntakeSchema = NativeSafetyScoreV9InputSchema.omit({
  baseInputGenerationId: true,
}).extend({ baseInputGenerationId: z.string().optional() });

/** Canonicalizes record ordering, derives the base generation id, and validates. */
export function normalizeNativeV9Input(value: unknown): NativeSafetyScoreV9Input {
  const parsed = NativeSafetyScoreV9InputIntakeSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Malformed native V9 input at ${issue?.path.join(".") || "root"}: ${issue?.message}`);
  }
  const input = parsed.data;
  const normalizedPayload = {
    ...input,
    activeAssetIds: [...input.activeAssetIds].sort(),
    inputMethodologyVersions: normalizeReportCardsFixedInputMethodologyVersions(input.inputMethodologyVersions),
    ...normalizeCommonFixedInputRecords(input),
    dexLiqMap: normalizeNativeDexLiquidityMap(input.dexLiqMap),
    redemptionBackstopMap: normalizeFixedRedemptionBackstopMap(input.redemptionBackstopMap),
  };
  const suppliedBaseInputGenerationId = input.baseInputGenerationId;
  const normalized = NativeSafetyScoreV9InputSchema.parse({
    ...normalizedPayload,
    baseInputGenerationId:
      suppliedBaseInputGenerationId ?? deriveNativeV9BaseInputGenerationId(normalizedPayload),
  });
  assertNativeV9InputConsistency(normalized, {
    verifyBaseInputGenerationId: suppliedBaseInputGenerationId !== undefined,
  });
  return normalized;
}

function isNativeV9InputShape(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 4
  );
}

/**
 * Normalizes either the native v4 capture or a retained v3 exact fixed input.
 * The v3 branch is the frozen-capture replay lane and delegates to the legacy
 * normalizer unchanged, so historical captures keep replaying byte-for-byte.
 */
export function normalizeSafetyScoreV9CompilerInput(value: unknown): SafetyScoreV9CompilerInput {
  if (isNativeV9InputShape(value)) return normalizeNativeV9Input(value);
  return normalizeFixedInput(value);
}

export async function buildNativeV9InputCacheEntry(
  value: unknown,
  safetyScoreIdentity: SafetyScoreV9InputIdentity,
): Promise<{ key: string; value: string; storedBytes: number; uncompressedBytes: number }> {
  const input = normalizeNativeV9Input(value);
  const identity = SafetyScoreV9InputIdentitySchema.parse(safetyScoreIdentity);
  if (
    identity.baseInputGenerationId !== input.baseInputGenerationId ||
    identity.methodologyVersion !== input.methodologyVersion ||
    identity.publicationGenerationId !== input.sourceGeneration
  ) {
    throw new Error("Native V9 input does not match its capture identity");
  }
  const {
    safetyScoreV9SupplyAttributionById: _v9SupplyAttribution,
    evidenceJournalById: _evidenceJournal,
    supplyAttributionJournalById: _supplyAttributionJournal,
    pegProvenanceById: _pegProvenance,
    ...baseInput
  } = input;
  return buildFixedInputCacheEntry({
    schemaVersion: 2,
    sourceGeneration: input.sourceGeneration,
    safetyScoreIdentity: identity,
    payload: baseInput,
    label: "Native V9 input cache artifact",
  });
}

export interface NativeV9InputCacheArtifact {
  input: NativeSafetyScoreV9Input;
  safetyScoreIdentity: SafetyScoreV9InputIdentity;
}

export async function parseNativeV9InputCacheArtifact(value: unknown): Promise<NativeV9InputCacheArtifact> {
  const { envelope, payload } = await parseFixedInputCacheEntry({
    value,
    envelopeSchema: NativeV9InputCacheEnvelopeSchema,
    malformedEnvelopeLabel: "Malformed native V9 input cache envelope",
    malformedPayloadLabel: "Malformed native V9 input cache payload",
    artifactLabel: "Native V9 input cache artifact",
  });
  const input = normalizeNativeV9Input(payload);
  if (input.sourceGeneration !== envelope.sourceGeneration) {
    throw new Error("Native V9 input cache generation mismatch");
  }
  if (
    envelope.safetyScoreIdentity.baseInputGenerationId !== input.baseInputGenerationId ||
    envelope.safetyScoreIdentity.methodologyVersion !== input.methodologyVersion ||
    envelope.safetyScoreIdentity.publicationGenerationId !== input.sourceGeneration
  ) {
    throw new Error("Native V9 input cache identity mismatch");
  }
  return { input, safetyScoreIdentity: envelope.safetyScoreIdentity };
}

export async function parseNativeV9InputCacheValue(value: unknown): Promise<NativeSafetyScoreV9Input> {
  return (await parseNativeV9InputCacheArtifact(value)).input;
}

/**
 * Parses either cache envelope version. v2 carries the native v4 capture; v1
 * carries a retained v3 exact fixed input and is routed to the untouched legacy
 * parser so frozen operator captures keep replaying byte-for-byte.
 */
export async function parseSafetyScoreV9InputCacheValue(value: unknown): Promise<SafetyScoreV9CompilerInput> {
  const parsedEnvelope = typeof value === "string" ? parseJson(value) : null;
  if (parsedEnvelope && !parsedEnvelope.ok) {
    throw new Error(`Malformed V9 input cache envelope: ${parsedEnvelope.message}`);
  }
  const raw = parsedEnvelope?.ok ? parsedEnvelope.value : value;
  const schemaVersion =
    raw !== null && typeof raw === "object" ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (schemaVersion === 1) return parseReportCardsFixedInputCacheValue(raw);
  return parseNativeV9InputCacheValue(raw);
}
