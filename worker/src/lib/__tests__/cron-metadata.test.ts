import { describe, it, expect } from "vitest";
import type { CronResult } from "../cron-logger";
import { normalizeCronMetadataWithLease } from "../cron-metadata";
import { MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES } from "../cron-metadata-persistence";

describe("normalizeCronMetadataWithLease", () => {
  it("applies row defaults and merges lease meta when job metadata is absent", () => {
    const result = normalizeCronMetadataWithLease(null, { owner: "test" });
    expect(JSON.parse(result)).toEqual({
      rowsRead: null,
      rowsWritten: null,
      rowsDropped: 0,
      sourceCoverage: null,
      fallbackMode: null,
      validationFailures: 0,
      owner: "test",
    });
  });

  it("merges parsed job metadata with lease meta and defaults itemCount to rowsWritten", () => {
    const result = normalizeCronMetadataWithLease(
      { status: "ok", itemCount: 5, metadata: JSON.stringify({ items: 5 }) } as CronResult,
      { owner: "test" },
    );
    expect(JSON.parse(result)).toMatchObject({ items: 5, rowsWritten: 5, owner: "test" });
  });

  it("keeps unparseable job metadata as rawMetadata alongside the lease meta", () => {
    const result = normalizeCronMetadataWithLease(
      { status: "ok", metadata: "plain text" } as CronResult,
      { owner: "test" },
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.rawMetadata).toBe("plain text");
    expect(parsed.owner).toBe("test");
  });

  it("preserves adapter latency while compacting oversized sibling diagnostics before lease enrichment", () => {
    const adapterLatency = {
      schemaVersion: 1,
      groups: [{ adapterKey: "example", attemptCount: 1 }],
      overflow: false,
    };
    const normalized = normalizeCronMetadataWithLease(
      {
        status: "degraded",
        metadata: JSON.stringify({
          adapterLatency,
          warnings: Array.from({ length: 2_000 }, (_, index) => `warning-${index}-${"x".repeat(80)}`),
          attemptFailureSummaries: Array.from(
            { length: 500 },
            (_, index) => ({ stablecoinId: `coin-${index}`, message: "failure".repeat(30) }),
          ),
        }),
      } as CronResult,
      { leaseOwner: "job:scheduled:test" },
    );
    const parsed = JSON.parse(normalized) as {
      adapterLatency?: unknown;
      adapterLatencyMetadataCompaction?: { compactedFields?: number };
      leaseOwner?: string;
    };

    expect(new TextEncoder().encode(normalized).length)
      .toBeLessThanOrEqual(MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES);
    expect(parsed.adapterLatency).toEqual(adapterLatency);
    expect(parsed.adapterLatencyMetadataCompaction?.compactedFields).toBeGreaterThan(0);
    expect(parsed.leaseOwner).toBe("job:scheduled:test");
  });
});
