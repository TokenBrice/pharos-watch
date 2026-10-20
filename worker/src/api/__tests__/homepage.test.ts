import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import fixture from "@shared/test-utils/fixtures/hero-chart-oct10.json";
import { buildLiveHomepageHeroSnapshot } from "@shared/lib/homepage-hero-snapshot";
import { buildTotalMcapChartRows, TOTAL_MCAP_COHORT_IDS } from "@shared/lib/total-mcap-chart";
import { StablecoinChartResponseSchema } from "@shared/types/market";
import { HomepageHistorySchema, HomepageSnapshotSchema } from "@shared/types/homepage";
import { handleHomepageHistory, handleHomepageSnapshot } from "../homepage";
import { conditionalGetResponse, scopeResponseEtag } from "../../lib/api-response";
import { readEdgeCache } from "../../handlers/http/edge-cache";

const owners = vi.hoisted(() => ({ stablecoins: vi.fn(), charts: vi.fn(), supply: vi.fn(), psi: vi.fn(), peg: vi.fn() }));
vi.mock("../cache-handlers", () => ({ handleStablecoins: owners.stablecoins, handleStablecoinCharts: owners.charts }));
vi.mock("../supply-history", () => ({ handleSupplyHistory: owners.supply }));
vi.mock("../peg-summary", () => ({ handlePegSummary: owners.peg }));
vi.mock("../stability-index", () => ({ handleStabilityIndex: owners.psi }));

