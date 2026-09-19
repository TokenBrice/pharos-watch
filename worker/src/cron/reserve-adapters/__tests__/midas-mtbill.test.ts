import { describe, expect, it, afterEach, vi } from "vitest";
import fixture from "./fixtures/midas-mtbill-transparency.json";
import { TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import source from "@shared/data/stablecoins/coins/mtbill-midas.json";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { adaptMidasMtbillTransparency, fetchMidasMtbillReserves, MIDAS_MTBILL_TRANSPARENCY_URL } from "../midas-mtbill";
import { installAdapterNetwork, expectValidAdapterOutput } from "./reserve-adapter.test-support";

const now = Math.floor(Date.parse(fixture.updatedAt) / 1000) + 120;
const ustb = "('USTB', 'CASH', 'wallet', 'ethereum', 'USTB')";
afterEach(() => vi.restoreAllMocks());

describe("mTBILL issuer portfolio", () => {
  it("uses source dollar units and preserves the unclassified residual without scaling named holdings", () => {
    const result = adaptMidasMtbillTransparency(fixture, now);
    const total = 76.2856204874 * 1_000_000;
    expect(result.metadata?.totalReserveUsd).toBe(total);
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(0.0322740868, 8);
    expect(result.slices.map((slice) => slice.coinId)).toEqual(["ustb-superstate", "buidl-blackrock", undefined]);
    expect(result.slices[0].pct / 100 * total).toBeCloseTo(71_457_000, 6);
    expect(result.slices[1].pct / 100 * total).toBeCloseTo(4_804_000, 6);
    expect(result.slices.reduce((sum, row) => sum + row.pct, 0)).toBeCloseTo(100, 10);
    expect(result.metadata?.details).toMatchObject({ positionPrecisionUsd: 1000, residualUsd: expect.closeTo(24_620.4874, 4) });
    expect(result.warnings).toBeUndefined();
    expectValidAdapterOutput("midas-mtbill", result, { now });
  });

  it("reconciles each rounded source total against its matching exact scope", () => {
    const payload = structuredClone(fixture);
    payload.reports.assets_by_protocol.assets.total = 76.309122;
    payload.reports.assets_by_protocol.assets.wallet = 76.309122;
    payload.reports.assets_by_protocol.equity.wallet = 76.309122;
    payload.reports.assets_by_protocol.equity.total = 76.309122;
    payload.reports.assets_by_protocol_chain.equity["('total', '')"] = 76.309122;
    payload.reports.assets_by_protocol_chain.equity["('wallet', 'ethereum')"] = 76.308;
    payload.reports.asset_values.pv_usd.ethereum = 76.30839;
    payload.reports.asset_values.pv_usd.total = 76.309;

    expect(() => adaptMidasMtbillTransparency(payload, now)).not.toThrow();
  });

  it.each([
    ["missing date", (x: typeof fixture) => { delete (x as { updatedAt?: string }).updatedAt; }],
    ["stale date", (x: typeof fixture) => { x.updatedAt = "2026-09-01T00:00:00Z"; }],
    ["future date", (x: typeof fixture) => { x.updatedAt = "2026-10-01T00:00:00Z"; }],
    ["negative position", (x: typeof fixture) => { x.reports.main_positions.pv_usd[ustb] = -1; }],
    ["unknown tuple", (x: typeof fixture) => { (x.reports.main_positions.pv_usd as Record<string, number>).unknown = 1; }],
    ["borrowed delta", (x: typeof fixture) => { x.reports.main_positions.delta_usd[ustb] = 1; }],
    ["assets/equity mismatch", (x: typeof fixture) => { x.reports.assets_by_protocol.assets.total += 1; }],
    ["unexpected protocol", (x: typeof fixture) => { (x.reports.assets_by_protocol.equity as Record<string, number>).aave = 1; }],
    ["unexpected chain", (x: typeof fixture) => { (x.reports.asset_values.pv_usd as Record<string, number>).base = 1; }],
    ["chain drift", (x: typeof fixture) => { x.reports.asset_values.pv_usd.ethereum += 1; }],
    ["negative residual", (x: typeof fixture) => { x.reports.main_positions.pv_usd[ustb] = 80; x.reports.main_positions.delta_usd[ustb] = 80; }],
  ])("rejects %s", (_name, change) => {
    const payload = structuredClone(fixture);
    change(payload);
    expect(() => adaptMidasMtbillTransparency(payload, now)).toThrow();
  });

  it("fetches only the configured mTBILL API and rejects another token scope", async () => {
    installAdapterNetwork({ json: { [MIDAS_MTBILL_TRANSPARENCY_URL]: fixture } });
    const coin = TRACKED_SOURCE_COINS.find((candidate) => candidate.id === "mtbill-midas")!;
    const config = source.liveReservesConfig as LiveReservesConfig;
    const result = await fetchMidasMtbillReserves(coin, config, AbortSignal.timeout(5000), { nowSec: now });
    expect(result.slices).toHaveLength(3);
    await expect(fetchMidasMtbillReserves({ ...coin, id: "mmev-midas" }, config, AbortSignal.timeout(5000))).rejects.toThrow("unreviewed token");
  });
});
