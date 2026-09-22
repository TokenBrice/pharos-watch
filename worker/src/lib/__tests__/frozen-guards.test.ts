import { describe, expect, it } from "vitest";
import { assertActiveStablecoin } from "../frozen-guards";

describe("assertActiveStablecoin", () => {
  const activeIds = new Set(["usdt-tether"]);

  it("allows active IDs", () => {
    expect(assertActiveStablecoin("usdt-tether", activeIds)).toBeNull();
  });

  it.each([
    "benji-franklin-templeton",
    "bfusd-binance",
    "usr-resolv",
    "hkdr-rd-technologies",
  ])("returns 403 for non-active catalog ID %s", (stablecoinId) => {
    const response = assertActiveStablecoin(stablecoinId, activeIds);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });
});
