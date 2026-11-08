// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { useStablecoinDetailViewModel } from "../use-stablecoin-detail-view-model";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "./use-stablecoin-detail-view-model.test-support";
import { seedStablecoinDetailQueryCache, type ApiMeta, type StablecoinDetailSnapshot } from "@/lib/api";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { DataHealthBanner } from "@/components/data-health-banner";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { StablecoinDetailLiveSummaryStart, StablecoinDetailSnapshotHydrator } from "@/app/stablecoin/[id]/client";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { buildDetailStaleQueries } from "@/lib/stablecoin-detail-query-view-model";
import { makeBuildStablecoinDetailViewModelParams } from "@/lib/__tests__/fixtures/stablecoin-detail-view-model";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function detailSnapshot(generatedAt: number): StablecoinDetailSnapshot {
  return {
    version: 1,
    stablecoinId: "usdt-tether",
    generatedAt,
    updatedAt: { liveSummary: generatedAt, supplyHistory: generatedAt },
    lanes: {
      liveSummary: {
        price: 1,
        priceSource: null,
        priceConfidence: null,
        priceUpdatedAt: null,
        priceObservedAt: null,
        supplyObservedAt: Math.floor(generatedAt / 1000),
        circulating: { peggedUSD: 100 },
        circulatingPrevDay: {},
        circulatingPrevWeek: {},
        circulatingPrevMonth: {},
        nativeSupply: { current: null, prevWeek: null, prevMonth: null },
      },
      supplyHistory: [],
    },
  };
}

