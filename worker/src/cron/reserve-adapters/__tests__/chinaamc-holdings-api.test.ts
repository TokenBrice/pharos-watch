import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChinaamcHoldingsReserves, parseChinaamcHoldings } from "../chinaamc-holdings-api";
import { getReserveAdapter } from "../index";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { validateAdapterOutput } from "../validate";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/chinaamc-holdings-api.json", import.meta.url), "utf8"));
const now = Date.parse("2026-10-25T21:45:00Z") / 1000;
const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === "cumiu-chinaamc")!;
/** The catalog `liveReservesConfig` was withdrawn on 2026-10-29: the issuer payload repeats a
 *  holding row and totals 103.19%. The reviewed adapter configuration is pinned here so the
 *  parser, fetch guards and descriptor policy stay covered while no coin ingests the feed. */
const config: LiveReservesConfig = {
  adapter: "chinaamc-holdings-api",
  version: 1,
  semantics: "collateral-mix",
  breakerScope: "cumiu-chinaamc",
  display: {
    url: "https://www.chinaamc.com.hk/detail?fundId=USDDMMF&fundName=ChinaAMC-USD-Digital-Money-Market-Fund-%28Tokenized-Unlisted-Class%29&lan=EN",
    label: "ChinaAMC disclosed fund holdings",
  },
  inputs: {
    primary: {
      kind: "http-json",
      url: "https://www.chinaamc.com.hk/jeecg-boot/mainFund/fundQuery/getHoldingsByFundId?fundId=USDDMMF&groupBy=none",
    },
  },
};
const signal = () => new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe("ChinaAMC disclosed pooled fund holdings", () => {
  it("aggregates all rows into three buckets without normalizing or publishing holdings", () => {
    const result = parseChinaamcHoldings(fixture, now);
    expect(result.slices).toHaveLength(3);
    expect(result.slices.map((slice) => slice.pct)).toEqual([
      expect.closeTo(58.9744, 6), expect.closeTo(33.5569, 6), expect.closeTo(7.5268, 6),
    ]);
    expect(result.slices[0]).toMatchObject({ assetClass: "other", risk: "high" });
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified", sourceTimestamp: Date.parse("2026-10-23T00:00:00+08:00") / 1000,
      unknownExposurePct: expect.closeTo(58.9744, 6),
      details: { disclosedHoldingCount: 66, reportedWeightTotalPct: expect.closeTo(100.0581, 6) },
    });
    expect(result.metadata).not.toHaveProperty("totalReservesUsd");
    expect(result.metadata?.details).not.toHaveProperty("holdings");
    expect(JSON.stringify(result)).not.toContain("QNB HK");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
    expect(getReserveAdapter(config.adapter)?.evidenceClass).toBe("weak-live-probe");
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter(config.adapter)!, now }).valid).toBe(true);
  });

  it("does not trust all-cash sector labels or guess unknown instrument names", () => {
    const payload = structuredClone(fixture);
    payload.result[0].securityNameEN = "Unidentified instrument";
    expect(parseChinaamcHoldings(payload, now).metadata?.unknownExposurePct).toBeCloseTo(70.1519, 6);
  });

  it("keeps the coin on its curated sidecar now that the live config is withdrawn", () => {
    expect("liveReservesConfig" in coin).toBe(false);
    expect(getReserveAdapter(config.adapter)?.evidenceClass).toBe("weak-live-probe");
    const sidecar = JSON.parse(readFileSync(
      new URL("../../../../../shared/data/stablecoins/domains/reserves/cumiu-chinaamc.json", import.meta.url),
      "utf8",
    )) as { reserves: Array<{ pct: number }>; reserveReview?: { compositionAsOf?: string } };
    expect(sidecar.reserves).toHaveLength(3);
    expect(sidecar.reserves.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 6);
    expect(sidecar.reserveReview?.compositionAsOf).toBe("2026-09-30");
  });

  it.each([
    (p: typeof fixture) => { p.success = false; },
    (p: typeof fixture) => { p.result = []; },
    (p: typeof fixture) => { p.result = p.result.slice(0, 10); },
    (p: typeof fixture) => { p.result[0].weighting = -1; },
    (p: typeof fixture) => { p.result[0].weighting = "11.1775"; },
    (p: typeof fixture) => { p.result[0].fundId = "HKDDMMF"; },
    (p: typeof fixture) => { p.result[0].securityNameEN = " "; },
    (p: typeof fixture) => { p.result[0].date = "20261022"; },
    (p: typeof fixture) => { for (const row of p.result) row.date = "20260230"; },
  ])("rejects malformed, incomplete or mixed-generation inputs", (mutate) => {
    const payload = structuredClone(fixture);
    mutate(payload);
    expect(() => parseChinaamcHoldings(payload, now)).toThrow(/chinaamc-holdings-api:/);
  });

  it("rejects a duplicate holding row before checking the weight total", () => {
    const payload = structuredClone(fixture);
    payload.result.push({ ...payload.result[0] });
    expect(() => parseChinaamcHoldings(payload, now)).toThrow("duplicate-holding-row");
  });

  it("rejects the identical issuer positions observed on 2026-10-28", () => {
    // GET https://www.chinaamc.com.hk/jeecg-boot/mainFund/fundQuery/getHoldingsByFundId?fundId=USDDMMF&groupBy=none
    // Observed 2026-10-28T09:50:42Z; raw SHA-256 422bc8635c01086e57cd3c001599341b7b333f83975ac98b3bb6991debaf6e51.
    // Rows 44/45 of 64 (100.042% total); omitted other rows and presentation fields, retained issuer identity and quantities.
    const duplicateFixture = {
      success: true,
      code: 200,
      result: [
        {
          fundId: "USDDMMF", date: "20261028", securityNameEN: "SINOCHEM OFFSHORE CAPIT 2.25% 24/11/2026",
          securityCode: "XS2408001365", isin: "XS2408001365", shares: 1350000, unitPrice: 99.86, weighting: 0.2315,
        },
        {
          fundId: "USDDMMF", date: "20261028", securityNameEN: "SINOCHEM OFFSHORE CAPIT 2.25% 24/11/2026",
          securityCode: "XS2408001365", isin: "XS2408001365", shares: 1350000, unitPrice: 99.86, weighting: 0.2315,
        },
      ],
    };
    expect(duplicateFixture.result[0]).toEqual(duplicateFixture.result[1]);
    expect(() => parseChinaamcHoldings(duplicateFixture, Date.parse("2026-10-28T09:50:42Z") / 1000))
      .toThrow("chinaamc-holdings-api: duplicate-holding-row");
  });

  it("uses the original holdings date and rejects stale or future observations", () => {
    const date = Date.parse("2026-10-23T00:00:00+08:00") / 1000;
    expect(() => parseChinaamcHoldings(fixture, date + 5 * 86400)).not.toThrow();
    expect(() => parseChinaamcHoldings(fixture, date + 5 * 86400 + 1)).toThrow(/stale/);
    expect(() => parseChinaamcHoldings(fixture, date - 600)).not.toThrow();
    expect(() => parseChinaamcHoldings(fixture, date - 601)).toThrow(/invalid/);
    expect(() => parseChinaamcHoldings(fixture, Date.parse("2026-10-22T18:00:00Z") / 1000)).not.toThrow();
    expect(() => parseChinaamcHoldings(fixture, date + 86400, 86400)).not.toThrow();
    expect(() => parseChinaamcHoldings(fixture, date + 86401, 86400)).toThrow(/stale/);
    expect(() => parseChinaamcHoldings(fixture, date + 5 * 86400 + 1, 999999)).toThrow(/stale/);
  });

  it("fetches a bounded JSON body and retains the source clock", async () => {
    const fetch = vi.fn(async () => Response.json(fixture));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchChinaamcHoldingsReserves(coin, config, signal(), { nowSec: now })).toEqual(parseChinaamcHoldings(fixture, now));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized responses without returning an allocation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(256 * 1024 + 1))));
    await expect(fetchChinaamcHoldingsReserves(coin, config, signal(), { nowSec: now })).rejects.toThrow();
  });

  it("rejects unavailable endpoints and propagates cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 503 })));
    await expect(fetchChinaamcHoldingsReserves(coin, config, signal(), { nowSec: now })).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(fetchChinaamcHoldingsReserves(coin, config, controller.signal, { nowSec: now })).rejects.toThrow();
  });
});
