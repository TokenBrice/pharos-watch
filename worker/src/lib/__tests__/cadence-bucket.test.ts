import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  cadenceBucketFor,
  claimCadenceBucket,
  completeCadenceBucket,
  failCadenceBucket,
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
});
