import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMatrixdockStbt, parseMatrixdockStbtStats, fetchMatrixdockStbtReserves, MATRIXDOCK_STBT_STATS_URL, MATRIXDOCK_STBT_STATS_FALLBACK_URL } from "../matrixdock-stbt";
import fixture from "./fixtures/matrixdock-stbt-stats.json";
import source from "@shared/data/stablecoins/coins/stbt-matrixdock.json";
import { TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import { CONFIGURED_COINS } from "../../sync-live-reserves-shared";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import { createReserveAdapterRunner } from "../../reserve-adapter-runner";
import { createAdapterLatencyCollector } from "../../sync-live-reserves-core";
import { getReserveAdapter } from "../index";

type StatsPayload = { code: unknown; message?: unknown; data: Record<string, unknown>; [key: string]: unknown };
const payload: StatsPayload = fixture;
const config = source.liveReservesConfig as LiveReservesConfig;
afterEach(() => vi.restoreAllMocks());
const body = readFileSync(new URL("./fixtures/matrixdock-stbt.html", import.meta.url), "utf8");
describe("Matrixdock STBT issuer asset census", () => {
  it("uses live asset values without inventing an observation clock or custody rights", () => {
    const result = parseMatrixdockStbt(body);
    expect(result.slices.find((r) => r.sourceKey?.endsWith("asset_nav_t_bill"))?.pct).toBeCloseTo(22414696.63 / 23790631.16 * 100, 6);
    expect(result.metadata).toMatchObject({ freshnessMode: "unverified", supplyTokens: 23595622.754750902935317681 });
    expect(result.metadata).not.toHaveProperty("sourceTimestamp");
    expect(result.metadata).not.toHaveProperty("immediateRedeemableUsd");
  });
  it("rejects changed balances that do not reconcile and missing native identity", () => {
    expect(() => parseMatrixdockStbt(body.replace("22414696.63", "12414696.63"))).toThrow(/unreconciled/);
    expect(() => parseMatrixdockStbt(body.replace("0x530824da86689c9c17cdc2871ff29b058345b44a", "0x0000000000000000000000000000000000000000"))).toThrow(/identity/);
  });
  it("fails closed on new buckets, ambiguous records and truncated payloads", () => {
    expect(() => parseMatrixdockStbt(body.replace("asset_nav_repo", "asset_nav_new"))).toThrow(/unreviewed/);
    expect(() => parseMatrixdockStbt(body + body)).toThrow(/ambiguous/);
    expect(() => parseMatrixdockStbt(body.replace("stbt_total_supply", "unknown_supply"))).toThrow(/missing/);
  });
});

describe("official STBT stats candidate", () => {
  it("uses the same NAV normalizer as HTML and retains undated scope", () => {
    const expected = parseMatrixdockStbt(body);
    const actual = parseMatrixdockStbtStats(payload, MATRIXDOCK_STBT_STATS_URL);
    expect(actual.slices).toEqual(expected.slices);
    expect(actual.metadata?.supplyTokens).toBe(Number(fixture.data.stbt_total_supply));
    expect(actual.metadata?.collateralizationRatio).toBe(Number(fixture.data.asset_nav) / Number(fixture.data.stbt_total_supply));
    expect(actual.metadata?.freshnessMode).toBe("unverified");
    expect(actual.metadata).not.toHaveProperty("sourceTimestamp");
    expect(actual.metadata?.details).toMatchObject({sourceUrl:MATRIXDOCK_STBT_STATS_URL,freshnessSource:"issuer-stats-json",sourceTimestampPublished:false});
    expect(actual.metadata).not.toHaveProperty("totalReserveUsd");
    expect(actual.metadata).not.toHaveProperty("immediateRedeemableUsd");
  });
  it.each([
    ["error envelope", (x: StatsPayload) => { x.code = 1; }],
    ["string success code", (x: StatsPayload) => { x.code = "0"; }],
    ["unknown envelope field", (x: StatsPayload) => { x.currency = "EUR"; }],
    ["missing message", (x: StatsPayload) => { delete x.message; }],
    ["array census", (x: StatsPayload) => { x.data = [] as unknown as Record<string, unknown>; }],
    ["foreign currency", (x: StatsPayload) => { x.data.currency = "EUR"; }],
    ["changed token scope", (x: StatsPayload) => { x.data.symbol = "XAUM"; }],
    ["unreviewed clock", (x: StatsPayload) => { x.data.updated_at = 1791300000; }],
    ["missing stock", (x: StatsPayload) => { delete x.data.stbt_total_supply; }],
    ["zero stock", (x: StatsPayload) => { x.data.stbt_total_supply = "0"; }],
    ["missing bucket", (x: StatsPayload) => { delete x.data.asset_nav_buidl; }],
    ["negative bucket", (x: StatsPayload) => { x.data.asset_nav_repo = "-1"; }],
    ["nonfinite NAV", (x: StatsPayload) => { x.data.asset_nav = "Infinity"; }],
    ["new bucket", (x: StatsPayload) => { x.data.asset_nav_unreviewed = "1"; }],
    ["unreconciled NAV", (x: StatsPayload) => { x.data.asset_nav = "1"; }],
  ])("rejects %s", (_name, mutate) => {
    const x = structuredClone(payload);mutate(x);
    expect(() => parseMatrixdockStbtStats(x, MATRIXDOCK_STBT_STATS_URL)).toThrow();
  });
  it("never substitutes nested reserve allocations or proof-of-reserve total", () => {
    const x = structuredClone(payload);x.data.stbt_por = "1000000000";(x.data.reserve as Record<string, unknown>).reserve_cash_reserve = "1000000000";
    expect(parseMatrixdockStbtStats(x,MATRIXDOCK_STBT_STATS_URL).slices).toEqual(parseMatrixdockStbtStats(payload,MATRIXDOCK_STBT_STATS_URL).slices);
  });
  it.each([MATRIXDOCK_STBT_STATS_URL,MATRIXDOCK_STBT_STATS_FALLBACK_URL])("fetches reviewed official scope %s", async (url) => {
    installAdapterNetwork({json:{[url]:payload}});
    const coin = TRACKED_SOURCE_COINS.find(x=>x.id==="stbt-matrixdock")!;
    const result = await fetchMatrixdockStbtReserves(coin,{...config,inputs:{primary:{kind:"http-json",url}}},AbortSignal.timeout(5000));
    expect(result.metadata?.details?.sourceUrl).toBe(url);
    await expect(fetchMatrixdockStbtReserves({...coin,id:"mtbill-midas"},config,AbortSignal.timeout(5000))).rejects.toThrow("mismatch");
  });
  it("rejects unreviewed URL before opening fetch", async () => {
    const coin = TRACKED_SOURCE_COINS.find(x=>x.id==="stbt-matrixdock")!;
    await expect(fetchMatrixdockStbtReserves(coin,{...config,inputs:{primary:{kind:"http-json",url:"https://www.matrixdock.com/rwa/anon/website/api/v1/stats/total?symbol=STBT"}}},AbortSignal.timeout(5000))).rejects.toThrow("mismatch");
  });
});


describe("STBT bounded official fallback", () => {
  it("uses the registered JSON config and records actual fallback provenance", async () => {
    installAdapterNetwork({ json: {
      [MATRIXDOCK_STBT_STATS_URL]: { ...fixture, code: 1 },
      [MATRIXDOCK_STBT_STATS_FALLBACK_URL]: fixture,
    } });
    const coin = CONFIGURED_COINS.find((candidate) => candidate.id === "stbt-matrixdock")!;
    const signal = AbortSignal.timeout(5000);
    const run = createReserveAdapterRunner({ signal, adapterCtx: {}, adapterTimeoutMs: 2000, telemetry: createAdapterLatencyCollector() });
    const result = await run({ ...coin, liveReservesConfig: config }, config, getReserveAdapter("matrixdock-stbt")!, Date.now() + 4000);
    expect(result.metadata?.details?.sourceUrl).toBe(MATRIXDOCK_STBT_STATS_FALLBACK_URL);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "primary-fallback-used", effect: "info" }));
  });
});
