import { describe, expect, it, vi } from "vitest";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import {
  cadenceBucketFor,
  claimCadenceBucket,
  completeCadenceBucket,
  failCadenceBucket,
  runCadenceBucketPublication,
} from "../cadence-bucket";

function marker(overrides: Partial<{
  bucket: number;
  state: "claimed" | "failed" | "completed";
  generation: string;
  claimedAt: number;
}> = {}) {
  return JSON.stringify({
    version: 1,
    bucket: 100,
    state: "completed",
    generation: "generation-a",
    claimedAt: 1_000,
    ...overrides,
  });
}

describe("cadence buckets", () => {
  it("uses scheduled time so execution jitter cannot shift the bucket", () => {
    expect(cadenceBucketFor(3_599, 1_800)).toBe(1);
    expect(cadenceBucketFor(3_600, 1_800)).toBe(2);
    expect(cadenceBucketFor(3_600, 3_600)).toBe(1);
    expect(cadenceBucketFor(7_199, 3_600)).toBe(1);
  });

  it("skips duplicate and clock-skewed deliveries after completion", async () => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [{ key: "cadence:test", value: marker(), updated_at: 1_010 }],
    }]);

    await expect(claimCadenceBucket(db, {
      key: "cadence:test",
      bucket: 100,
      nowSec: 1_020,
      staleClaimAfterSec: 60,
    })).resolves.toMatchObject({ kind: "skip", reason: "already-completed" });
    await expect(claimCadenceBucket(db, {
      key: "cadence:test",
      bucket: 99,
      nowSec: 1_020,
      staleClaimAfterSec: 60,
    })).resolves.toMatchObject({ kind: "skip", reason: "already-completed", bucket: 100 });
  });

  it("reclaims a failed bucket and fences completion to its generation", async () => {
    const failedValue = marker({ state: "failed" });
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [{ key: "cadence:test", value: failedValue, updated_at: 1_010 }],
    }, {
      match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
      rows: [],
      runMeta: { changes: 1 },
    }]);
    const claimResult = await claimCadenceBucket(db, {
      key: "cadence:test",
      bucket: 100,
      nowSec: 1_020,
      staleClaimAfterSec: 60,
    });

    expect(claimResult.kind).toBe("claimed");
    if (claimResult.kind !== "claimed") return;
    await expect(completeCadenceBucket(db, claimResult.claim, 1_030)).resolves.toBe(true);
    const completion = db.getHistory().find((entry) =>
      entry.sql.includes("UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
      && String(entry.binds[0]).includes('"state":"completed"')
    );
    expect(completion?.binds[3]).toBe(claimResult.claim.serializedClaim);
  });

  it("keeps failed work retryable and permits stale-claim recovery", async () => {
    const claimedValue = marker({ state: "claimed", claimedAt: 900 });
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [{ key: "cadence:test", value: claimedValue, updated_at: 900 }],
    }, {
      match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
      rows: [],
      runMeta: { changes: 1 },
    }]);
    const claimResult = await claimCadenceBucket(db, {
      key: "cadence:test",
      bucket: 100,
      nowSec: 1_020,
      staleClaimAfterSec: 60,
    });

    expect(claimResult.kind).toBe("claimed");
    if (claimResult.kind !== "claimed") return;
    await expect(failCadenceBucket(db, claimResult.claim, 1_025)).resolves.toBe(true);
    expect(db.getHistory().some((entry) => String(entry.binds[0]).includes('"state":"failed"'))).toBe(true);
  });

  it("preserves the publication lifecycle contract", async () => {
    const cases: readonly { state?: "completed" | "claimed"; advanced?: boolean; changes?: number;
      status?: "degraded"; metadata?: string; throws?: boolean; releaseError?: boolean }[] = [
      { state: "completed", metadata: '{"reason":"cadence_bucket_completed","cadence":{"bucket":2,"observedBucket":2,"cadenceSec":1800}}' },
      { state: "claimed", metadata: '{"reason":"cadence_bucket_in_progress","cadence":{"bucket":2,"observedBucket":2,"cadenceSec":1800}}' },
      { advanced: true, changes: 1, metadata: '{"lastWriteAdvanced":true,"cadence":{"bucket":2,"cadenceSec":1800,"completed":true,"retryable":false}}' },
      { advanced: false, changes: 1, status: "degraded", metadata: '{"lastWriteAdvanced":false,"cadence":{"bucket":2,"cadenceSec":1800,"completed":false,"retryable":true}}' },
      { advanced: true, changes: 0, status: "degraded", metadata: '{"lastWriteAdvanced":true,"cadence":{"bucket":2,"cadenceSec":1800,"completed":false,"retryable":true}}' },
      { throws: true, changes: 1 },
      { throws: true, releaseError: true },
    ];
    for (const testCase of cases) {
      const tables: MockTableConfig[] = [{ match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: testCase.state ? [{ key: "cadence:test", value: marker({ bucket: 2, state: testCase.state, claimedAt: 3_600 }), updated_at: 3_600 }] : [] }];
      if (!testCase.state) tables.push({ match: "INSERT OR IGNORE INTO cache", rows: [], runMeta: { changes: 1 } }, { match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?", rows: [], ...(testCase.releaseError ? { throwError: new Error("release failed") } : { runMeta: { changes: testCase.changes } }) });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = new Error("publication failed");
      const run = runCadenceBucketPublication(mockD1(tables), {
        key: "cadence:test", cadenceSec: 1_800, staleClaimAfterSec: 60, scheduledAtSec: 3_600, startedAtSec: 3_620,
        job: "test-job", releaseFailureEvent: "test.release-failed", releaseFailureMessage: "release failed",
        publication: async () => testCase.throws ? Promise.reject(error) : { itemCount: 1, metadata: JSON.stringify({ lastWriteAdvanced: testCase.advanced }) },
      });
      if (testCase.throws) await expect(run).rejects.toBe(error);
      else {
        const result = await run;
        expect([result.status, result.metadata]).toEqual([testCase.status, testCase.metadata]);
      }
      expect(warning).toHaveBeenCalledTimes(testCase.releaseError ? 1 : 0);
      warning.mockRestore();
    }
  });
});
