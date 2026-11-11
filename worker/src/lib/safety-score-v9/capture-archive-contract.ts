import { Buffer as NodeBuffer } from "node:buffer";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import { SafetyScoreCaptureArchiveObjectSchema } from "@shared/types/safety-score-capture-archive";

const Buffer = NodeBuffer as BufferConstructor;

export function safetyScoreCaptureArchiveKey(publishedAtSec: number, generationId: string): string {
  const day = new Date(publishedAtSec * 1_000).toISOString().slice(0, 10);
  return `captures/safety-score-v9-accepted/${day}/${generationId}.json`;
}

export function archiveObjectKey(row: { published_at: number; generation_id: string }): string {
  // Reject path separators before using an index identity in the offline filesystem path.
  if (!/^[A-Za-z0-9:_-]+$/u.test(row.generation_id)) throw new Error("Invalid archive generation path identity");
  return safetyScoreCaptureArchiveKey(row.published_at, row.generation_id);
}

export function decodeSafetyScoreCaptureArchiveObject(index: {
  generation_id: string;
  published_at: number;
  methodology_version: string;
  policy_digest: string;
  evaluation_build_digest: string;
  r2_key: string;
  object_sha256: string;
  object_bytes: number;
}, bytes: Uint8Array) {
  if (sha256HexFromBytes(bytes) !== index.object_sha256) throw new Error("capture-archive-sha256-mismatch");
  if (bytes.byteLength !== index.object_bytes) throw new Error("capture-archive-byte-length-mismatch");
  const object = SafetyScoreCaptureArchiveObjectSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (object.generationId !== index.generation_id || object.publishedAt !== index.published_at ||
      object.methodologyVersion !== index.methodology_version || object.policyDigest !== index.policy_digest ||
      object.evaluationBuildDigest !== index.evaluation_build_digest || index.r2_key !== archiveObjectKey(index)) {
    throw new Error("capture-archive-index-identity-mismatch");
  }
  return object;
}
