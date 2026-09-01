import { describe, it, expect } from "vitest";
import { mergeCronMetadataWithLease, normalizeCronMetadata } from "../cron-metadata";
import { MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES } from "../cron-metadata-persistence";

describe("mergeCronMetadataWithLease", () => {
  it("returns lease meta when cron metadata is null", () => {
    const result = mergeCronMetadataWithLease(null, { owner: "test" });
    expect(JSON.parse(result)).toEqual({ owner: "test" });
  });

  it("returns lease meta when cron metadata is undefined", () => {
    const result = mergeCronMetadataWithLease(undefined, { owner: "test" });
    expect(JSON.parse(result)).toEqual({ owner: "test" });
  });

  it("merges when cron metadata is valid JSON", () => {
    const result = mergeCronMetadataWithLease('{"items":5}', { owner: "test" });
    expect(JSON.parse(result)).toEqual({ items: 5, owner: "test" });
  });

  it("falls back to string concat when cron metadata is not JSON", () => {
    const result = mergeCronMetadataWithLease("plain text", { owner: "test" });
    expect(result).toContain("plain text");
    expect(result).toContain("lease=");
  });
});

describe("normalizeCronMetadata adapter latency reservation", () => {
  it("preserves adapter latency while compacting oversized sibling diagnostics", () => {
    const adapterLatency = {
      schemaVersion: 1,
      groups: [{ adapterKey: "example", attemptCount: 1 }],
      overflow: false,
    };
    const normalized = normalizeCronMetadata({
      status: "degraded",
      metadata: JSON.stringify({
        adapterLatency,
        warnings: Array.from({ length: 2_000 }, (_, index) => `warning-${index}-${"x".repeat(80)}`),
        attemptFailureSummaries: Array.from(
          { length: 500 },
          (_, index) => ({ stablecoinId: `coin-${index}`, message: "failure".repeat(30) }),
        ),
      }),
    });
    const parsed = JSON.parse(normalized) as {
      adapterLatency?: unknown;
      adapterLatencyMetadataCompaction?: { compactedFields?: number };
    };

    expect(new TextEncoder().encode(normalized).length)
      .toBeLessThanOrEqual(MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES);
    expect(parsed.adapterLatency).toEqual(adapterLatency);
    expect(parsed.adapterLatencyMetadataCompaction?.compactedFields).toBeGreaterThan(0);
  });
});
