import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES, SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES, SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES, SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES } from "@shared/lib/safety-score-v9-publication-limits";
import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import { evaluateSafetyPublicationSizeCauses } from "../status/evaluation-rules";
import { loadSafetyPublicationSize, SAFETY_PUBLICATION_SIZE_RAW_HEADROOM_WARN_BYTES, type SafetyPublicationSizeObservation } from "../status/safety-publication-size";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function observed(storedBytes: number, compressedBytes: number, uncompressedBytes = 8_000_000): SafetyPublicationSizeObservation {
  return {
    kind: "observed",
    storedBytes,
    storedCapBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES,
    compressedBytes,
    compressedCapBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES,
    uncompressedBytes,
    uncompressedCapBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES,
  };
}

describe("Safety Score publication size headroom", () => {
  it("reads stored bytes and the admitted compressed size without decoding the payload", async () => {
    const { sqlite, db } = fixtures.open();
    expect(await loadSafetyPublicationSize(db)).toEqual({ kind: "absent" });
    const value = JSON.stringify({ compressedBytes: 1_340_000, uncompressedBytes: 8_000_000, payload: "é".repeat(10) });
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("report-cards:v9", value, 1);
    expect(await loadSafetyPublicationSize(db)).toEqual(observed(new TextEncoder().encode(value).byteLength, 1_340_000));
  });

  it("reads sharded stored size and raw size from the same envelope", async () => {
    const { sqlite, db } = fixtures.open();
    const value = JSON.stringify({ compressedBytes: 1_250_000, uncompressedBytes: 9_100_000, payloadChunks: { storedBytes: 1_670_000 } });
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("report-cards:v9", value, 1);
    expect(await loadSafetyPublicationSize(db)).toEqual(observed(1_670_000, 1_250_000, 9_100_000));
  });

  it("observes reader-sized publications while warning against writer admission", async () => {
    const { sqlite, db } = fixtures.open();
    const value = JSON.stringify({ compressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES,
      uncompressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES,
      payloadChunks: { storedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES } });
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("report-cards:v9", value, 1);
    const size = await loadSafetyPublicationSize(db);
    expect(size).toEqual(observed(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES,
      SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES, SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES));
    expect(evaluateSafetyPublicationSizeCauses(size)).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "safetyScorePublicationUncompressedBytes",
        threshold: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES - SAFETY_PUBLICATION_SIZE_RAW_HEADROOM_WARN_BYTES }),
    ]));
  });

  it.each([undefined, null, 0, -1, 1.5, "9100000", 1e30, true, false, [], {}])("rejects missing or malformed raw size %s", async (uncompressedBytes) => {
    const { sqlite, db } = fixtures.open();
    const value = JSON.stringify({ compressedBytes: 1_250_000, uncompressedBytes });
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("report-cards:v9", value, 1);
    expect(await loadSafetyPublicationSize(db)).toEqual({ kind: "unavailable", reason: "safety-publication-size-malformed" });
  });

  it("retains the read-failed reason on a failed SELECT", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec("DROP TABLE cache");
    expect(await loadSafetyPublicationSize(db)).toEqual({ kind: "unavailable", reason: "safety-publication-size-read-failed" });
  });

  it("names a machine-readable reason when the envelope lacks a compressed size", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("report-cards:v9", "{}", 1);
    expect(await loadSafetyPublicationSize(db)).toEqual({ kind: "unavailable", reason: "safety-publication-size-malformed" });
    expect(evaluateSafetyPublicationSizeCauses({ kind: "unavailable", reason: "safety-publication-size-malformed" }))
      .toEqual([expect.objectContaining({ code: "safety_score_publication_size_unavailable", severity: "info" })]);
  });

  it("warns strictly above 85% of the tighter cap and stays admin-only", () => {
    const storedAt85 = SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES * 0.85;
    const compressedAt85 = SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES * 0.85;
    expect(evaluateSafetyPublicationSizeCauses(observed(storedAt85, compressedAt85))).toEqual([]);
    expect(evaluateSafetyPublicationSizeCauses({ kind: "absent" })).toEqual([]);

    // The previous production row has room under the lifted writer ceilings.
    expect(evaluateSafetyPublicationSizeCauses(observed(1_786_463, 1_340_000))).toEqual([]);
    const nearStoredCap = Math.floor(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES * 0.94);
    const nearCompressedCap = Math.floor(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES * 0.96);
    const [cause] = evaluateSafetyPublicationSizeCauses(observed(nearStoredCap, nearCompressedCap));
    expect(cause).toMatchObject({
      code: "safety_score_publication_size_headroom_low",
      severity: "warning",
      metric: "safetyScorePublicationCompressedBytes",
      value: nearCompressedCap,
      threshold: Math.floor(compressedAt85),
    });
    expect(cause!.message).toContain(`94.0% of the ${SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES}-byte stored cap`);
    expect(transitionHasPublicImpact([cause!])).toBe(false);

    expect(evaluateSafetyPublicationSizeCauses(observed(storedAt85 + 1, 100))[0])
      .toMatchObject({ metric: "safetyScorePublicationStoredBytes", value: storedAt85 + 1 });
  });

  it("warns strictly below 150,000 raw bytes remaining, independently of transport ratios", () => {
    const threshold = SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES - SAFETY_PUBLICATION_SIZE_RAW_HEADROOM_WARN_BYTES;
    expect(evaluateSafetyPublicationSizeCauses(observed(100, 100, threshold))).toEqual([]);
    for (const uncompressedBytes of [threshold + 1, SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES, SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES + 1]) {
      const [cause] = evaluateSafetyPublicationSizeCauses(observed(100, 100, uncompressedBytes));
      expect(cause).toMatchObject({
        code: "safety_score_publication_size_headroom_low", severity: "warning",
        metric: "safetyScorePublicationUncompressedBytes", value: uncompressedBytes, threshold,
      });
      expect(cause!.message).toContain(`${SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES - uncompressedBytes} bytes remaining`);
      expect(transitionHasPublicImpact([cause!])).toBe(false);
    }
    expect(evaluateSafetyPublicationSizeCauses(observed(
      Math.floor(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES * 0.94),
      Math.floor(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES * 0.96), threshold + 1)))
      .toEqual([expect.objectContaining({ metric: "safetyScorePublicationCompressedBytes" }),
        expect.objectContaining({ metric: "safetyScorePublicationUncompressedBytes" })]);
  });
});