describe("stablecoin detail request budget", () => {
  it("hydrates only coin-scoped keys and never writes partial global responses", () => {
    const queryClient = new QueryClient();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const snapshot = detailSnapshot(now - 30_000);

    seedStablecoinDetailQueryCache(queryClient, snapshot);

    expect(queryClient.getQueryState(["stablecoins"])).toBeUndefined();
    expect(queryClient.getQueryState(["peg-summary"])).toBeUndefined();
    expect(queryClient.getQueryState(["stablecoin-detail", "usdt-tether"])).toBeUndefined();
    expect(queryClient.getQueryData(["stablecoin-live-summary", "usdt-tether"])).toMatchObject({
      data: snapshot.lanes.liveSummary,
      meta: { updatedAt: snapshot.updatedAt.liveSummary! / 1000, ageSeconds: 30, status: "fresh" },
    });
    expect(queryClient.getQueryData(["supply-history", "usdt-tether", 90])).toMatchObject({
      data: [],
      meta: { updatedAt: snapshot.updatedAt.supplyHistory! / 1000, ageSeconds: 30, status: "fresh" },
    });
    queryClient.clear();
  });

  it("preserves independent producer clocks and cannot replace newer live data with a later build", () => {
    const queryClient = new QueryClient();
    const snapshot = detailSnapshot(1_700_000_900_000);
    snapshot.updatedAt = { liveSummary: 1_700_000_100_000, supplyHistory: 1_699_900_000_000 };
    seedStablecoinDetailQueryCache(queryClient, snapshot);
    const liveKey = ["stablecoin-live-summary", "usdt-tether"];
    const historyKey = ["supply-history", "usdt-tether", 90];
    expect(queryClient.getQueryState(liveKey)?.dataUpdatedAt).toBe(snapshot.updatedAt.liveSummary);
    expect(queryClient.getQueryState(historyKey)?.dataUpdatedAt).toBe(snapshot.updatedAt.supplyHistory);
    const live = {
      data: { ...snapshot.lanes.liveSummary!, price: 1.01 },
      meta: { updatedAt: 1_700_000_500, ageSeconds: 0, status: "fresh" },
    };
    queryClient.setQueryData(liveKey, live, { updatedAt: Date.now() });
    seedStablecoinDetailQueryCache(queryClient, snapshot);
    expect(queryClient.getQueryData(liveKey)).toEqual(live);
    queryClient.clear();
  });

  it("hydrates missing producer clocks as unknown rather than using generatedAt", () => {
    const queryClient = new QueryClient();
    const snapshot = detailSnapshot(Date.now());
    snapshot.updatedAt = {};
    seedStablecoinDetailQueryCache(queryClient, snapshot);
    for (const key of [["stablecoin-live-summary", snapshot.stablecoinId], ["supply-history", snapshot.stablecoinId, 90]]) {
      expect(queryClient.getQueryState(key)?.dataUpdatedAt).toBe(0);
      expect(queryClient.getQueryData(key)).toMatchObject({
        meta: { updatedAt: null, ageSeconds: null, status: "unknown" },
      });
    }
    queryClient.clear();
  });

  it.each(["stale", "unknown"] as const)("keeps HTTP-200 %s producer metadata through registered queries and the dossier", async (mode) => {
    const now = Date.now();
    const sourceUpdatedAtSec = Math.floor(now / 1000) - 7200;
    const headers: Record<string, string> = mode === "stale" ? {
      "X-Data-Updated-At": String(sourceUpdatedAtSec),
      "X-Data-Age": "7200",
      "X-Data-Freshness": "stale",
      Warning: '110 - "Response is stale"',
    } : {
      "X-Data-Age": "unavailable",
      "X-Data-Freshness": "unknown",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/stablecoin-live-summary/usdt-tether")) {
        return Response.json(detailSnapshot(sourceUpdatedAtSec * 1000).lanes.liveSummary, { headers });
      }
      if (url.includes("/supply-history")) {
        return Response.json([{ date: sourceUpdatedAtSec, circulatingUsd: 100, price: 1 }], { headers });
      }
      return new Promise<Response>(() => {});
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const { result, unmount } = renderHook(() => useStablecoinDetailViewModel({
      id: coin.id, coin, summary: null, supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
    }), { wrapper });
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
      expect(queryClient.getQueryState(["supply-history", coin.id, 90])?.status).toBe("success");
    });
    await queryClient.refetchQueries({ queryKey: ["stablecoin-live-summary", coin.id] });
    await queryClient.refetchQueries({ queryKey: ["supply-history", coin.id, 90] });
    expect(queryClient.getQueryState(["stablecoin-live-summary", coin.id])?.dataUpdatedAt).toBeGreaterThan(sourceUpdatedAtSec * 1000);
    if (result.current.status !== "ready") throw new Error("Expected a ready dossier");
    const priceQuery = result.current.staleQueries.find((query) => query.preset === "stablecoins")!;
    const supplyQuery = result.current.staleQueries.find((query) => query.label === "Supply history")!;
    for (const query of [priceQuery, supplyQuery]) {
      const health = deriveDataHealth({
        ...(query.preset ? DATA_HEALTH_PRESETS[query.preset] : { label: query.label!, staleTime: query.staleTime! }),
        ...query,
      }, now);
      expect(health.state).toBe(mode === "stale" ? "stale" : "unavailable");
      expect(health.dataUpdatedAt).toBe(mode === "stale" ? sourceUpdatedAtSec * 1000 : 0);
      expect(query.meta?.updatedAt).toBe(mode === "stale" ? sourceUpdatedAtSec : null);
    }
    expect(result.current.supplyUpdatedAt).toBe(mode === "stale" ? sourceUpdatedAtSec * 1000 : 0);
    unmount();
    queryClient.clear();
  });

  it("loads all hero metrics while leaving offscreen-only lanes gated", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      requests.push(String(input));
      return new Promise<Response>(() => {});
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const { rerender } = renderHook(
      ({ flowsNear }) => useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: {
          liquidity: true,
          reportCards: true,
          redemption: false,
          yield: true,
          stress: true,
          flows: flowsNear,
          blacklist: false,
          reserves: false,
        },
      }),
      { initialProps: { flowsNear: false }, wrapper },
    );

    await waitFor(() => expect(requests).toHaveLength(7));
    expect(requests).toEqual(expect.arrayContaining([
      expect.stringContaining("/api/stablecoin-live-summary/usdt-tether"),
      expect.stringContaining("/api/peg-summary"),
      expect.stringContaining("/api/supply-history?stablecoin=usdt-tether&days=90"),
      expect.stringContaining("/api/yield-rankings-coin?stablecoin=usdt-tether"),
      expect.stringContaining("/api/dex-liquidity-coin?stablecoin=usdt-tether"),
      expect.stringContaining("/api/report-cards/v9-detail?stablecoin=usdt-tether"),
      expect.stringContaining("/api/stress-signals"),
    ]));
    expect(requests.some((path) => /\/api\/(?:dex-liquidity|yield-rankings|redemption-backstops)(?:\?|$)/.test(path))).toBe(false);
    expect(requests.some((path) => /\/api\/report-cards\/v9(?:\?|$)/.test(path))).toBe(false);

    rerender({ flowsNear: true });

    await waitFor(() => expect(requests).toHaveLength(8));
    expect(requests[7]).toContain("/api/mint-burn-flows");
    queryClient.clear();
  });
});

