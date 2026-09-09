import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return { ...actual, fetchTextWithRetry: vi.fn() };
});

import { adaptOnReSchedule, fetchOnreHoldingsCsvReserves, parseCsvRows, parseOnReSchedule } from "../onre-holdings-csv";
import { fetchTextWithRetry } from "../helpers";

const CSV = "Asset,Amount (USD),Allocation,APY,Liquidity Layer,Proof of Assets,,Snapshot date,14/08/2026\nShort-Term US T-Bills,\"142,768,536.03\",49.20807683,3.656,,\"\"\"T-Bills Collateral\"\"\",,Serve,TRUE\nShort-Term U.S. T-Bills,\"6,126,406.52\",2.111590489,3.656,,\"\"\"T-Bills Collateral\"\"\",,On-chain refreshed,14/08/2026\nUSDG,\"74,385,035.27\",25.63831382,3.600,Y,USDG (Solscan),,Statement date,14/08/2026\nsUSDS,\"18,289,053.60\",6.303693936,3.700,,sUSDS (Etherscan),,,\nsyrupUSDC,\"11,152,365.13\",3.843889245,5.000,,syrupUSDC (Solscan),,,\nsUSDe,\"5,852,215.92\",2.017085127,4.800,,sUSDe (Solscan),,,\nUSCC,\"5,038,080.52\",1.736476819,6.680,,USCC (Solscan),,,\nUSDG (Lending),\"3,750,767.96\",1.349950701,8.350,,USDG (Jupiter) (Kamino),,,\nUSDC (Lending),\"10,050,588.00\",3.597539938,7.360,,USDC (Jupiter) (Kamino),,,\nUSYC,\"431,761.09\",0.1488152326,3.190,,USYC (Etherscan),,,\nUSDC,\"1,529,100.25\",0.5270354707,0.000,,USDC (Solscan),,,\nUSD,\"10,758,411.91\",3.708105263,0.000,,\"\"\"T-Bills Collateral\"\"\",,,\nTotal,\"290,132,322.20\",100.1905729,,,,,,\nAUM,\"289,656,147.33\",,,,,,,";

function makeCoin(): StablecoinMeta {
  return { id: "onyc-onre", name: "ONyc", symbol: "ONyc" } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "onre-holdings-csv",
    version: 1,
    semantics: "collateral-mix",
    inputs: { primary: { kind: "http-html", url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vT-bLCCxKNCB2GHgFV5Jo6_fbv4t3CT60dwPMbUDfwhHglt5GBoLp47jp1wcCOY8Ob1ZgjA6KXNczdq/pub?output=csv&gid=1591707661&single=true" } },
    params: {},
  } as unknown as LiveReservesConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseOnReSchedule", () => {
  it("parses quoted fields, the snapshot date and the Total/AUM rows", () => {
    const schedule = parseOnReSchedule(CSV);
    expect(schedule.assetRows).toHaveLength(12);
    expect(schedule.declaredTotalUsd).toBe(290_132_322.20);
    expect(schedule.declaredAumUsd).toBe(289_656_147.33);
    expect(schedule.declaredAllocationSumPct).toBe(100.1905729);
    expect(schedule.snapshotDateIso).toBe("2026-08-14");
    expect(schedule.snapshotDateUnixSec).toBe(Math.floor(Date.parse("2026-08-14T00:00:00Z") / 1000));
    expect(schedule.assetRows[0]).toEqual({
      name: "Short-Term US T-Bills",
      amountUsd: 142_768_536.03,
      allocationPct: 49.20807683,
    });
  });

  it("returns null snapshot date when the header has no date", () => {
    const schedule = parseOnReSchedule(CSV.replace(",Snapshot date,14/08/2026", ""));
    expect(schedule.snapshotDateUnixSec).toBeNull();
  });
});

