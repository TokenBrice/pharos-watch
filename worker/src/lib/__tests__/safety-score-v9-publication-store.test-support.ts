import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import type { persistSafetyScoreV9Publication } from "../safety-score-v9/publication-store";
import { stableJsonStringifyChunksV1, stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { bytesToBase64 } from "@shared/lib/base64";
import { gzipCanonicalJson } from "../canonical-json-gzip";
import { serializeSafetyScoreV9Publication } from "../safety-score-v9/publication-codec";

type PublicationWrite = Parameters<typeof persistSafetyScoreV9Publication>[1];

export function currentInput(publication: SafetyScoreV9CurrentResponse): PublicationWrite {
  return {
    publication,
    publicationHealth: {
      schemaVersion: 2,
      status: "current",
      acceptedPublicationGenerationId: publication.publicationGenerationId,
      acceptedAtSec: publication.publishedAtSec,
      attemptedAtSec: publication.publishedAtSec,
      heldSinceSec: null,
      reasons: [],
    },
    publicationAttempt: {
      schemaVersion: 1,
      attemptedAtSec: publication.publishedAtSec,
      outcome: "published-clean",
      publicationGenerationId: publication.publicationGenerationId,
      quarantines: [],
      affectedAssetIds: [],
    },
    publicationClockSec: publication.publishedAtSec,
  };
}

/** Recreates pre-cutover compressed storage without passing legacy counts to a new producer. */
export async function legacyPublicationStorageValue(
  legacy: SafetyScoreV9CurrentResponse,
  current: SafetyScoreV9CurrentResponse,
): Promise<string> {
  const envelope = JSON.parse(await serializeSafetyScoreV9Publication(current));
  const compressed = await gzipCanonicalJson(stableJsonStringifyChunksV1(legacy), {
    label: "legacy accounting fixture",
    maximumCompressedBytes: 1_350_000,
    maximumUncompressedBytes: 8_000_000,
  });
  return stableJsonStringifyV1({
    ...envelope,
    payloadSha256: compressed.contentSha256,
    uncompressedBytes: compressed.uncompressedBytes,
    compressedBytes: compressed.compressed.byteLength,
    payload: bytesToBase64(compressed.compressed),
  });
}
