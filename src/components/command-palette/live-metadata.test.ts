import { describe, expect, it } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { buildPopularStablecoinIds, buildStablecoinLiveMetadata } from "./live-metadata";

describe("command palette live supply metadata", () => {
  it("omits unavailable caps while preserving explicit zero and independent price health", () => {
    const data = { peggedAssets: [
      makeStablecoin({ id: "usdc-circle", price: 1, circulating: {} }),
      makeStablecoin({ id: "usdt-tether", price: 1, circulating: { peggedUSD: 0 } }),
      makeStablecoin({ id: "dai-makerdao", price: 1, circulating: { peggedUSD: Number.NaN } }),
    ] };
    const metadata = buildStablecoinLiveMetadata(data);
    expect(metadata.get("usdc-circle")?.marketCapUsd).toBeUndefined();
    expect(metadata.get("dai-makerdao")?.marketCapUsd).toBeUndefined();
    expect(metadata.get("usdt-tether")?.marketCapUsd).toBe(0);
    expect(metadata.get("usdc-circle")?.health).toBeDefined();
    expect(buildPopularStablecoinIds(data, metadata)[0]).toBe("usdt-tether");
  });

  it("does not fabricate live caps when the entire supply query is unavailable", () => {
    expect(buildStablecoinLiveMetadata(undefined).size).toBe(0);
    expect(buildPopularStablecoinIds(undefined, new Map())).toEqual([]);
  });
});
