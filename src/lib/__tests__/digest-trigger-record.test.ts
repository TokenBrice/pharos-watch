import { describe, expect, it } from "vitest";
import {
  buildDigestTriggerRecord,
  formatDigestTriggerRate,
} from "@/lib/digest";
import type { DigestArchiveEntry, DigestNextTrigger } from "@shared/types/digest";

function trigger(id: string, metric: DigestNextTrigger["metric"]): DigestNextTrigger {
  return {
    id,
    label: id,
    metric,
    comparator: "gte",
    thresholdLabel: "threshold",
    rationale: "fixture",
    detail: "fixture",
  };
}

function outcome(
  id: string,
  status: "hit" | "missed" | "expired" | "pending",
): NonNullable<DigestArchiveEntry["forwardLookOutcomes"]>[number] {
  return {
    id: `outcome:${id}`,
    triggerId: id,
    label: id,
    status,
    detail: "fixture",
  };
}

function entry(
  nextTriggers: DigestNextTrigger[],
  forwardLookOutcomes: NonNullable<DigestArchiveEntry["forwardLookOutcomes"]>,
): Pick<DigestArchiveEntry, "nextTriggers" | "forwardLookOutcomes"> {
  return { nextTriggers, forwardLookOutcomes };
}

describe("buildDigestTriggerRecord", () => {
  it("keeps every status visible and includes expirations in the headline denominator", () => {
    const record = buildDigestTriggerRecord([
      entry(
        [trigger("trigger:depeg:usdt", "depeg-bps"), trigger("trigger:psi-score", "psi-score")],
        [
          outcome("trigger:depeg:usdt", "hit"),
          outcome("trigger:psi-score", "missed"),
          outcome("trigger:depeg:usdt", "expired"),
          outcome("trigger:psi-score", "pending"),
        ],
      ),
    ]);

    expect(record).toMatchObject({
      total: 4,
      hit: 1,
      missed: 1,
      expired: 1,
      pending: 1,
      resolved: 3,
      hitRate: 1 / 3,
    });
    expect(record.buckets.map((bucket) => bucket.key)).toEqual(["depeg-bps", "psi-score"]);
    expect(record.buckets[0]).toMatchObject({ total: 2, hit: 1, expired: 1, resolved: 2, hitRate: 0.5 });
  });

  it("keeps outcomes without a matching trigger metric in an explicit unclassified bucket", () => {
    const record = buildDigestTriggerRecord([
      entry([], [outcome("trigger:future:unknown", "pending")]),
    ]);

    expect(record.unclassifiedCount).toBe(1);
    expect(record.buckets).toContainEqual(expect.objectContaining({ key: "unknown", label: "Unclassified", pending: 1 }));
  });

  it("does not invent a rate when no outcome has resolved", () => {
    const record = buildDigestTriggerRecord([
      entry([trigger("trigger:gauge", "bank-run-gauge")], [outcome("trigger:gauge", "pending")]),
    ]);

    expect(record.hitRate).toBeNull();
    expect(formatDigestTriggerRate(record.hitRate)).toBe("—");
  });
});
