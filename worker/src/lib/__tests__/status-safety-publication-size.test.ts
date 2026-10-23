import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES } from "@shared/lib/safety-score-v9-publication-limits";
import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES } from "../safety-score-v9/publication-codec";
import { evaluateSafetyPublicationSizeCauses } from "../status/evaluation-rules";
import { loadSafetyPublicationSize, type SafetyPublicationSizeObservation } from "../status/safety-publication-size";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function observed(storedBytes: number, compressedBytes: number): SafetyPublicationSizeObservation {
  return {
    kind: "observed",
    storedBytes,
    storedCapBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES,
    compressedBytes,
    compressedCapBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES,
  };
}

describe("Safety Score publication size headroom", () => {
  it("reads stored bytes and the admitted compressed size without decoding the payload", async () => {
    const { sqlite, db } = fixtures.open();
    expect(await loadSafetyPublicationSize(db)).toEqual({ kind: "absent" });
    const value = JSON.stringify({ compressedBytes: 1_340_000, payload: "é".repeat(10) });
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("report-cards:v9", value, 1);
    expect(await loadSafetyPublicationSize(db)).toEqual(observed(new TextEncoder().encode(value).byteLength, 1_340_000));
  });

  it("names a machine-readable reason when the envelope lacks a compressed size", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("report-cards:v9", "{}", 1);
    expect(await loadSafetyPublicationSize(db)).toEqual({ kind: "unavailable", reason: "safety-publication-size-malformed" });
    expect(evaluateSafetyPublicationSizeCauses({ kind: "unavailable", reason: "safety-publication-size-malformed" }))
      .toEqual([expect.objectContaining({ code: "safety_score_publication_size_unavailable", severity: "info" })]);
  });

  it("warns strictly above 85% of the tighter cap and stays admin-only", () => {
    const storedAt85 = SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES * 0.85;
    const compressedAt85 = SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES * 0.85;
    expect(evaluateSafetyPublicationSizeCauses(observed(storedAt85, compressedAt85))).toEqual([]);
    expect(evaluateSafetyPublicationSizeCauses({ kind: "absent" })).toEqual([]);

    // 2026-10-23 production row: 1,786,463 stored bytes (94%) and ~1.34 MB compressed (~96%).
    const [cause] = evaluateSafetyPublicationSizeCauses(observed(1_786_463, 1_340_000));
    expect(cause).toMatchObject({
      code: "safety_score_publication_size_headroom_low",
      severity: "warning",
      metric: "safetyScorePublicationCompressedBytes",
      value: 1_340_000,
      threshold: Math.floor(compressedAt85),
    });
    expect(cause!.message).toContain("94.0% of the 1900000-byte stored cap");
    expect(transitionHasPublicImpact([cause!])).toBe(false);

    expect(evaluateSafetyPublicationSizeCauses(observed(storedAt85 + 1, 100))[0])
      .toMatchObject({ metric: "safetyScorePublicationStoredBytes", value: storedAt85 + 1 });
  });
});
