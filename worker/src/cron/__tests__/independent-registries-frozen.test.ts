import { describe, expect, it } from "vitest";
import { includeActiveTrackedIds } from "../shared/exclude-frozen";


describe("includeActiveTrackedIds", () => {
  it("keeps only IDs in the active producer universe", () => {
    const items = [
      { stablecoinId: "usdt-tether", status: "active" },
      { stablecoinId: "benji-franklin-templeton", status: "quarantined" },
      { stablecoinId: "bfusd-binance", status: "delisted" },
      { stablecoinId: "bd-basedollar", status: "frozen" },
    ];

    expect(includeActiveTrackedIds(
      items,
      (item) => item.stablecoinId,
      new Set(["usdt-tether"]),
    )).toEqual([{ stablecoinId: "usdt-tether", status: "active" }]);
  });
});