const now = 1_800_000_000;
const method = { version: "1.0", versionLabel: "v1.0", currentVersion: "1.0", currentVersionLabel: "v1.0", changelogPath: "/methodology/", asOf: now, isCurrent: true };
const data = { peggedAssets: [makeStablecoin({ id: "usdt-tether", circulating: { peggedUSD: 100 } })] };
const current = { score: 80, band: "STEADY", avg24h: 91.9, avg24hBand: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 }, computedAt: now, methodologyVersion: "1.0" };
function response(body: unknown, updatedAt: number | null = now, warning?: string) {
  return new Response(JSON.stringify(body), { headers: {
    "Content-Type": "application/json", ...(updatedAt === null ? {} : { "X-Data-Updated-At": String(updatedAt) }),
    ...(warning ? { Warning: warning } : {}),
  } });
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  owners.stablecoins.mockImplementation(async () => response(data));
  owners.charts.mockImplementation(async () => response(fixture.chartPoints));
  owners.supply.mockImplementation(async (_db, url: URL) => {
    const id = url.searchParams.get("stablecoin");
    const entry = Object.entries(TOTAL_MCAP_COHORT_IDS).find(([, value]) => value === id);
    const history = entry ? fixture.histories[`${entry[0]}History` as keyof typeof fixture.histories] : null;
    return response(history);
  });
  owners.psi.mockImplementation(async () => response({ current, history: [], methodology: method }));
  owners.peg.mockImplementation(async () => response({ coins: [], summary: { activeDepegCount: 2, medianDeviationBps: null, worstCurrent: null, coinsAtPeg: 0, totalTracked: 0, depegEventsToday: 0, depegEventsYesterday: 0 }, methodology: method }));
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("joined homepage history", () => {
  it("matches the former five-input browser computation exactly, retaining every gap and launch point", async () => {
    const body = HomepageHistorySchema.parse(await (await handleHomepageHistory(mockD1())).json());
    expect(body.rows).toEqual(buildTotalMcapChartRows(StablecoinChartResponseSchema.parse(fixture.chartPoints), fixture.histories));
    expect(owners.charts).toHaveBeenCalledTimes(1);
    expect(owners.supply).toHaveBeenCalledTimes(4);
    for (const call of owners.supply.mock.calls) expect(call[1].searchParams.get("days")).toBe("5000");
  });

  it("retains the aggregate while a failed cohort and dependent residual remain unavailable", async () => {
    owners.supply.mockRejectedValue(new Error("read failed"));
    const res = await handleHomepageHistory(mockD1());
    const body = HomepageHistorySchema.parse(await res.json());
    expect(body.rows).toEqual(buildTotalMcapChartRows(StablecoinChartResponseSchema.parse(fixture.chartPoints), { usdtHistory: null, usdcHistory: null, usdsHistory: null, daiHistory: null }));
    expect(body.sources.usdt).toMatchObject({ updatedAt: null, status: "unknown", reason: "source-read-failed" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("compact homepage snapshot", () => {
  it("uses the existing supply and displayed-PSI selectors and canonical incident summary", async () => {
    const body = HomepageSnapshotSchema.parse(await (await handleHomepageSnapshot(mockD1())).json());
    expect(body.market.data).toEqual(buildLiveHomepageHeroSnapshot(data, now));
    expect(body.psi.data).toEqual({ score: 91.9, band: "BEDROCK", computedAt: now });
    expect(body.incidents.data).toEqual({ activeDepegCount: 2 });
    for (const lane of Object.values(body)) expect(lane.meta).toMatchObject({ updatedAt: now, assessedAt: now, status: "fresh" });
    expect(body.market.meta.freshBudgetSec).toBeGreaterThan(0);
  });

  it("keeps independent lanes available and never publishes a failed incident read as zero", async () => {
    owners.peg.mockRejectedValue(new Error("D1 failed"));
    const res = await handleHomepageSnapshot(mockD1());
    const body = HomepageSnapshotSchema.parse(await res.json());
    expect(body.market.data?.totalUsd).toBe(100);
    expect(body.psi.data?.score).toBe(91.9);
    expect(body.incidents).toMatchObject({ data: null, meta: { updatedAt: null, status: "unknown", reason: "source-read-failed" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not invent generation time when a validated lane lacks its clock", async () => {
    owners.stablecoins.mockImplementation(async () => response(data, null));
    const body = HomepageSnapshotSchema.parse(await (await handleHomepageSnapshot(mockD1())).json());
    expect(body.market.data?.totalUsd).toBe(100);
    expect(body.market.data?.asOfISO).toBeNull();
    expect(body.market.meta).toMatchObject({ updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing-timestamp" });
  });

  it("preserves an old PSI sample clock and explicit degraded owner warnings", async () => {
    owners.psi.mockImplementation(async () => response({ current: { ...current, computedAt: now - 86400 }, history: [], methodology: method }));
    owners.peg.mockImplementation(async () => response({ coins: [], summary: { activeDepegCount: 0, medianDeviationBps: null, worstCurrent: null, coinsAtPeg: 0, totalTracked: 0, depegEventsToday: 0, depegEventsYesterday: 0 }, methodology: method }, now, '199 - "retained analytics"'));
    const body = HomepageSnapshotSchema.parse(await (await handleHomepageSnapshot(mockD1())).json());
    expect(body.psi.meta).toMatchObject({ updatedAt: now - 86400, status: "stale", reason: "stale-generation" });
    expect(body.incidents.data?.activeDepegCount).toBe(0);
    expect(body.incidents.meta).toMatchObject({ status: "degraded", reason: "source-warning" });
  });
});

describe("composed homepage cache deadlines", () => {
  it.each(["snapshot", "history"] as const)("never renews the %s producer deadline through Date or a conditional", async (kind) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const handler = kind === "snapshot" ? handleHomepageSnapshot : handleHomepageHistory;
    const first = await handler(mockD1());
    const payload: unknown = await first.json();
    const metas = kind === "snapshot"
      ? Object.values(HomepageSnapshotSchema.parse(payload)).map((lane) => lane.meta)
      : Object.values(HomepageHistorySchema.parse(payload).sources);
    const budget = Math.min(...metas.map((meta) => meta.freshBudgetSec));
    // Slow source work consumes all but one second of the shortest lane's
    // runway; dispatch/conditional work then crosses that deadline.
    const delayedOwner = kind === "snapshot" ? owners.stablecoins : owners.charts;
    delayedOwner.mockImplementation(async () => {
      clock.mockReturnValue((now + budget - 1) * 1000);
      return response(kind === "snapshot" ? data : fixture.chartPoints);
    });
    const composed = await handler(mockD1());
    expect(composed.headers.get("Date")).toBe(new Date((now + budget - 1) * 1000).toUTCString());
    expect(composed.headers.get("Cache-Control")).toContain("s-maxage=1");
    expect(composed.headers.has("X-Data-Updated-At")).toBe(false);
    clock.mockReturnValue((now + budget + 1) * 1000);
    const dispatched = scopeResponseEtag(composed, `/api/homepage-${kind}`, true);
    expect(dispatched.headers.get("Date")).toBe(composed.headers.get("Date"));
    const conditional = conditionalGetResponse(new Request(`https://site-api.pharos.watch/api/homepage-${kind}`, {
      headers: { "If-None-Match": dispatched.headers.get("ETag")! },
    }), dispatched);
    expect(conditional.status).toBe(200);
    vi.stubGlobal("caches", { default: { match: vi.fn(async () => dispatched) } });
    expect(await readEdgeCache({ skipCache: false, cacheKey: new Request("https://site-api.pharos.watch/api/homepage") })).toBeNull();
  });

  it.each([handleHomepageSnapshot, handleHomepageHistory])("does not cache a composition completed after a required lane expires", async (handler) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const original = owners.stablecoins.getMockImplementation()!;
    owners.stablecoins.mockImplementation(async (...args) => {
      clock.mockReturnValue((now + 100_000) * 1000);
      return original(...args);
    });
    owners.charts.mockImplementation(async () => {
      clock.mockReturnValue((now + 100_000) * 1000);
      return response(fixture.chartPoints);
    });
    expect((await handler(mockD1())).headers.get("Cache-Control")).toBe("no-store");
  });
});