async function hydrateSavedHtml(html: string, element: ReactElement, expectedText: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  const errors: unknown[] = [];
  const consoleErrors = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = hydrateRoot(container, element, { onRecoverableError: (error) => errors.push(error) });
  try {
    await waitFor(() => expect(container.textContent).toContain(expectedText));
    expect(errors).toEqual([]);
    expect(consoleErrors.mock.calls.filter((args) => /hydration|hydrated|server rendered|did not match/i.test(args.join(" ")))).toEqual([]);
  } finally {
    await act(() => root.unmount());
    consoleErrors.mockRestore();
  }
}

describe("data-health hydration", () => {
  const savedAt = Date.parse("2026-09-06T12:00:00Z");

  it("hydrates a saved fresh query before reclassifying it against the later browser clock", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(savedAt);
    const element = <StaleDataBanner queries={[{
      label: "Liquidity", dataUpdatedAt: savedAt, staleTime: 15 * 60_000, hasData: true,
    }]} />;
    const html = renderToString(element);
    now.mockReturnValue(savedAt + 6 * 3600_000);

    await hydrateSavedHtml(html, element, "Showing an older snapshot");
  });

  it("ages unchanged mounted banner and PSI evidence without another read or incidental rerender", () => {
    vi.useFakeTimers();
    vi.setSystemTime(savedAt);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const meta = { updatedAt: savedAt / 1000, ageSeconds: 0, status: "fresh" as const, freshBudgetSec: 1, degradedBudgetSec: 2 };
    function Beacon() {
      const beacon = usePsiBeaconState({
        current: { score: 95, band: "STEADY", computedAt: savedAt / 1000 },
        meta, dataUpdatedAt: savedAt,
      });
      return <output data-testid="beacon">{beacon.isCurrent ? "current" : "retained"}</output>;
    }
    const mounted = render(<>
      <Beacon />
      <StaleDataBanner queries={[{ label: "Prices", dataUpdatedAt: savedAt, staleTime: 1000, hasData: true, meta }]} />
    </>);
    const banner = () => mounted.container.querySelector("[data-health-state]");
    expect(screen.getByTestId("beacon").textContent).toBe("current");
    expect(banner()).toBeNull();
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.getByTestId("beacon").textContent).toBe("retained");
    // Degraded is operator signal; the public banner waits for the stale band.
    expect(banner()).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(banner()?.getAttribute("data-health-state")).toBe("stale");
    expect(fetch).not.toHaveBeenCalled();
    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hydrates a timestamp across browser timezones before displaying the local time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(savedAt);
    let timeZone = "UTC";
    const original = Date.prototype.toLocaleString;
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (this: Date, locale, options) {
      return original.call(this, locale ?? "en-US", { ...options, timeZone: options?.timeZone ?? timeZone });
    });
    const element = <DataHealthBanner showFreshTimestamp entries={[deriveDataHealth({
      label: "Liquidity", dataUpdatedAt: savedAt, staleTime: 15 * 60_000, hasData: true,
    })]} />;
    const html = renderToString(element);
    expect(html).toContain("UTC");
    timeZone = "America/Los_Angeles";

    await hydrateSavedHtml(html, element, "5:00 AM PDT");
  });

  it("keeps a failed refresh over saved data out of server HTML", () => {
    vi.spyOn(Date, "now").mockReturnValue(savedAt);
    const html = renderToString(<StaleDataBanner queries={[{
      label: "Liquidity", dataUpdatedAt: savedAt, staleTime: 15 * 60_000,
      hasData: true, error: new Error("offline"),
    }]} />);
    expect(html).toBe("");
  });

  it("preserves producer age relative to the saved query receipt in server HTML", () => {
    const html = renderToString(<StaleDataBanner queries={[{
      label: "Liquidity", dataUpdatedAt: savedAt, staleTime: 3600_000, hasData: true,
      meta: { updatedAt: (savedAt - 13 * 3600_000) / 1000, ageSeconds: 13 * 3600, status: "stale" },
    }]} />);
    expect(html).toContain("Showing an older snapshot");
    expect(html).toContain("Last successful update:");
  });

  it("hydrates settled stale reserves without turning a new request receipt into a generation", async () => {
    // Past the 12x public band of the 48h fetch budget (ADR-42).
    vi.spyOn(Date, "now").mockReturnValue(savedAt + 600 * 3600_000);
    const params = makeBuildStablecoinDetailViewModelParams({ supplemental: { reserves: {
      enabled: true, dataUpdatedAt: Date.now(),
      live: {
        mode: "live-stale", reserves: [], estimated: false, liveAt: savedAt / 1000,
        sync: {
          enabled: true, status: "ok", stale: true, bootstrap: false,
          freshness: {
            stale: true, staleReasons: ["fetch-age"], assessedAt: Date.now() / 1000,
            fetchedAt: savedAt / 1000, attemptId: "original-reserve-generation",
            fetchAgeSec: 600 * 3600, fetchBudgetSec: 48 * 3600, freshnessMode: "not-applicable",
            sourceFreshnessInvalid: false, sourceTimestamp: null, sourceAgeSec: null,
            sourceAgeBudgetSec: null, sourceAgeBudgetCap: null,
          },
        },
      },
    } } });
    const queries = buildDetailStaleQueries(params.queries, params.supplemental, "usdt-tether")
      .filter((query) => query.label === "Live Reserves");
    const element = <StaleDataBanner queries={queries} />;
    const html = renderToString(element);
    expect(html).toContain('data-health-state="stale"');
    await hydrateSavedHtml(html, element, "Showing an older snapshot");
  });

  it("hydrates the saved banner before an already-resolved parser read settles its query cache", async () => {
    vi.spyOn(Date, "now").mockReturnValue(savedAt + 10 * 3600_000);
    const id = "usdt-tether";
    const queryKey = FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(id).queryKey;
    const summary = {
      price: 1, circulating: { peggedUSD: 100 }, circulatingPrevDay: {}, circulatingPrevWeek: {},
      circulatingPrevMonth: {}, nativeSupply: { current: 100, prevWeek: 100, prevMonth: 100 },
    } as unknown as StablecoinLiveSummary;
    const settled = {
      data: summary,
      meta: { updatedAt: savedAt / 1000, ageSeconds: 36000, status: "stale" } as ApiMeta,
    };
    const serverClient = new QueryClient();
    const browserClient = new QueryClient();
    for (const client of [serverClient, browserClient]) {
      seedStablecoinDetailQueryCache(client, {
        version: 1, stablecoinId: id, generatedAt: savedAt,
        updatedAt: { liveSummary: savedAt }, lanes: { liveSummary: summary },
      });
    }
    const serverPrefetch = vi.spyOn(serverClient, "prefetchQuery").mockResolvedValue(undefined);
    // Worst-case transport: cache settlement is synchronous when adoption is
    // requested. It must not precede the child's first hydration render.
    const prefetch = vi.spyOn(browserClient, "prefetchQuery").mockImplementation(async () => {
      browserClient.setQueryData(queryKey, settled, { updatedAt: savedAt });
    });
    function SavedFreshnessSlot() {
      const query = useQuery({ queryKey, queryFn: async () => settled, staleTime: Infinity });
      return <StaleDataBanner queries={[{
        label: "Detail snapshot", dataUpdatedAt: query.dataUpdatedAt, staleTime: 15 * 60_000,
        hasData: Boolean(query.data), meta: query.data?.meta,
      }]} />;
    }
    const html = renderToString(
      <QueryClientProvider client={serverClient}>
        <StablecoinDetailLiveSummaryStart id={id}><SavedFreshnessSlot /></StablecoinDetailLiveSummaryStart>
      </QueryClientProvider>,
    );
    expect(serverPrefetch).not.toHaveBeenCalled();
    try {
      await hydrateSavedHtml(html,
        <QueryClientProvider client={browserClient}>
          <StablecoinDetailLiveSummaryStart id={id}><SavedFreshnessSlot /></StablecoinDetailLiveSummaryStart>
        </QueryClientProvider>,
        "Showing an older snapshot",
      );
      expect(prefetch).toHaveBeenCalledTimes(1);
    } finally {
      serverClient.clear();
      browserClient.clear();
    }
  });

});

