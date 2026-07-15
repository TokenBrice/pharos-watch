import { describe, expect, it } from "vitest";
import { assertActiveStablecoin, assertNotFrozen } from "../frozen-guards";

describe("assertNotFrozen", () => {
  it("returns null for non-frozen ids", () => {
    expect(assertNotFrozen("usdt-tether", new Set(["usr-resolv"]))).toBeNull();
  });

  it("returns a 403 Response for frozen ids", () => {
    const response = assertNotFrozen("usr-resolv", new Set(["usr-resolv"]));
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });
});

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
