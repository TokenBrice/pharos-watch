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

  it.each([
    ["1", "1000000000000000000"], ["0.000000001", "1000000000"],
  ])("degrades a matched network with reported gap %s despite aggregate equality", (gap, raw) => {
    const networks = structuredClone(NETWORKS);
    networks[0].gap = { raw, decimal: gap };
    const result = adaptDgldGoldMapperState({ networks, bars: BARS }, PARAMS);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "network-recon-gap", effect: "degraded",
    }));
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1, 10);
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(2411.955, 3);
    expect(result.metadata?.supplyTokens).toBeCloseTo(2411.955, 3);
    expect(result.metadata?.sourceTimestamp).toBe(Math.floor(Date.parse(NETWORKS[1].reconCheckedAt) / 1000));
    expect(result.metadata?.details?.networks).toContainEqual(expect.objectContaining({
      id: "base", reconState: "matched", supply: 401.159, gap: Number(gap),
    }));
  });

  it("keeps every local gap degraded when several matched networks share an aggregate match", () => {
    const networks = structuredClone(NETWORKS);
    networks[0].gap = { raw: "1000000000000000000", decimal: "1" };
    networks[1].gap = { raw: "2000000000000000000", decimal: "2" };
    const result = adaptDgldGoldMapperState({ networks, bars: BARS }, PARAMS);
    expect(result.warnings?.filter((warning) => warning.code === "network-recon-gap")).toHaveLength(2);
    expect(result.warnings?.every((warning) => warning.effect === "degraded")).toBe(true);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1, 10);
    expect(result.metadata?.details?.networks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "base", gap: 1 }),
      expect.objectContaining({ id: "ethereum", gap: 2 }),
      expect.objectContaining({ id: "solana", gap: 0 }),
    ]));
  });

  it("preserves the distinct aggregate tolerance when every reported local gap is zero", () => {
    const networks = structuredClone(NETWORKS);
    networks[0].supply.decimal = String(Number(networks[0].supply.decimal) + 1);
    const result = adaptDgldGoldMapperState({ networks, bars: BARS }, PARAMS);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.unknownExposurePct).toBeGreaterThan(0);
    expect(result.metadata?.unknownExposurePct).toBeLessThan(0.5);
  });

  it.each(["0", "0.000"])("accepts an explicitly observed zero local gap %s", (gap) => {
    const networks = NETWORKS.map((network) => ({ ...network, gap: { raw: "0", decimal: gap } }));
    const result = adaptDgldGoldMapperState({ networks, bars: BARS }, PARAMS);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1, 10);
    expect(result.metadata?.details?.networks).toEqual(networks.map((network) => expect.objectContaining({
      id: network.id, gap: 0,
    })));
  });

  it("allows an observed zero-supply network without manufacturing additional backing", () => {
    const baseline = adaptDgldGoldMapperState({ networks: NETWORKS, bars: BARS }, PARAMS);
    const inactive = {
      ...NETWORKS[0], id: "inactive", supply: { raw: "0", decimal: "0" }, gap: { raw: "0", decimal: "0" },
    };
    const result = adaptDgldGoldMapperState({ networks: [...NETWORKS, inactive], bars: BARS }, PARAMS);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.supplyTokens).toBe(baseline.metadata?.supplyTokens);
    expect(result.metadata?.collateralizationRatio).toBe(baseline.metadata?.collateralizationRatio);
  });

  it.each(["", " ", "NaN", "Infinity", "-1", "0x0"])("rejects unavailable or invalid local gap %j instead of claiming zero", (gap) => {
    const networks = structuredClone(NETWORKS);
    networks[0].gap.decimal = gap;
    expect(() => adaptDgldGoldMapperState({ networks, bars: BARS }, PARAMS)).toThrow();
  });

  it("rejects an absent network gap instead of assuming zero", () => {
    const missing: Partial<(typeof NETWORKS)[number]> = { ...NETWORKS[0] };
    delete missing.gap;
    expect(() => adaptDgldGoldMapperState({
      networks: [missing as (typeof NETWORKS)[number], ...NETWORKS.slice(1)], bars: BARS,
    }, PARAMS)).toThrow();
  });

  it.each([false, true])("rejects duplicate network IDs before summing even when the duplicate is inactive=%s", (inactive) => {
    const duplicate = inactive
      ? { ...NETWORKS[0], supply: { raw: "0", decimal: "0" }, gap: { raw: "0", decimal: "0" } }
      : { ...NETWORKS[0] };
    for (const networks of [[...NETWORKS, duplicate], [duplicate, ...NETWORKS]]) {
      expect(() => adaptDgldGoldMapperState({ networks, bars: BARS }, PARAMS)).toThrow(/duplicate network ID/);
    }
  });

  it("retains unmatched-status degradation even when the reported gap is zero", () => {
    const networks = structuredClone(NETWORKS);
    networks[0].reconState = "pending";
    const result = adaptDgldGoldMapperState({ networks, bars: BARS }, PARAMS);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "network-recon-mismatch", effect: "degraded",
    }));
  });

  it("throws on an unreadable reconCheckedAt", () => {
    const broken = NETWORKS.map((network) => ({ ...network, reconCheckedAt: null }));
    expect(() => adaptDgldGoldMapperState({ networks: broken, bars: BARS }, PARAMS)).toThrow("reconCheckedAt");
  });

  it("throws on an empty network list", () => {
    expect(() => adaptDgldGoldMapperState({ networks: [], bars: BARS }, PARAMS)).toThrow("no networks");
  });
});
