import { describe, expect, it, vi } from "vitest";
import { TEST_STABLECOIN_TIMESTAMP_SEC } from "@shared/test-utils/stablecoin";
import { makeAsset } from "../__shared/fixtures";

describe("makeAsset", () => {
  it("uses the canonical stablecoin builder without reading the wall clock", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(9_999_999_999_000);

    expect(makeAsset()).toMatchObject({
      id: "usdt-tether",
      priceUpdatedAt: TEST_STABLECOIN_TIMESTAMP_SEC,
      priceObservedAt: TEST_STABLECOIN_TIMESTAMP_SEC,
      priceSyncedAt: TEST_STABLECOIN_TIMESTAMP_SEC,
    });
    expect(now).not.toHaveBeenCalled();

    now.mockRestore();
  });
});
