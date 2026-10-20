import { describe, it, expect } from "vitest";
import type { CronResult } from "../cron-logger";
import { normalizeCronMetadataWithLease } from "../cron-metadata";
import { compactCronMetadataForPersistence, DEFAULT_CRON_METADATA_BUDGET_BYTES } from "../cron-metadata-persistence";

describe("normalizeCronMetadataWithLease", () => {
  it("keeps measurements unknown and merges lease meta when job metadata is absent", () => {
    const result = normalizeCronMetadataWithLease(null, { owner: "test" });
    expect(JSON.parse(result)).toEqual({
      rowsRead: null,
      rowsWritten: null,
      rowsDropped: null,
      sourceCoverage: null,
      fallbackMode: null,
      validationFailures: null,
      owner: "test",
    });
  });

  it("merges producer metadata without inferring writes from itemCount", () => {
    const result = normalizeCronMetadataWithLease(
      { status: "ok", itemCount: 5, metadata: JSON.stringify({ items: 5 }) } as CronResult,
      { owner: "test" },
    );
    expect(JSON.parse(result)).toMatchObject({
      items: 5, rowsRead: null, rowsWritten: null, rowsDropped: null, validationFailures: null, owner: "test",
    });
  });

  it.each([null, 0, 7])("preserves producer measurements (%s) and scheduler lease identity", (measurement) => {
    const measurements = {
      rowsRead: measurement, rowsWritten: measurement, rowsDropped: measurement, validationFailures: measurement,
    };
    const result = normalizeCronMetadataWithLease(
      { itemCount: 99, metadata: JSON.stringify({ ...measurements, reason: "producer-evidence", leaseOwner: "producer" }) },
      { leaseOwner: "scheduler", scheduleKey: "quarterHourly", slotStartedAt: 600 },
    );
    expect(JSON.parse(result)).toMatchObject({
      ...measurements, reason: "producer-evidence", leaseOwner: "scheduler",
      scheduleKey: "quarterHourly", slotStartedAt: 600,
    });
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

  it("leaves producer and lease evidence intact until audited write-time compaction", () => {
    const adapterLatency = {
      schemaVersion: 1,
      groups: [{ adapterKey: "example", attemptCount: 1 }],
      overflow: false,
    };
    const reason = "reserve-adapter-or-persistence-failed";
    const reasons = [reason, "reserve-run-budget-deferred", "reserve-circuit-open"];
    const normalized = normalizeCronMetadataWithLease(
      {
        status: "degraded",
        metadata: JSON.stringify({
          adapterLatency,
          reason, reasons,
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
      leaseOwner?: string;
      reason?: string;
      reasons?: string[];
    };

    expect(new TextEncoder().encode(normalized).length).toBeGreaterThan(DEFAULT_CRON_METADATA_BUDGET_BYTES);
    expect(parsed.adapterLatency).toEqual(adapterLatency);
    expect(parsed.leaseOwner).toBe("job:scheduled:test");
    expect(parsed.reason).toBe(reason);
    expect(parsed.reasons).toEqual(reasons);
    const persisted = compactCronMetadataForPersistence(normalized);
    expect(persisted.persistedBytes).toBeLessThanOrEqual(DEFAULT_CRON_METADATA_BUDGET_BYTES);
    expect(JSON.parse(persisted.metadata!)).toMatchObject({ reason, reasons, leaseOwner: "job:scheduled:test" });
  });
});
