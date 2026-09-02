import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
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

const publicationOptions = {
  key: "cadence:test",
  cadenceSec: 1_800,
  staleClaimAfterSec: 60,
  scheduledAtSec: 3_600,
  startedAtSec: 3_620,
  job: "test-job",
  releaseFailureEvent: "test_job.cadence_claim_release_failed",
  releaseFailureMessage: "Failed to release test cadence claim after publication failure",
};

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

  it("runs a publication and completes its claimed bucket", async () => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [],
      first: null,
    }, {
      match: "INSERT OR IGNORE INTO cache",
      rows: [],
      runMeta: { changes: 1 },
    }, {
      match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
      rows: [],
      runMeta: { changes: 1 },
    }]);
    const publication = vi.fn(async () => ({
      itemCount: 3,
      metadata: JSON.stringify({ source: "test", lastWriteAdvanced: true }),
    }));

    const result = await runCadenceBucketPublication(db, { ...publicationOptions, publication });

    expect(publication).toHaveBeenCalledWith(3_620);
    expect(result).toEqual({
      itemCount: 3,
      metadata: '{"source":"test","lastWriteAdvanced":true,"cadence":{"bucket":2,"cadenceSec":1800,"completed":true,"retryable":false}}',
    });
    expect(db.getHistory().some((entry) => String(entry.binds[0]).includes('"state":"completed"'))).toBe(true);
  });

  it("translates completed and in-progress claims to stable skip metadata", async () => {
    const completedDb = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [{ key: "cadence:test", value: marker({ bucket: 2 }), updated_at: 3_610 }],
    }]);
    const inProgressDb = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [{
        key: "cadence:test",
        value: marker({ bucket: 2, state: "claimed", claimedAt: 3_600 }),
        updated_at: 3_600,
      }],
    }]);
    const publication = vi.fn(async () => ({ itemCount: 1 }));

    await expect(runCadenceBucketPublication(completedDb, {
      ...publicationOptions,
      publication,
    })).resolves.toEqual({
      itemCount: 0,
      metadata: '{"reason":"cadence_bucket_completed","cadence":{"bucket":2,"observedBucket":2,"cadenceSec":1800}}',
    });
    await expect(runCadenceBucketPublication(inProgressDb, {
      ...publicationOptions,
      publication,
    })).resolves.toEqual({
      itemCount: 0,
      metadata: '{"reason":"cadence_bucket_in_progress","cadence":{"bucket":2,"observedBucket":2,"cadenceSec":1800}}',
    });
    expect(publication).not.toHaveBeenCalled();
  });

  it("fails the claim and degrades a non-advancing publication", async () => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [],
    }, {
      match: "INSERT OR IGNORE INTO cache",
      rows: [],
      runMeta: { changes: 1 },
    }, {
      match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
      rows: [],
      runMeta: { changes: 1 },
    }]);

    const result = await runCadenceBucketPublication(db, {
      ...publicationOptions,
      publication: async () => ({ itemCount: 0, metadata: '{"lastWriteAdvanced":false}' }),
    });

    expect(result.status).toBe("degraded");
    expect(result.metadata).toBe('{"lastWriteAdvanced":false,"cadence":{"bucket":2,"cadenceSec":1800,"completed":false,"retryable":true}}');
    expect(db.getHistory().some((entry) => String(entry.binds[0]).includes('"state":"failed"'))).toBe(true);
  });

  it("degrades the result when the completion compare-and-swap loses ownership", async () => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [],
    }, {
      match: "INSERT OR IGNORE INTO cache",
      rows: [],
      runMeta: { changes: 1 },
    }, {
      match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
      rows: [],
      runMeta: { changes: 0 },
    }]);

    const result = await runCadenceBucketPublication(db, {
      ...publicationOptions,
      publication: async () => ({ itemCount: 1, metadata: '{"lastWriteAdvanced":true}' }),
    });

    expect(result.status).toBe("degraded");
    expect(result.metadata).toBe('{"lastWriteAdvanced":true,"cadence":{"bucket":2,"cadenceSec":1800,"completed":false,"retryable":true}}');
  });

  it("releases the claim and rethrows when publication fails", async () => {
    const publicationError = new Error("publication failed");
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [],
    }, {
      match: "INSERT OR IGNORE INTO cache",
      rows: [],
      runMeta: { changes: 1 },
    }, {
      match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
      rows: [],
      runMeta: { changes: 1 },
    }]);

    await expect(runCadenceBucketPublication(db, {
      ...publicationOptions,
      publication: async () => { throw publicationError; },
    })).rejects.toBe(publicationError);
    expect(db.getHistory().some((entry) => String(entry.binds[0]).includes('"state":"failed"'))).toBe(true);
  });

  it("logs a structured warning but preserves the publication error when release fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const publicationError = new Error("publication failed");
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      rows: [],
    }, {
      match: "INSERT OR IGNORE INTO cache",
      rows: [],
      runMeta: { changes: 1 },
    }, {
      match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
      rows: [],
      throwError: new Error("release failed"),
    }]);

    await expect(runCadenceBucketPublication(db, {
      ...publicationOptions,
      publication: async () => { throw publicationError; },
    })).rejects.toBe(publicationError);
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "test_job.cadence_claim_release_failed",
      job: "test-job",
      message: "Failed to release test cadence claim after publication failure",
      metadata: { bucket: 2 },
    });
    warnSpy.mockRestore();
  });
});
