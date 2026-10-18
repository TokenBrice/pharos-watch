import { expect, vi } from "vitest";
import type { MockD1Database } from "@shared/test-utils/mock-d1";

/** Independently count executed mock statements, collapsing each batch to one binding call. */
export function observeMockD1Cost(db: MockD1Database) {
  const batch = vi.spyOn(db, "batch");
  return (result: { metadata?: string }) => {
    const queries = db.getHistory().length;
    const batchCalls = batch.mock.calls.length;
    const batchMembers = batch.mock.calls.reduce((sum, [statements]) => sum + statements.length, 0);
    const cost = JSON.parse(result.metadata ?? "{}").d1Cost;
    expect(cost).toMatchObject({
      queries,
      bindingCalls: queries - batchMembers + batchCalls,
      batchCalls,
      awaitElapsedMs: expect.any(Number),
      coverage: "partial",
      reasons: expect.arrayContaining(["outer-cron-lifecycle-excluded"]),
    });
    expect(cost.awaitElapsedMs).toBeGreaterThanOrEqual(0);
    return cost;
  };
}
