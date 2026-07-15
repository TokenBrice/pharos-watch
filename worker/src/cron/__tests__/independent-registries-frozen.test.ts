import { describe, expect, it } from "vitest";
import { excludeFrozenIds, includeActiveTrackedIds } from "../shared/exclude-frozen";

describe("excludeFrozenIds", () => {
  it("removes frozen ids from a list-of-objects keyed by stablecoinId", () => {
    const items = [
      { stablecoinId: "usdt-tether" },
      { stablecoinId: "usr-resolv" },
      { stablecoinId: "usdc-circle" },
    ];
    expect(
      excludeFrozenIds(items, (i) => i.stablecoinId, new Set(["usr-resolv"])),
    ).toEqual([{ stablecoinId: "usdt-tether" }, { stablecoinId: "usdc-circle" }]);
  });
});

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
