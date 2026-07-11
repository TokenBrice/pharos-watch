import { describe, it, expect } from "vitest";
import { handleDiscoveryCandidates, handleDismissCandidate } from "../discovery";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

describe("handleDiscoveryCandidates", () => {
  it("returns active candidates sorted by market_cap desc", async () => {
    const db = mockD1([
      {
        match: "gecko_id, llama_id, name, symbol, market_cap, source, first_seen, last_seen, dismissed FROM discovery_candidates",
        rows: [
          { id: 1, gecko_id: "big", llama_id: null, name: "Big", symbol: "BIG", market_cap: 50_000_000, source: "both", first_seen: 1000, last_seen: 2000, dismissed: 0, dismissed_at: null, dismissed_mcap: null },
          { id: 2, gecko_id: "small", llama_id: null, name: "Small", symbol: "SML", market_cap: 10_000_000, source: "coingecko", first_seen: 1500, last_seen: 2000, dismissed: 0, dismissed_at: null, dismissed_mcap: null },
        ],
      },
      {
        match: "SELECT COUNT(*)",
        rows: [{ total: 2 }],
      },
    ]);
    const url = new URL("https://api.pharos.watch/api/discovery-candidates?status=active");
    const res = await handleDiscoveryCandidates(db, url);
    expect(res.status).toBe(200);
    const body = await res.json() as { candidates: Array<{ geckoId: string }>; total: number };
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].geckoId).toBe("big");
    expect(body.total).toBe(2);
  });

  it("returns 400 for malformed limit", async () => {
    const db = mockD1([]);
    const url = new URL("https://api.pharos.watch/api/discovery-candidates?limit=oops");
    const res = await handleDiscoveryCandidates(db, url);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid limit: must be a number" });
  });

  it("returns 400 for malformed offset", async () => {
    const db = mockD1([]);
    const url = new URL("https://api.pharos.watch/api/discovery-candidates?offset=oops");
    const res = await handleDiscoveryCandidates(db, url);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid offset: must be a number" });
  });

  it("returns 400 for invalid status", async () => {
    const db = mockD1([]);
    const url = new URL("https://api.pharos.watch/api/discovery-candidates?status=paused");
    const res = await handleDiscoveryCandidates(db, url);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid status parameter" });
  });

  it("returns 500 through the shared error wrapper when the query throws", async () => {
    const db = mockD1([
      { match: "discovery_candidates", rows: [], throwError: new Error("query failed") },
    ]);
    const url = new URL("https://api.pharos.watch/api/discovery-candidates");
    const res = await handleDiscoveryCandidates(db, url);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal Server Error" });
  });
});

describe("handleDismissCandidate", () => {
  it("marks candidate as dismissed", async () => {
    const db = mockD1([
      {
        match: "SELECT id, name, symbol, source, market_cap, dismissed FROM discovery_candidates WHERE id = ?",
        first: { id: 1, name: "Big", symbol: "BIG", source: "both", market_cap: 50_000_000, dismissed: 0 },
        rows: [],
      },
      { match: "UPDATE discovery_candidates", rows: [], runMeta: { changes: 1 } },
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const res = await handleDismissCandidate(db, 1);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; alreadyDismissed: boolean; auditAction: string };
    expect(body.ok).toBe(true);
    expect(body.alreadyDismissed).toBe(false);
    expect(body.auditAction).toBe("dismiss-discovery-candidate");
    const audit = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit?.binds[2]).toBe("dismiss-discovery-candidate");
    expect(audit?.binds[3]).toBe("candidate:1");
  });

  it("returns 404 for non-existent candidate", async () => {
    const db = mockD1([
      {
        match: "SELECT id, name, symbol, source, market_cap, dismissed FROM discovery_candidates WHERE id = ?",
        first: null,
        rows: [],
      },
    ]);
    const res = await handleDismissCandidate(db, 999);
    expect(res.status).toBe(404);
  });

  it("reconciles an already-dismissed candidate as a safe success", async () => {
    const db = mockD1([
      {
        match: "SELECT id, name, symbol, source, market_cap, dismissed FROM discovery_candidates WHERE id = ?",
        first: { id: 1, name: "Big", symbol: "BIG", source: "both", market_cap: 50_000_000, dismissed: 1 },
        rows: [],
      },
    ]);

    const res = await handleDismissCandidate(db, 1);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      alreadyDismissed: true,
      candidate: { id: 1, symbol: "BIG" },
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO admin_action_audit"))).toBe(false);
  });
});
