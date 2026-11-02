// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { DataHealthBanner } from "@/components/data-health-banner";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { deriveDataHealth } from "@/lib/data-health";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StablecoinDetailLiveSummaryStart, StablecoinDetailSnapshotHydrator } from "@/app/stablecoin/[id]/client";
import { seedStablecoinDetailQueryCache, type ApiMeta, type StablecoinDetailSnapshot } from "@/lib/api";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";

import { buildDetailStaleQueries } from "@/lib/stablecoin-detail-query-view-model";
import { makeBuildStablecoinDetailViewModelParams } from "@/lib/__tests__/fixtures/stablecoin-detail-view-model";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";
import { useStablecoinDetailViewModel } from "@/hooks/use-stablecoin-detail-view-model";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "@/hooks/__tests__/use-stablecoin-detail-view-model.test-support";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReactNode } from "react";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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

function detailRequestBudgetSnapshot(generatedAt: number): StablecoinDetailSnapshot {
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

    const fresh = renderWithSnapshot(detailRequestBudgetSnapshot(Date.now()));
    await waitFor(() => expect(fresh.result.current.status).toBe("ready"));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toContain("/api/peg-summary");
    expect(fresh.queryClient.getQueryState(["stablecoins"])).toBeUndefined();
    expect(fresh.queryClient.getQueryState(["peg-summary"])).toBeDefined();
    expect(fresh.queryClient.getQueryData(["stablecoin-live-summary", "usdt-tether"])).toBeDefined();
    fresh.unmount();
    fresh.queryClient.clear();
    requests.length = 0;

    const expired = renderWithSnapshot(detailRequestBudgetSnapshot(Date.now() - 25 * 60 * 60 * 1000));
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
    const snapshot = detailRequestBudgetSnapshot(Date.now() - 10 * 60 * 1000);
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
