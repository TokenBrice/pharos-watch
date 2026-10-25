import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChinaamcHoldingsReserves, parseChinaamcHoldings } from "../chinaamc-holdings-api";
import { getReserveAdapter } from "../index";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { validateAdapterOutput } from "../validate";
import { resolveReserveResult } from "../../../lib/live-reserves/store-views";
import { makeReservesDb } from "../../../lib/__tests__/live-reserves-store.test-support";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/chinaamc-holdings-api.json", import.meta.url), "utf8"));
const now = Date.parse("2026-10-25T21:45:00Z") / 1000;
const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === "cumiu-chinaamc")!;
const config = coin.liveReservesConfig!;
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
      freshnessMode: "verified", sourceTimestamp: Date.parse("2026-10-23T00:00:00Z") / 1000,
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

  it("serves compact live detail while explicitly rejecting independent scoring", async () => {
    const result = parseChinaamcHoldings(fixture, now);
    const warnings = JSON.stringify(result.warnings);
    const db = makeReservesDb({
      composition: {
        stablecoin_id: coin.id, source: config.adapter, fetched_at: now, attempt_id: "b2-fixture",
        slices: JSON.stringify(result.slices), metadata: JSON.stringify(result.metadata),
        warning_count: result.warnings!.length, warnings,
        adapter_source_model: "dynamic-mix", adapter_evidence_class: "weak-live-probe",
      },
      syncState: {
        stablecoin_id: coin.id, adapter_key: config.adapter, last_success_at: now,
        last_attempted_at: now, last_success_attempt_id: "b2-fixture", warning_count: result.warnings!.length, warnings,
      },
    });
    const detail = await resolveReserveResult(db, coin.id, now);
    expect(detail?.mode).toBe("live");
    expect(detail?.reserves).toEqual(result.slices);
    expect(detail?.provenance).toMatchObject({ scoringEligible: false, scoringRejectionReasons: ["non-independent"] });
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(4096);
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

  it("uses the original holdings date and rejects stale or future observations", () => {
    const date = Date.parse("2026-10-23T00:00:00Z") / 1000;
    expect(() => parseChinaamcHoldings(fixture, date + 5 * 86400)).not.toThrow();
    expect(() => parseChinaamcHoldings(fixture, date + 5 * 86400 + 1)).toThrow(/stale/);
    expect(() => parseChinaamcHoldings(fixture, date - 1)).toThrow(/invalid/);
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
