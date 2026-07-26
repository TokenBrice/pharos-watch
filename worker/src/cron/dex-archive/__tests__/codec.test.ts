import { describe, expect, it } from "vitest";
import {
  buildCanonicalDexArchiveArtifact,
  encodeDexArchiveArtifact,
  verifyDexArchiveArtifact,
  type DexArchiveArtifactInput,
} from "../codec";

const INPUT: DexArchiveArtifactInput = {
  family: "measured-quote-generation",
  generationId: "quote-123",
  sourceSlotStartedAt: 123,
  publication: {
    surface: "dex-measured-execution-quotes",
    state: "superseded",
    startedAt: 123,
    validatedAt: 124,
    publishedAt: 125,
  },
  producerVersion: "test-version",
  dependencyGenerationIds: ["target-122"],
  tables: [
    {
      name: "dex_measured_execution_quotes",
      columns: ["generation_id", "target_id", "price"],
      rows: [
        ["quote-123", "a", 1],
        ["quote-123", "b", null],
      ],
    },
    {
      name: "dex_measured_execution_targets",
      columns: ["generation_id", "target_id"],
      rows: [["target-122", "a"]],
    },
  ],
  rowCount: 2,
  dependencyRowCount: 1,
};

describe("DEX archive codec", () => {
  it("produces byte-identical canonical JSON with a self-consistent byte count", () => {
    const first = buildCanonicalDexArchiveArtifact(INPUT);
    const second = buildCanonicalDexArchiveArtifact(INPUT);
    expect(first.canonicalBytes).toEqual(second.canonicalBytes);
    expect(first.artifact.uncompressedBytes).toBe(first.canonicalBytes.byteLength);
  });

  it("round-trips gzip and verifies identity, counts, bytes, and SHA-256", async () => {
    const encoded = await encodeDexArchiveArtifact(INPUT);
    const verified = await verifyDexArchiveArtifact(encoded.gzipBytes, {
      family: INPUT.family,
      generationId: INPUT.generationId,
      sha256: encoded.sha256,
      uncompressedBytes: encoded.canonicalBytes.byteLength,
      rowCount: INPUT.rowCount,
      dependencyRowCount: INPUT.dependencyRowCount,
    });
    expect(verified).toEqual(encoded.artifact);
  });

  it("rejects a row whose width does not match the explicit column list", () => {
    expect(() => buildCanonicalDexArchiveArtifact({
      ...INPUT,
      tables: [{ name: "broken", columns: ["a"], rows: [[1, 2]] }],
    })).toThrow("row width");
  });
});