describe("adaptOnReSchedule", () => {
  it("publishes 11 normalized slices with the known drift degraded, not hidden", () => {
    const result = adaptOnReSchedule(parseOnReSchedule(CSV));

    expect(result.slices).toHaveLength(11);
    expect(result.slices.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(100, 6);
    const tBills = result.slices.find((s) => s.sourceKey === "onre-holdings-csv:us-t-bills")!;
    expect(tBills.pct).toBeCloseTo((142_768_536.03 + 6_126_406.52) / 290_132_322.20 * 100, 0);
    expect(tBills.risk).toBe("very-low");
    expect(result.slices.find((s) => s.sourceKey === "onre-holdings-csv:usdg")!.coinId).toBe("usdg-paxos");
    expect(result.slices.find((s) => s.sourceKey === "onre-holdings-csv:usdc-kamino-lending")!.coinId).toBe("usdc-circle");
    expect(result.slices.find((s) => s.sourceKey === "onre-holdings-csv:usd-cash")!.assetClass).toBe("cash");

    expect(result.metadata).toMatchObject({
      totalReserveUsd: 290_132_322.20,
      referenceNavUsd: 289_656_147.33,
      freshnessMode: "verified",
      sourceTimestamp: Math.floor(Date.parse("2026-08-14T00:00:00Z") / 1000),
    });
    expect(result.metadata!.details).toMatchObject({
      freshnessSource: "issuer-snapshot-date",
      snapshotDateIso: "2026-08-14",
      totalVsAumUsd: expect.closeTo(476_174.87, 4),
    });

    const codes = result.warnings!.map((w) => w.code);
    expect(codes).toContain("total-aum-mismatch");
    expect(codes).toContain("allocation-sum-drift");
    expect(result.warnings!.every((w) => w.effect === "degraded")).toBe(true);
  });

  it("fails closed when asset amounts disagree with the declared Total", () => {
    const tampered = CSV.replace("142,768,536.03", "142,768,000.00");
    expect(() => adaptOnReSchedule(parseOnReSchedule(tampered)))
      .toThrow("but the declared Total is");
  });

  it("fails closed when the Total or AUM row is missing", () => {
    const csv = CSV.replace("AUM,\"289,656,147.33\"", "Bogus,\"1.00\"");
    expect(() => adaptOnReSchedule(parseOnReSchedule(csv))).toThrow("Total and/or AUM");
  });

  it("publishes unreviewed rows as an unclassified slice with quantified unknown exposure", () => {
    const csv = CSV.replace("USCC,\"5,038,080.52\",1.736476819", "ZYX Asset,\"5,038,080.52\",1.736476819");
    const result = adaptOnReSchedule(parseOnReSchedule(csv));
    const unmapped = result.slices.find((s) => s.sourceKey !== undefined && s.sourceKey.startsWith("onre-holdings-csv:unmapped-"))!;
    expect(unmapped.risk).toBe("very-high");
    expect(result.metadata!.unknownExposurePct).toBeCloseTo(5_038_080.52 / 290_132_322.20 * 100, 6);
    expect(result.warnings!.some((w) => w.code === "unmapped-schedule-row")).toBe(true);
  });

  it("falls back to explicit unverified freshness without a snapshot date", () => {
    const result = adaptOnReSchedule(parseOnReSchedule(CSV.replace(",Snapshot date,14/08/2026", "")));
    expect(result.metadata!.freshnessMode).toBe("unverified");
    expect(result.metadata!.details).toMatchObject({
      freshnessSource: "onre-holdings-csv",
    });
  });

  it("reconciles clean when Total equals AUM and allocations sum to 100", () => {
    const csv = CSV
      .replace("AUM,\"289,656,147.33\"", "AUM,\"290,132,322.20\"")
      .replace("Total,\"290,132,322.20\",100.1905729", "Total,\"290,132,322.20\",100.0")
      .replace("USDG (Lending),\"3,750,767.96\",1.349950701", "USDG (Lending),\"3,750,767.96\",1.2927783887")
      .replace("USDC (Lending),\"10,050,588.00\",3.597539938", "USDC (Lending),\"10,050,588.00\",3.4641393705");
    const result = adaptOnReSchedule(parseOnReSchedule(csv));
    expect(result.warnings ?? []).toEqual([]);
    expect(result.metadata!.referenceNavUsd).toBe(290_132_322.20);
  });
});

describe("fetchOnreHoldingsCsvReserves", () => {
  it("fetches and adapts the schedule", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue(CSV);
    const result = await fetchOnreHoldingsCsvReserves(makeCoin(), makeConfig(), new AbortController().signal);
    expect(result.slices).toHaveLength(11);
    expect(fetchTextWithRetry).toHaveBeenCalledTimes(1);
  });

  it("propagates upstream failures", async () => {
    vi.mocked(fetchTextWithRetry).mockRejectedValue(new Error("HTTP 502"));
    await expect(fetchOnreHoldingsCsvReserves(makeCoin(), makeConfig(), new AbortController().signal))
      .rejects.toThrow("HTTP 502");
  });
});

describe("parseCsvRows", () => {
  it("handles quoted commas and doubled quotes", () => {
    const rows = parseCsvRows('a,"1,2","""quoted""",x\nb,c,"d",y');
    expect(rows).toEqual([["a", "1,2", "\"quoted\"", "x"], ["b", "c", "d", "y"]]);
  });
});
