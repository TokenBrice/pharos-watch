import { bytesToBase64 } from "@shared/lib/base64";
import { compareMethodologyVersions } from "@shared/lib/methodology-versions/base";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-public";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { z } from "zod";
import { throwIfAborted } from "./abort";
import { gunzipBytesBounded, gzipCanonicalJson } from "./canonical-json-gzip";
import { sha256Hex } from "./hash";
import { parseJson } from "./json-parse";

const PUBLICATION_STORAGE_KIND = "safety-score-v9-publication";
const STORAGE_SCHEMA_VERSION = 1;
const EVIDENCE_RESPONSIBILITY_FACTS_POLICY_VERSION = "9.19";
const PUBLISHED_EVIDENCE_EXPIRED_POLICY_VERSION = "9.4";

const SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES = 1_900_000;
const SAFETY_SCORE_V9_PUBLICATION_MAX_COMPRESSED_BYTES = 1_350_000;
const SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES = 8_000_000;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CacheIdentitySchema = z
  .object({
    candidateId: z.string().min(1),
    policyVersion: z.string().min(1),
    publicationGenerationId: z.string().min(1),
    baseInputGenerationId: z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/),
    factSetDigest: Sha256Schema,
    policyId: z.string().min(1),
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    resultDigest: Sha256Schema,
  })
  .strict();

const StorageEnvelopeSchema = z
  .object({
    storageSchemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
    kind: z.literal(PUBLICATION_STORAGE_KIND),
    encoding: z.literal("gzip-base64"),
    identity: CacheIdentitySchema,
    payloadSha256: Sha256Schema,
    uncompressedBytes: z.number().int().positive(),
    compressedBytes: z.number().int().positive(),
    payload: z.string().min(1),
  })
  .strict();

type CacheIdentity = z.infer<typeof CacheIdentitySchema>;

function publicationIdentity(
  publication: SafetyScoreV9CurrentResponse,
): CacheIdentity {
  return CacheIdentitySchema.parse({
    candidateId: publication.candidateId,
    policyVersion: publication.policyVersion,
    publicationGenerationId: publication.publicationGenerationId,
    baseInputGenerationId: publication.baseInputGenerationId,
    factSetDigest: publication.factSetDigest,
    policyId: publication.policy.id,
    policyDigest: publication.policy.semanticDigest,
    evaluationBuildDigest: publication.evaluationBuildDigest,
    resultDigest: publication.resultDigest,
  });
}

/**
 * Maps the storage envelope's uncompressed `identity` block to the shared
 * publication-identity contract, mirroring `buildSafetyScoreV9PublicationIdentity`.
 * Lets monitors read the active identity without inflating the compressed
 * publication body (too heavy for polled request paths).
 */
export function publicationIdentityFromStorageEnvelope(
  value: unknown,
): SafetyScoreV9PublicationIdentity | null {
  const parsed = CacheIdentitySchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: parsed.data.policyVersion,
    policyId: parsed.data.policyId,
    policyDigest: parsed.data.policyDigest,
    evaluationBuildDigest: parsed.data.evaluationBuildDigest,
    baseInputGenerationId: parsed.data.baseInputGenerationId,
    publicationGenerationId: parsed.data.publicationGenerationId,
  };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function base64ToBytes(value: string, label: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`Malformed ${label} base64 payload`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytesToBase64(bytes) !== value) {
    throw new Error(`${label} base64 payload is not canonical`);
  }
  return bytes;
}

function parsePublicationPayload(
  raw: string,
  label: string,
  options?: { skipCanonicalityCheck?: boolean },
): SafetyScoreV9CurrentResponse {
  const parsed = parseJson(raw);
  if (!parsed.ok) throw new Error(`Malformed ${label} JSON: ${parsed.message}`);
  // Re-stringifying the full payload doubles peak string heap on a ~8MB
  // publication; callers that have already authenticated the exact stored
  // bytes (payloadSha256 on the compressed path) skip it.
  if (!options?.skipCanonicalityCheck && stableJsonStringifyV1(parsed.value) !== raw) {
    throw new Error(`${label} JSON is not canonical`);
  }
  return SafetyScoreV9CurrentResponseSchema.parse(
    normalizeRetiredCardFields(parsed.value),
  );
}

/**
 * Methodology 9.15 retired `stressStateDigest`, and 9.35 stopped publishing a
 * binding cap on NR cards, without changing the V5 envelope version. Keep the
 * storage reader able to cross those card-field boundaries so a new candidate
 * can compare with and replace the last accepted publication. Integrity checks
 * still cover the original stored bytes; only the already-authenticated payload
 * is normalized for the current schema.
 */
function normalizeRetiredCardFields(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const publication = value as Record<string, unknown>;
  if (!Array.isArray(publication.cards)) return value;
  let changed = false;
  const cards = publication.cards.map((card) => {
    if (card === null || typeof card !== "object" || Array.isArray(card)) {
      return card;
    }
    const record = card as Record<string, unknown>;
    let currentCard = record;
    if ("stressStateDigest" in currentCard) {
      const digest = currentCard.stressStateDigest;
      if (
        digest !== null &&
        (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
      ) {
        throw new Error("Retired Safety Score v9 stress state digest is invalid");
      }
      const { stressStateDigest: _retired, ...withoutStressStateDigest } = currentCard;
      currentCard = withoutStressStateDigest;
      changed = true;
    }

    if (
      currentCard.score === null &&
      (currentCard.bindingCap !== null ||
        (Array.isArray(currentCard.caps) &&
          currentCard.caps.some(
            (cap) => cap !== null && typeof cap === "object" && !Array.isArray(cap) && cap.binding === true,
          )))
    ) {
      currentCard = {
        ...currentCard,
        bindingCap: null,
        caps: Array.isArray(currentCard.caps)
          ? currentCard.caps.map((cap) =>
              cap !== null && typeof cap === "object" && !Array.isArray(cap)
                ? { ...cap, binding: false }
                : cap,
            )
          : currentCard.caps,
      };
      changed = true;
    }
    return currentCard;
  });
  return changed ? { ...publication, cards } : value;
}

function compressedStorageCandidate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.storageSchemaVersion !== undefined ||
    candidate.encoding === "gzip-base64" ||
    candidate.kind === PUBLICATION_STORAGE_KIND
  );
}

