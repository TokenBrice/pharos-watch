import { describe, expect, it } from "vitest";
import { HomepageLaneMetaSchema, HomepageSnapshotSchema } from "../homepage";

const meta = { source: "stablecoins", updatedAt: 100, ageSeconds: 10, assessedAt: 110,
  freshBudgetSec: 600, degradedBudgetSec: 1200, status: "fresh", reason: null, warning: null };
const unavailable = { ...meta, updatedAt: null, ageSeconds: null, status: "unknown", reason: "source-read-failed" };

describe("homepage wire admission", () => {
  it("requires a generation and effective budgets for a fresh verdict", () => {
    expect(HomepageLaneMetaSchema.safeParse(meta).success).toBe(true);
    for (const bad of [{ updatedAt: null }, { freshBudgetSec: undefined }, { assessedAt: undefined }]) {
      expect(HomepageLaneMetaSchema.safeParse({ ...meta, ...bad }).success).toBe(false);
    }
  });
  it("requires reasons for failed/degraded lanes", () => {
    expect(HomepageLaneMetaSchema.safeParse(unavailable).success).toBe(true);
    expect(HomepageLaneMetaSchema.safeParse({ ...unavailable, reason: null }).success).toBe(false);
    expect(HomepageLaneMetaSchema.safeParse({ ...meta, status: "degraded" }).success).toBe(false);
  });
  const snapshot = {
    market: { data: null, meta: unavailable }, psi: { data: null, meta: unavailable },
    incidents: { data: { activeDepegCount: 0 }, meta },
  };
  it("admits independent unavailable fields and an observed zero without inventing another lane", () => {
    const parsed = HomepageSnapshotSchema.parse(snapshot);
    expect(parsed.incidents.data?.activeDepegCount).toBe(0);
    expect(parsed.market.data).toBeNull();
    expect(parsed.psi.data).toBeNull();
  });
  it("rejects unavailable data disguised as fresh and unadmitted numeric claims", () => {
    expect(HomepageSnapshotSchema.safeParse({ ...snapshot, market: { data: null, meta } }).success).toBe(false);
    expect(HomepageSnapshotSchema.safeParse({ ...snapshot, incidents: { data: { activeDepegCount: -1 }, meta } }).success).toBe(false);
  });
  it("admits optional incident horizon split counts while preserving legacy payloads", () => {
    const split = { activeDepegCount: 17, recentActiveDepegCount: 4, longRunningActiveDepegCount: 13 };
    expect(HomepageSnapshotSchema.parse({ ...snapshot, incidents: { data: split, meta } }).incidents.data).toEqual(split);
    expect(HomepageSnapshotSchema.parse(snapshot).incidents.data).toEqual({ activeDepegCount: 0 });
    for (const bad of [
      { activeDepegCount: 2, recentActiveDepegCount: -1, longRunningActiveDepegCount: 3 },
      { activeDepegCount: 2, recentActiveDepegCount: 1.5, longRunningActiveDepegCount: 1 },
    ]) {
      expect(HomepageSnapshotSchema.safeParse({ ...snapshot, incidents: { data: bad, meta } }).success).toBe(false);
    }
  });
});
