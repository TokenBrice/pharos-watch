// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act, render, screen, waitFor } from "@testing-library/react";
import { DataHealthBanner } from "@/components/data-health-banner";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { deriveDataHealth } from "@/lib/data-health";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StablecoinDetailLiveSummaryStart } from "@/app/stablecoin/[id]/client";
import { seedStablecoinDetailQueryCache, type ApiMeta } from "@/lib/api";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";

import { buildDetailStaleQueries } from "@/lib/stablecoin-detail-query-view-model";
import { makeBuildStablecoinDetailViewModelParams } from "@/lib/__tests__/fixtures/stablecoin-detail-view-model";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";
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
    vi.spyOn(Date, "now").mockReturnValue(savedAt + 72 * 3600_000);
    const params = makeBuildStablecoinDetailViewModelParams({ supplemental: { reserves: {
      enabled: true, dataUpdatedAt: Date.now(),
      live: {
        mode: "live-stale", reserves: [], estimated: false, liveAt: savedAt / 1000,
        sync: {
          enabled: true, status: "ok", stale: true, bootstrap: false,
          freshness: {
            stale: true, staleReasons: ["fetch-age"], assessedAt: Date.now() / 1000,
            fetchedAt: savedAt / 1000, attemptId: "original-reserve-generation",
            fetchAgeSec: 72 * 3600, fetchBudgetSec: 48 * 3600, freshnessMode: "not-applicable",
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
    } as StablecoinLiveSummary;
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
