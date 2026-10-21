// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaleDataBanner, type StaleQuery } from "@/components/stale-data-banner";
import { formatDataHealthTimestamp } from "@/lib/data-health";
import { buildDetailStaleQueries } from "@/lib/stablecoin-detail-query-view-model";
import { makeBuildStablecoinDetailViewModelParams } from "@/lib/__tests__/fixtures/stablecoin-detail-view-model";

// These state-transition tests exercise the hydrated view; SSR/localization has its own hydration suite.
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

const now = Date.parse("2026-10-18T12:00:00Z");
const producer = now - 10 * 3600_000;
const seed: StaleQuery = {
  label: "Detail snapshot", staleTime: 15 * 60_000, hasData: true,
  dataUpdatedAt: now, meta: { updatedAt: producer / 1000, status: "fresh", ageSeconds: 36000 },
  isSnapshot: true, isFetching: true, isFetchedAfterMount: false,
};

afterEach(() => vi.restoreAllMocks());

describe("detail freshness slot", () => {
  it("uses the saved producer clock and approved copy during the first snapshot refresh", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { container } = render(<StaleDataBanner persistent queries={[seed]} />);
    expect(container.textContent).toContain(`Refreshing… saved data from ${formatDataHealthTimestamp(producer)}`);
    expect(container.textContent).toContain("freshness budget 2h");
    expect(container.textContent).not.toContain("Showing an older snapshot");
    expect(container.querySelector("[data-freshness-slot]")?.getAttribute("data-health-state")).toBe("refreshing");
  });

  it("retains the same slot and footprint through refreshing, error, HTTP-200 stale and fresh settlement", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const retry = vi.fn();
    const { container, rerender, getByRole } = render(<StaleDataBanner persistent queries={[seed]} onRetry={retry} />);
    const slot = container.querySelector("[data-freshness-slot]")!;
    const footprint = () => slot.className.split(" ").filter((name) => /^(?:sm:)?(?:min-)?h-/.test(name));
    const initial = footprint();
    expect(initial).toEqual(["h-12"]);
    rerender(<StaleDataBanner persistent queries={[{ ...seed, error: new Error("offline"), isFetching: false }]} onRetry={retry} />);
    expect(container.querySelector("[data-freshness-slot]")).toBe(slot);
    expect(slot.getAttribute("data-health-state")).toBe("stale");
    expect(slot.textContent).toContain("Showing an older snapshot");
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(footprint()).toEqual(initial);
    rerender(<StaleDataBanner persistent queries={[{ ...seed, isFetchedAfterMount: true, isSnapshot: false, meta: { ...seed.meta, status: "stale" } }]} />);
    expect(slot.textContent).toContain("Showing an older snapshot");
    expect(slot.textContent).not.toContain("Refreshing…");
    expect(footprint()).toEqual(initial);
    rerender(<StaleDataBanner persistent queries={[{ ...seed, isSnapshot: false, isFetching: false, isFetchedAfterMount: true, meta: { updatedAt: now / 1000, status: "fresh", ageSeconds: 0 } }]} />);
    expect(slot.getAttribute("data-health-state")).toBe("fresh");
    expect(slot.textContent).toContain("Latest monitored generation:");
    expect(footprint()).toEqual(initial);
    const disclosure = slot.querySelector("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(disclosure.open).toBe(true);
    expect(disclosure.querySelector("div")?.className).toContain("absolute");
    expect(footprint()).toEqual(initial);
  });

  it("does not hide a settled stale verdict during subsequent polling or a route remount", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { container } = render(<StaleDataBanner persistent queries={[{ ...seed, isSnapshot: false }]} />);
    expect(container.textContent).toContain("Showing an older snapshot");
    expect(container.textContent).not.toContain("Refreshing…");
  });

  it("keeps a source advisory visible while the snapshot refresh is in flight", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { container } = render(<StaleDataBanner persistent queries={[{ ...seed, meta: { ...seed.meta, warning: '199 - "Quality drift"' } }]} />);
    expect(container.textContent).toContain("Showing an older snapshot");
    expect(container.textContent).not.toContain("Refreshing…");
  });

  it("reserves the pending footprint without a seed and never fabricates a missing producer clock", () => {
    const { container, rerender } = render(<StaleDataBanner persistent queries={[{ label: "Detail snapshot", dataUpdatedAt: 0, hasData: false, isLoading: true }]} />);
    const slot = container.querySelector("[data-freshness-slot]")!;
    expect(slot.getAttribute("data-health-state")).toBe("pending");
    rerender(<StaleDataBanner persistent queries={[{ ...seed, meta: { updatedAt: null, ageSeconds: null, status: "unknown", reason: "snapshot-producer-timestamp-unavailable" } }]} />);
    expect(container.querySelector("[data-freshness-slot]")).toBe(slot);
    expect(slot.getAttribute("data-health-state")).toBe("unavailable");
    expect(slot.textContent).toContain("producer generation unknown");
    expect(slot.textContent).not.toContain("Refreshing…");
  });

  it("keeps retained browser evidence explicitly stale in the compact summary", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const meta = { updatedAt: producer / 1000, ageSeconds: 36000, status: "stale" as const, reason: "retained-browser-evidence" };
    const { container, rerender } = render(<StaleDataBanner persistent queries={[{
      ...seed, isSnapshot: false, meta,
    }]} />);
    expect(container.querySelector("[data-freshness-slot]")?.getAttribute("data-health-state")).toBe("stale");
    expect(container.querySelector("[data-freshness-slot] > p")?.textContent).toBe("Retained data (stale); checking live generation");
    expect(container.textContent).toContain(`saved generation ${formatDataHealthTimestamp(producer)}`);
    rerender(<StaleDataBanner persistent queries={[{ ...seed, isSnapshot: false, meta, error: new Error("offline") }]} />);
    expect(container.querySelector("[data-freshness-slot] > p")?.textContent).toBe("Showing an older snapshot");
    expect(container.textContent).not.toContain("Refreshing…");
  });

  it.each(["live-stale", "curated-fallback", "template-fallback", "missing-clock"] as const)(
    "never labels a fresh reserves request receipt as a generation for %s",
    (mode) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      const params = makeBuildStablecoinDetailViewModelParams({ supplemental: { reserves: {
        enabled: true, dataUpdatedAt: now,
        live: {
          mode: mode === "missing-clock" ? "live" : mode, reserves: [], estimated: false,
          ...(mode === "missing-clock" ? {} : { liveAt: producer / 1000 }),
          sync: {
            enabled: true, status: "ok", stale: mode === "live-stale", bootstrap: false,
            ...(mode === "missing-clock" ? {} : { freshness: {
              stale: mode === "live-stale", staleReasons: ["fetch-age"], assessedAt: now / 1000,
              fetchedAt: producer / 1000, attemptId: "original-reserve-attempt",
              fetchAgeSec: 36000, fetchBudgetSec: 18000, freshnessMode: "not-applicable",
              sourceFreshnessInvalid: false, sourceTimestamp: null, sourceAgeSec: null,
              sourceAgeBudgetSec: null, sourceAgeBudgetCap: null,
            } }),
          },
        },
      } } });
      const queries = buildDetailStaleQueries(params.queries, params.supplemental, "usdt-tether")
        .filter((entry) => entry.label === "Live Reserves");
      const { container } = render(<StaleDataBanner persistent queries={queries} />);
      const slot = container.querySelector("[data-freshness-slot]")!;
      expect(slot.getAttribute("data-health-state")).not.toBe("fresh");
      expect(slot.textContent).not.toContain(`saved generation ${formatDataHealthTimestamp(now)}`);
      const details = slot.querySelector("details")!;
      expect(details.textContent).toContain(mode === "missing-clock" ? "producer generation unknown" : mode);
      if (mode === "live-stale") {
        expect(details.textContent).toContain(`saved generation ${formatDataHealthTimestamp(producer)}`);
        expect(details.textContent).toContain("freshness budget 5h");
        expect(details.textContent).toContain("original-reserve-attempt");
      } else {
        expect(details.textContent).toContain("freshness budget unknown");
      }
    },
  );
});
