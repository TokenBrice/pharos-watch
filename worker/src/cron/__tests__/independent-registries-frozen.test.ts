import { describe, expect, it } from "vitest";
import { excludeFrozenIds } from "../shared/exclude-frozen";

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
