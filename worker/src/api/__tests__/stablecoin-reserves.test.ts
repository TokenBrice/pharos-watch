import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStablecoinReserves } from "../stablecoin-reserves";

describe("handleStablecoinReserves", () => {
  it("returns 404 when no live data exists in D1", async () => {
    const db = mockD1();
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.status).toBe(404);
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
    const body = await res.json() as { slices: unknown[]; estimated: boolean; source: string };
    expect(body.slices).toEqual(slices);
    expect(body.estimated).toBe(false);
    expect(body.source).toBe("infinifi");
  });

  it("returns 404 for unknown stablecoin IDs", async () => {
    const db = mockD1();
    const res = await handleStablecoinReserves(db, "not-a-coin");
    expect(res.status).toBe(404);
  });
});
