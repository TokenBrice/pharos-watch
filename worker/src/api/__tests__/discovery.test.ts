import { describe, it, expect } from "vitest";
import { handleDiscoveryCandidates, handleDismissCandidate } from "../discovery";
import { mockD1 } from "./helpers/mock-d1";

describe("handleDiscoveryCandidates", () => {
  it("returns active candidates sorted by market_cap desc", async () => {
    const db = mockD1([
      {
        match: "SELECT * FROM discovery_candidates",
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
});

describe("handleDismissCandidate", () => {
  it("marks candidate as dismissed", async () => {
    const db = mockD1([
      { match: "UPDATE discovery_candidates", rows: [], runMeta: { changes: 1 } },
    ]);
    const res = await handleDismissCandidate(db, 1);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 404 for non-existent candidate", async () => {
    const db = mockD1([
      { match: "UPDATE discovery_candidates", rows: [], runMeta: { changes: 0 } },
    ]);
    const res = await handleDismissCandidate(db, 999);
    expect(res.status).toBe(404);
  });
});
