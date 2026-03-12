import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStablecoinReserves } from "../stablecoin-reserves";

describe("handleStablecoinReserves", () => {
  it("returns a curated fallback payload when no live data exists in D1 yet", async () => {
    const db = mockD1();
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; estimated: boolean; sync?: { bootstrap?: boolean } };
    expect(body.mode).toBe("curated-fallback");
    expect(body.estimated).toBe(false);
    expect(body.sync?.bootstrap).toBe(true);
  });

  it("returns live slices when D1 has data", async () => {
    const slices = [{ name: "Test Farm", pct: 100, risk: "low" as const }];
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(slices),
          fetched_at: 1000,
          source: "infinifi",
        },
      },
    ]);
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.status).toBe(200);
    const body = await res.json() as { reserves: unknown[]; estimated: boolean; source: string; mode: string };
    expect(body.reserves).toEqual(slices);
    expect(body.estimated).toBe(false);
    expect(body.source).toBe("infinifi");
    expect(body.mode).toBe("live");
  });

  it("returns 404 for unknown stablecoin IDs", async () => {
    const db = mockD1();
    const res = await handleStablecoinReserves(db, "not-a-coin");
    expect(res.status).toBe(404);
  });
});
