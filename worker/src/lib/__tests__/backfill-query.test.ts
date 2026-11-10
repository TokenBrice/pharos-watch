import { describe, expect, it } from "vitest";
import { selectBackfillCoins } from "../backfill-query";

const COINS = Array.from({ length: 12 }, (_, index) => ({ id: `coin-${index}` }));

describe("selectBackfillCoins", () => {
  it("rejects a present-but-empty stablecoin value instead of running batch 0", async () => {
    const selection = selectBackfillCoins(
      new URL("https://op.invalid/jobs/x?stablecoin="),
      COINS,
      { defaultBatchSize: 10 },
    );
    if (!("response" in selection)) throw new Error("expected an error response");
    expect(selection.response.status).toBe(400);
    expect(await selection.response.json()).toEqual({ error: "Invalid stablecoin: must not be empty" });
  });

  it("keeps batched mode when the parameter is absent", () => {
    expect(selectBackfillCoins(new URL("https://op.invalid/jobs/x"), COINS, { defaultBatchSize: 10 }))
      .toEqual({ coins: COINS.slice(0, 10) });
  });

  it("keeps single-coin mode for a named id", () => {
    expect(selectBackfillCoins(new URL("https://op.invalid/jobs/x?stablecoin=coin-3"), COINS, { defaultBatchSize: 10 }))
      .toEqual({ coins: [COINS[3]] });
  });
});
