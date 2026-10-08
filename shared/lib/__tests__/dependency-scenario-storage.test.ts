import { describe, expect, it } from "vitest";
import { chunkDependencyScenarioPayload, reassembleDependencyScenarioPayload } from "../dependency-scenario-storage";
import { DEPENDENCY_SCENARIO_CHUNK_BYTES } from "../../types/dependency-scenario-storage";
import { sha256Hex } from "../sha256";

describe("dependency scenario chunk storage", () => {
  it.each([DEPENDENCY_SCENARIO_CHUNK_BYTES - 1, DEPENDENCY_SCENARIO_CHUNK_BYTES, DEPENDENCY_SCENARIO_CHUNK_BYTES + 1])("round-trips the %i-byte boundary", size => {
    const payload = "'".repeat(size);
    const { manifest, chunks } = chunkDependencyScenarioPayload(payload);
    expect(chunks).toHaveLength(Math.ceil(size / DEPENDENCY_SCENARIO_CHUNK_BYTES));
    expect(chunks[0]!.byte_length).toBe(Math.min(size, DEPENDENCY_SCENARIO_CHUNK_BYTES));
    for (const chunk of chunks) {
      // Actual SQL literal worst-case escaping, not character count.
      const sql = `INSERT INTO dependency_scenario_payload_chunks (payload_id,chunk_index,value,byte_length,sha256) VALUES ('dependency-scenarios:v2:artifact:${manifest.payloadSha256}',${chunk.chunk_index},'${chunk.value.replaceAll("'", "''")}',${chunk.byte_length},'${chunk.sha256}') ON CONFLICT(payload_id,chunk_index) DO NOTHING;`;
      expect(new TextEncoder().encode(sql).length).toBeLessThan(100_000);
      expect(chunk.byte_length).toBeLessThan(2_000_000);
    }
    expect(reassembleDependencyScenarioPayload(manifest, chunks, manifest.payloadSha256)).toBe(payload);
  });
  it("preserves a BOM code point at a chunk boundary as payload data", () => {
    const payload = `${"x".repeat(DEPENDENCY_SCENARIO_CHUNK_BYTES)}\uFEFFretained`;
    const { manifest, chunks } = chunkDependencyScenarioPayload(payload);
    expect(chunks[1]!.value).toBe("\uFEFFretained");
    expect(reassembleDependencyScenarioPayload(manifest, chunks, manifest.payloadSha256)).toBe(payload);
  });
  it("round-trips a representative oversized UTF-8 payload without splitting code points", () => {
    const payload = JSON.stringify({ scenarios: Array.from({ length: 45 }, (_, scenario) => ({ id: scenario, results: Array.from({ length: 250 }, (_, asset) => ({ asset, publishedScore: 80, modeledScore: 40, roles: ["control-operator"], evidence: "引用😀'".repeat(10) })) })) });
    expect(new TextEncoder().encode(payload).length).toBeGreaterThan(2_000_000);
    const { manifest, chunks } = chunkDependencyScenarioPayload(payload);
    expect(chunks.every(chunk => chunk.byte_length <= DEPENDENCY_SCENARIO_CHUNK_BYTES)).toBe(true);
    expect(manifest.payloadSha256).toBe(sha256Hex(payload));
    expect(reassembleDependencyScenarioPayload(manifest, chunks, manifest.payloadSha256)).toBe(payload);
  });
  it.each(["missing", "extra", "reordered", "index", "value", "length", "chunk-hash", "whole-hash", "whole-length", "identity"])("rejects %s sets without returning partial content", defect => {
    const { manifest, chunks } = chunkDependencyScenarioPayload("x".repeat(DEPENDENCY_SCENARIO_CHUNK_BYTES + 1));
    let expected = manifest.payloadSha256;
    switch (defect) {
      case "missing": chunks.pop(); break;
      case "extra": chunks.push(chunks[0]!); break;
      case "reordered": chunks.reverse(); break;
      case "index": chunks[1]!.chunk_index++; break;
      case "value": chunks[0]!.value = "y".repeat(DEPENDENCY_SCENARIO_CHUNK_BYTES); break;
      case "length": chunks[0]!.byte_length--; break;
      case "chunk-hash": chunks[0]!.sha256 = "0".repeat(64); break;
      case "whole-hash": manifest.payloadSha256 = expected = "0".repeat(64); break;
      case "whole-length": manifest.byteLength++; break;
      case "identity": expected = "0".repeat(64); break;
    }
    expect(() => reassembleDependencyScenarioPayload(manifest, chunks, expected)).toThrow();
  });
});
