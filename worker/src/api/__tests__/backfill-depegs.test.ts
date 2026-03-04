import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleBackfillDepegs } from "../backfill-depegs";

vi.stubGlobal("crypto", {
  subtle: {
    digest: async (_algo: string, data: ArrayBuffer) => data,
    timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => {
      const av = new Uint8Array(a);
      const bv = new Uint8Array(b);
      if (av.length !== bv.length) return false;
      return av.every((byte, idx) => byte === bv[idx]);
    },
  },
});

describe("handleBackfillDepegs", () => {
  it("requires admin auth", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      new URL("https://x/api/backfill-depegs"),
      "secret",
      new Request("https://x/api/backfill-depegs"),
    );

    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown stablecoin", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      new URL("https://x/api/backfill-depegs?stablecoin=not-a-real-id"),
      "secret",
      new Request("https://x/api/backfill-depegs?stablecoin=not-a-real-id", {
        headers: { "X-Admin-Key": "secret" },
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Stablecoin not found" });
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      new URL("https://x/api/backfill-depegs?batch=999999"),
      "secret",
      new Request("https://x/api/backfill-depegs?batch=999999", {
        headers: { "X-Admin-Key": "secret" },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "No coins in this batch" });
  });
});
