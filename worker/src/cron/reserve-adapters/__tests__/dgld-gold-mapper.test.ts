import { describe, expect, it } from "vitest";
import { adaptDgldGoldMapperState } from "../dgld-gold-mapper";

const NETWORKS = [
  {
    id: "base", reconState: "matched", reconCheckedAt: "2026-09-09T12:00:14.105Z", decimals: 18,
    token: { address: "0xe908475f8Beb7A138B0dc6eb5A05cb27068ffB9A", symbol: "DGLD" },
    supply: { raw: "401159000000000000000", decimal: "401.159" },
    gap: { raw: "0", decimal: "0" },
  },
  {
    id: "ethereum", reconState: "matched", reconCheckedAt: "2026-09-09T12:00:02.493Z", decimals: 18,
    token: { address: "0xA9299C296d7830A99414d1E5546F5171fA01E9c8", symbol: "DGLD" },
    supply: { raw: "1603687000000000000000", decimal: "1603.687" },
    gap: { raw: "0", decimal: "0" },
  },
  {
    id: "solana", reconState: "matched", reconCheckedAt: "2026-09-09T12:01:03.265Z", decimals: 9,
    token: { address: "dg1dmo6NZNagkwB6EAfUeaco6CFXFLRhb1KCrsqXTVz", symbol: "DGLD" },
    supply: { raw: "407109000000000", decimal: "407.109" },
    gap: { raw: "0", decimal: "0" },
  },
];

const BARS = [
  { barId: "PAMP-C030727-2019", network: "ethereum", status: "live", amount: { raw: "405920000000000000000", decimal: "405.92" } },
  { barId: "PAMP-C031037-2019", network: "ethereum", status: "live", amount: { raw: "389142000000000000000", decimal: "389.142" } },
  { barId: "PAMP-C035696-2019", network: "ethereum", status: "live", amount: { raw: "401337000000000000000", decimal: "401.337" } },
  { barId: "PAMP-C035700-2019", network: "ethereum", status: "live", amount: { raw: "407288000000000000000", decimal: "407.288" } },
  { barId: "PAMP-C075714-2026", network: "base", status: "live", amount: { raw: "401159000000000000000", decimal: "401.159" } },
  { barId: "PAMP-C076016-2026", network: "solana", status: "live", amount: { raw: "407109000000000000000", decimal: "407.109" } },
  { barId: "PAMP-C035697-2019", network: "ethereum", status: "redeemed", amount: { raw: "409359000000000000000", decimal: "409.359" } },
];

const PARAMS = { label: "Allocated LBMA Good Delivery PAMP gold (Swiss vaults)", risk: "very-low" as const };

describe("adaptDgldGoldMapperState", () => {
  it("sums live bar fine-oz against supply with a 1.0 ratio and verified freshness", () => {
    const result = adaptDgldGoldMapperState({ networks: NETWORKS, bars: BARS }, PARAMS);

    expect(result.slices).toEqual([
      { sourceKey: "dgld-gold-mapper:gold", name: PARAMS.label, pct: 100, risk: "very-low" },
    ]);
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(2411.955, 3);
    expect(result.metadata?.supplyTokens).toBeCloseTo(2411.955, 3);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1, 5);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.sourceTimestamp).toBe(Math.floor(Date.parse("2026-09-09T12:00:02.493Z") / 1000));
    expect(result.warnings).toBeUndefined();
  });

  it("excludes redeemed bars from the reserve", () => {
    const onlyLive = BARS.filter((bar) => bar.status === "live");
    const result = adaptDgldGoldMapperState({ networks: NETWORKS, bars: onlyLive }, PARAMS);
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(2411.955, 3);
  });

  it("degrades with unknown exposure when supply diverges from live-bar oz", () => {
    const drifted = NETWORKS.map((network) => ({
      ...network,
      supply: { raw: network.supply.raw, decimal: String(Number(network.supply.decimal) * 1.05) },
    }));
    const result = adaptDgldGoldMapperState({ networks: drifted, bars: BARS }, PARAMS);
    expect(result.warnings?.some((warning) => warning.effect === "degraded")).toBe(true);
    expect(result.metadata?.unknownExposurePct).toBeGreaterThan(0);
  });

  it("throws on an unreadable reconCheckedAt", () => {
    const broken = NETWORKS.map((network) => ({ ...network, reconCheckedAt: null }));
    expect(() => adaptDgldGoldMapperState({ networks: broken, bars: BARS }, PARAMS)).toThrow("reconCheckedAt");
  });

  it("throws on an empty network list", () => {
    expect(() => adaptDgldGoldMapperState({ networks: [], bars: BARS }, PARAMS)).toThrow("no networks");
  });
});