describe("stablecoin detail request budget", () => {
  // Nightly tier: renders the view model once per frozen profile (~40 renderHook/waitFor
  // boots). The PR tier keeps the frozen gate in use-stablecoin-detail-view-model.test.tsx
  // "disables every current-only lane, health entry and retry despite open viewport controls",
  // the frozen prefetch skip in src/app/stablecoin/[id]/client.test.tsx "starts no current
  // summary read for a frozen archive, unlike an active control", and the per-profile
  // snapshot invariant in shared/lib/stablecoins/__tests__/registry.test.ts.
  it("census: every frozen profile reads no current-only lane with every viewport gate open", { tags: ["nightly"] }, async () => {
    const frozen = [...TRACKED_META_BY_ID.values()].filter((coin) => coin.status === "frozen");
    expect(frozen.length).toBeGreaterThan(0);
    const forbidden = /\/api\/(?:stablecoin-live-summary|dex-liquidity|report-cards|redemption-backstop|yield-rankings|stress-signals|mint-burn-flows|stablecoin-reserves)/;
    for (const coin of frozen) {
      const requests: string[] = [];
      vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
        requests.push(String(input));
        return new Promise<Response>(() => {});
      }));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <StablecoinDetailLiveSummaryStart id={coin.id} frozen>{children}</StablecoinDetailLiveSummaryStart>
        </QueryClientProvider>
      );
      renderHook(() => useStablecoinDetailViewModel({
        id: coin.id, coin, summary: null,
        supplementalQueryControls: {
          liquidity: true, reportCards: true, redemption: true, yield: true,
          stress: true, flows: true, blacklist: true, reserves: true,
        },
      }), { wrapper });
      // History lanes (supply history) still start; current-only lanes never do.
      await waitFor(() => expect(requests.some((path) => path.includes(`/api/supply-history?stablecoin=${coin.id}&days=90`))).toBe(true));
      expect(requests.filter((path) => forbidden.test(path))).toEqual([]);
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });

  it("hydrates fresh eager lanes before observers mount and refetches an expired snapshot", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      requests.push(String(input));
      return new Promise<Response>(() => {});
    }));
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const renderWithSnapshot = (snapshot: StablecoinDetailSnapshot) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <StablecoinDetailSnapshotHydrator snapshot={snapshot}>
            <StablecoinDetailLiveSummaryStart id={coin.id}>{children}</StablecoinDetailLiveSummaryStart>
          </StablecoinDetailSnapshotHydrator>
        </QueryClientProvider>
      );
      const rendered = renderHook(() => useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
      }), { wrapper });
      return { queryClient, ...rendered };
    };

    const fresh = renderWithSnapshot(detailSnapshot(Date.now()));
    await waitFor(() => expect(fresh.result.current.status).toBe("ready"));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toContain("/api/peg-summary");
    expect(fresh.queryClient.getQueryState(["stablecoins"])).toBeUndefined();
    expect(fresh.queryClient.getQueryState(["peg-summary"])).toBeDefined();
    expect(fresh.queryClient.getQueryData(["stablecoin-live-summary", "usdt-tether"])).toBeDefined();
    fresh.unmount();
    fresh.queryClient.clear();
    requests.length = 0;

    const expired = renderWithSnapshot(detailSnapshot(Date.now() - 25 * 60 * 60 * 1000));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests).toEqual(expect.arrayContaining([
      expect.stringContaining("/api/stablecoin-live-summary/usdt-tether"),
      expect.stringContaining("/api/peg-summary"),
      expect.stringContaining("/api/supply-history?stablecoin=usdt-tether&days=90"),
    ]));
    expired.unmount();
    expired.queryClient.clear();
  });

  it("starts the stale summary after the saved child render and deduplicates its read", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      requests.push(String(input));
      return new Promise<Response>(() => {});
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const snapshot = detailSnapshot(Date.now() - 10 * 60 * 1000);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <StablecoinDetailSnapshotHydrator snapshot={snapshot}>
          <StablecoinDetailLiveSummaryStart id={coin.id}>{children}</StablecoinDetailLiveSummaryStart>
        </StablecoinDetailSnapshotHydrator>
      </QueryClientProvider>
    );
    let firstFetchStatus: string | undefined;
    const { rerender, unmount } = renderHook(() => {
      firstFetchStatus ??= queryClient.getQueryState(["stablecoin-live-summary", coin.id])?.fetchStatus;
      return useStablecoinDetailViewModel({
        id: coin.id, coin, summary: null, supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
      });
    }, { wrapper });
    expect(firstFetchStatus).toBe("idle");
    await waitFor(() => expect(requests.filter((path) => path.includes("/stablecoin-live-summary/"))).toHaveLength(1));
    expect(requests[0]).toContain("/stablecoin-live-summary/usdt-tether");
    expect(requests.some((path) => path.includes("/stablecoin/"))).toBe(false);
    rerender();
    expect(requests.filter((path) => path.includes("/stablecoin-live-summary/"))).toHaveLength(1);
    unmount();
    queryClient.clear();
  });
});