export async function serializeSafetyScoreV9Publication(
  value: SafetyScoreV9CurrentResponse,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const publication = SafetyScoreV9CurrentResponseSchema.parse(value);
  if (
    compareMethodologyVersions(
      publication.policyVersion,
      EVIDENCE_RESPONSIBILITY_FACTS_POLICY_VERSION,
    ) >= 0 &&
    publication.cards.some(
      (card) =>
        card.scoreTrace.evidenceResponsibility.facts === undefined,
    )
  ) {
    throw new Error(
      "Safety Score v9.19+ publications require per-fact disclosure paths",
    );
  }
  if (
    compareMethodologyVersions(
      publication.policyVersion,
      PUBLISHED_EVIDENCE_EXPIRED_POLICY_VERSION,
    ) >= 0 &&
    publication.cards.some(
      (card) =>
        !card.scoreTrace.evidenceResponsibility.summaries.some(
          (summary) => summary.responsibility === "published-evidence-expired",
        ),
    )
  ) {
    throw new Error(
      "Safety Score v9.4+ publications require every evidence responsibility owner",
    );
  }
  const canonical = stableJsonStringifyV1(publication);
  const compressed = await gzipCanonicalJson(canonical, {
    label: "Safety Score v9 publication",
    maximumCompressedBytes:
      SAFETY_SCORE_V9_PUBLICATION_MAX_COMPRESSED_BYTES,
    maximumUncompressedBytes:
      SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES,
    signal,
  });
  const stored = stableJsonStringifyV1(
    StorageEnvelopeSchema.parse({
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      kind: PUBLICATION_STORAGE_KIND,
      encoding: "gzip-base64",
      identity: publicationIdentity(publication),
      payloadSha256: compressed.contentSha256,
      uncompressedBytes: compressed.uncompressedBytes,
      compressedBytes: compressed.compressed.byteLength,
      payload: bytesToBase64(compressed.compressed),
    }),
  );
  const storedBytes = utf8ByteLength(stored);
  if (storedBytes > SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES) {
    throw new Error(
      `Safety Score v9 publication is ${storedBytes} stored bytes; maximum is ${SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES}`,
    );
  }
  throwIfAborted(signal);
  return stored;
}

export async function parseSafetyScoreV9Publication(
  storedValue: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9CurrentResponse> {
  throwIfAborted(signal);
  if (
    utf8ByteLength(storedValue) >
    SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES
  ) {
    throw new Error(
      `Safety Score v9 publication exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES} stored bytes`,
    );
  }
  const raw = parseJson(storedValue);
  if (!raw.ok) {
    throw new Error(
      `Malformed Safety Score v9 publication JSON: ${raw.message}`,
    );
  }
  if (!compressedStorageCandidate(raw.value)) {
    return parsePublicationPayload(
      storedValue,
      "Safety Score v9 publication",
    );
  }

  const storage = StorageEnvelopeSchema.parse(raw.value);
  if (stableJsonStringifyV1(storage) !== storedValue) {
    throw new Error(
      "Safety Score v9 publication storage envelope JSON is not canonical",
    );
  }
  if (
    storage.uncompressedBytes >
    SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES
  ) {
    throw new Error(
      `Safety Score v9 publication exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES} uncompressed bytes`,
    );
  }
  if (
    storage.compressedBytes >
    SAFETY_SCORE_V9_PUBLICATION_MAX_COMPRESSED_BYTES
  ) {
    throw new Error(
      `Safety Score v9 publication exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_COMPRESSED_BYTES} compressed bytes`,
    );
  }
  const compressed = base64ToBytes(
    storage.payload,
    "Safety Score v9 publication",
  );
  if (compressed.byteLength !== storage.compressedBytes) {
    throw new Error(
      "Safety Score v9 publication compressed byte length mismatch",
    );
  }
  const uncompressed = await gunzipBytesBounded(
    compressed,
    {
      label: "Safety Score v9 publication",
      maximumCompressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_COMPRESSED_BYTES,
      maximumUncompressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES,
      expectedUncompressedBytes: storage.uncompressedBytes,
      signal,
    },
  );
  if (uncompressed.byteLength !== storage.uncompressedBytes) {
    throw new Error(
      "Safety Score v9 publication uncompressed byte length mismatch",
    );
  }
  let canonical: string;
  try {
    canonical = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(uncompressed);
  } catch {
    throw new Error("Safety Score v9 publication payload is not valid UTF-8");
  }
  if ((await sha256Hex(uncompressed)) !== storage.payloadSha256) {
    throw new Error("Safety Score v9 publication checksum mismatch");
  }
  const publication = parsePublicationPayload(
    canonical,
    "Safety Score v9 publication",
    // payloadSha256 above already pinned the exact producer-written canonical
    // bytes, so the canonicality re-stringify adds no integrity here.
    { skipCanonicalityCheck: true },
  );
  if (
    stableJsonStringifyV1(publicationIdentity(publication)) !==
    stableJsonStringifyV1(storage.identity)
  ) {
    throw new Error("Safety Score v9 publication identity mismatch");
  }
  throwIfAborted(signal);
  return publication;
}
