import { DEPENDENCY_SCENARIO_CHUNK_BYTES, DependencyScenarioChunkManifestSchema, DependencyScenarioChunkSchema, type DependencyScenarioChunk, type DependencyScenarioChunkManifest } from "../types/dependency-scenario-storage";
import { sha256Hex, sha256HexFromBytes } from "./sha256";

export function chunkDependencyScenarioPayload(payload: string): { manifest: DependencyScenarioChunkManifest; chunks: DependencyScenarioChunk[] } {
  const bytes = new TextEncoder().encode(payload);
  if (bytes.length === 0) throw new Error("Dependency scenario payload is empty");
  const chunks: DependencyScenarioChunk[] = [];
  // A BOM at a chunk boundary is payload data, not a stream signature.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + DEPENDENCY_SCENARIO_CHUNK_BYTES, bytes.length);
    // Never split a UTF-8 code point: each TEXT row must round-trip on its own.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const part = bytes.subarray(start, end);
    chunks.push({ chunk_index: chunks.length, value: decoder.decode(part), byte_length: part.length, sha256: sha256HexFromBytes(part) });
    start = end;
  }
  return { manifest: { storageFormat: "d1-chunks-v1", payloadSha256: sha256HexFromBytes(bytes), byteLength: bytes.length, chunkCount: chunks.length }, chunks };
}

/** Incomplete/corrupt sets fail closed; no caller receives a partial payload. */
export function reassembleDependencyScenarioPayload(rawManifest: unknown, rawChunks: unknown[], expectedSha256: string): string {
  const manifest = DependencyScenarioChunkManifestSchema.parse(rawManifest);
  if (manifest.payloadSha256 !== expectedSha256 || rawChunks.length !== manifest.chunkCount) throw new Error("Dependency scenario chunk manifest mismatch");
  const values: string[] = [];
  const encoder = new TextEncoder();
  let byteLength = 0;
  for (let index = 0; index < rawChunks.length; index++) {
    const chunk = DependencyScenarioChunkSchema.parse(rawChunks[index]);
    const bytes = encoder.encode(chunk.value);
    if (chunk.chunk_index !== index || bytes.length !== chunk.byte_length || sha256HexFromBytes(bytes) !== chunk.sha256) throw new Error("Dependency scenario chunk readback mismatch");
    byteLength += chunk.byte_length;
    values.push(chunk.value);
  }
  const payload = values.join("");
  if (byteLength !== manifest.byteLength || sha256Hex(payload) !== manifest.payloadSha256) throw new Error("Dependency scenario payload readback mismatch");
  return payload;
}
