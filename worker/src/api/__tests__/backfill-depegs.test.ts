import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { handleBackfillDepegs } from "../backfill-depegs";

stubCryptoForAuth();

describe("handleBackfillDepegs", () => {
  it("requires admin auth", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      makeApiUrl("/api/backfill-depegs"),
      undefined,
      makeApiRequest("/api/backfill-depegs"),
    );

    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown stablecoin", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      makeApiUrl("/api/backfill-depegs?stablecoin=not-a-real-id"),
      true,
      makeApiRequest("/api/backfill-depegs?stablecoin=not-a-real-id", { adminKey: "secret" }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Stablecoin not found" });
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      makeApiUrl("/api/backfill-depegs?batch=999999"),
      true,
      makeApiRequest("/api/backfill-depegs?batch=999999", { adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "No coins in this batch" });
  });

  it("validates bounded replay contextDays", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      makeApiUrl("/api/backfill-depegs?stablecoin=usdt-tether&startDay=2025-01-01&endDay=2025-01-02&contextDays=999"),
      true,
      makeApiRequest("/api/backfill-depegs?stablecoin=usdt-tether&startDay=2025-01-01&endDay=2025-01-02&contextDays=999", {
        adminKey: "secret",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid contextDays. Use an integer between 0 and 90.",
    });
  });
});
