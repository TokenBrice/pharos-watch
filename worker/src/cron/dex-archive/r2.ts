import {
  DEX_ARCHIVE_CODEC,
  DEX_ARCHIVE_SCHEMA_VERSION,
  encodeDexArchiveArtifact,
  verifyDexArchiveArtifact,
  type EncodedDexArchiveArtifact,
} from "./codec";
import type { LoadedMeasuredArchiveArtifact } from "./measured";
import {
  beginDexArchiveManifestAttempt,
  recordDexArchiveCandidateError,
  recordDexArchiveManifestError,
  recordDexArchiveManifestUpload,
  recordDexArchiveManifestVerified,
} from "./store";

const LOGICAL_RETENTION_SEC = 30 * 24 * 60 * 60;

function expectedCustomMetadata(
  loaded: LoadedMeasuredArchiveArtifact,
  sha256: string,
  uncompressedBytes: number,
  expiresAt: number,
): Record<string, string> {
  return {
    schemaVersion: String(DEX_ARCHIVE_SCHEMA_VERSION),
    codec: DEX_ARCHIVE_CODEC,
    family: loaded.artifactInput.family,
    generationId: loaded.artifactInput.generationId,
    sha256,
    rowCount: String(loaded.artifactInput.rowCount),
    dependencyRowCount: String(loaded.artifactInput.dependencyRowCount),
    uncompressedBytes: String(uncompressedBytes),
    expiresAt: String(expiresAt),
  };
}

function verifyCustomMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): void {
  if (!actual) throw new Error("DEX archive object custom metadata is missing");
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`DEX archive object custom metadata mismatch: ${key}`);
    }
  }
}

export interface ArchivedMeasuredObject {
  generationId: string;
  objectKey: string;
  created: boolean;
  verified: true;
  storedBytes: number;
  uncompressedBytes: number;
}

export async function archiveMeasuredObject(input: {
  db: D1Database;
  bucket: R2Bucket;
  loaded: LoadedMeasuredArchiveArtifact;
  now: number;
}): Promise<ArchivedMeasuredObject> {
  const { db, bucket, loaded, now } = input;
  let encoded: EncodedDexArchiveArtifact;
  try {
    encoded = await encodeDexArchiveArtifact(loaded.artifactInput);
  } catch (error) {
    await recordDexArchiveCandidateError({
      db,
      family: loaded.artifactInput.family,
      generationId: loaded.artifactInput.generationId,
      sourceSlotStartedAt: loaded.artifactInput.sourceSlotStartedAt,
      objectKey: loaded.objectKey,
      now,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const expiresAt = now + LOGICAL_RETENTION_SEC;
  const manifest = await beginDexArchiveManifestAttempt({
    db,
    objectKey: loaded.objectKey,
    encoded,
    now,
    expiresAt,
  });
  const logicalExpiresAt = manifest.expiresAt ?? expiresAt;
  const metadata = expectedCustomMetadata(
    loaded,
    encoded.sha256,
    encoded.artifact.uncompressedBytes,
    logicalExpiresAt,
  );
  try {
    const createdObject = await bucket.put(loaded.objectKey, encoded.gzipBytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json",
        contentEncoding: "gzip",
      },
      customMetadata: metadata,
    });
    if (createdObject) {
      await recordDexArchiveManifestUpload({
        db,
        family: encoded.artifact.family,
        generationId: encoded.artifact.generationId,
        etag: createdObject.etag,
        storedBytes: createdObject.size,
        now,
      });
    }

    const storedObject = await bucket.get(loaded.objectKey);
    if (!storedObject) throw new Error("DEX archive object disappeared before verification");
    verifyCustomMetadata(storedObject.customMetadata, metadata);
    const storedBytes = await storedObject.bytes();
    if (storedBytes.byteLength !== storedObject.size) {
      throw new Error("DEX archive stored byte count mismatch");
    }
    await verifyDexArchiveArtifact(storedBytes, {
      family: encoded.artifact.family,
      generationId: encoded.artifact.generationId,
      sha256: encoded.sha256,
      uncompressedBytes: encoded.artifact.uncompressedBytes,
      rowCount: encoded.artifact.rowCount,
      dependencyRowCount: encoded.artifact.dependencyRowCount,
    });
    await recordDexArchiveManifestVerified({
      db,
      family: encoded.artifact.family,
      generationId: encoded.artifact.generationId,
      etag: storedObject.etag,
      storedBytes: storedObject.size,
      now,
    });
    return {
      generationId: encoded.artifact.generationId,
      objectKey: loaded.objectKey,
      created: createdObject != null,
      verified: true,
      storedBytes: storedObject.size,
      uncompressedBytes: encoded.artifact.uncompressedBytes,
    };
  } catch (error) {
    await recordDexArchiveManifestError(
      db,
      encoded.artifact.family,
      encoded.artifact.generationId,
      now,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
