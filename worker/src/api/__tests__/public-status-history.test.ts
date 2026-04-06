import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

const { handlePublicStatusHistory } = await import("../public-status-history");

describe("handlePublicStatusHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters transitions to the requested time window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM status_state",
        rows: [],
        first: null,
      },
      {
        match: "FROM status_transitions",
        rows: [{
          id: 1,
          scope: "global",
          previous_status: "healthy",
          next_status: "degraded",
          raw_status: "degraded",
          transition_type: "degrade",
          reason: "raw-degraded-consecutive-threshold",
          confidence: 0.92,
          causes_json: "[]",
          created_at: now - 600,
        }],
      },
    ]);

    const request = new Request("https://pharos.watch/api/public-status-history?window=24h&limit=20");
    const res = await handlePublicStatusHistory(db, undefined, request);

    expect(res.status).toBe(200);
    expect(db.getHistory()).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("FROM status_transitions"),
      binds: ["global", now - (24 * 60 * 60), 20],
    }));
  });

  it("rejects unknown windows", async () => {
    const db = mockD1([]);
    const request = new Request("https://pharos.watch/api/public-status-history?window=90d");
    const res = await handlePublicStatusHistory(db, undefined, request);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid window parameter" });
  });
});
