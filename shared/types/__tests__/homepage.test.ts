import { describe, expect, it } from "vitest";
import { HomepageLaneMetaSchema, HomepageSnapshotSchema } from "../homepage";

const meta = { source: "stablecoins", updatedAt: 100, ageSeconds: 10, assessedAt: 110,
  freshBudgetSec: 600, degradedBudgetSec: 1200, status: "fresh", reason: null, warning: null };
const unavailable = { ...meta, updatedAt: null, ageSeconds: null, status: "unknown", reason: "source-read-failed" };

describe("homepage wire admission", () => {
  it("requires a generation and effective budgets for a fresh verdict", () => {
    expect(HomepageLaneMetaSchema.safeParse(meta).success).toBe(true);
    expect(HomepageLaneMetaSchema.safeParse({ ...meta, updatedAt: null }).success).toBe(false);
    expect(HomepageLaneMetaSchema.safeParse({ ...meta, freshBudgetSec: undefined }).success).toBe(false);
    expect(HomepageLaneMetaSchema.safeParse({ ...meta, assessedAt: undefined }).success).toBe(false);
  });
  it("requires reasons for failed/degraded lanes", () => {
    expect(HomepageLaneMetaSchema.safeParse(unavailable).success).toBe(true);
    expect(HomepageLaneMetaSchema.safeParse({ ...unavailable, reason: null }).success).toBe(false);
    expect(HomepageLaneMetaSchema.safeParse({ ...meta, status: "degraded" }).success).toBe(false);
  });
  it("admits independent unavailable fields and an observed zero without inventing another lane", () => {
    const parsed = HomepageSnapshotSchema.parse({
      market: { data: null, meta: unavailable }, psi: { data: null, meta: unavailable },
      incidents: { data: { activeDepegCount: 0 }, meta },
    });
    expect(parsed.incidents.data?.activeDepegCount).toBe(0);
    expect(parsed.market.data).toBeNull();
    expect(parsed.psi.data).toBeNull();
  });
  it("rejects unavailable data disguised as fresh and unadmitted numeric claims", () => {
    expect(HomepageSnapshotSchema.safeParse({ market: { data: null, meta }, psi: { data: null, meta: unavailable }, incidents: { data: { activeDepegCount: -1 }, meta } }).success).toBe(false);
  });
});
