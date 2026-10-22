// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaleDataBanner, type StaleQuery } from "@/components/stale-data-banner";
import { buildDetailStaleQueries } from "@/lib/stablecoin-detail-query-view-model";
import { deriveDataHealth, isPublicWarning } from "@/lib/data-health";
import { makeBuildStablecoinDetailViewModelParams } from "@/lib/__tests__/fixtures/stablecoin-detail-view-model";

vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

const now = Date.parse("2026-10-18T12:00:00Z");
const producer = now - 10 * 3600_000;
const seed: StaleQuery = {
  label: "Detail snapshot", staleTime: 15 * 60_000, hasData: true,
  dataUpdatedAt: now, meta: { updatedAt: producer / 1000, status: "fresh", ageSeconds: 36000 },
};

afterEach(() => vi.restoreAllMocks());

describe("detail health notice", () => {
  it("renders nothing while every lane is fresh or only degraded", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fresh = { ...seed, meta: { updatedAt: now / 1000, status: "fresh" as const, ageSeconds: 0 } };
    expect(render(<StaleDataBanner queries={[fresh]} />).container.textContent).toBe("");
    const advisory = { ...fresh, meta: { ...fresh.meta, warning: '199 - "Quality drift"' } };
    expect(render(<StaleDataBanner queries={[advisory]} />).container.textContent).toBe("");
    expect(render(<StaleDataBanner queries={[{ ...fresh, error: new Error("offline") }]} />).container.textContent).toBe("");
  });

  it("names a producer several cycles late and offers retry after a failed read", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const retry = vi.fn();
    const { container, getByRole } = render(<StaleDataBanner queries={[{ ...seed, error: new Error("offline") }]} onRetry={retry} />);
    expect(container.textContent).toContain("Showing an older snapshot");
    expect(container.querySelector("[data-health-state]")?.getAttribute("data-health-state")).toBe("stale");
    getByRole("button", { name: "Retry" }).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps a live reserve book with an unreadable constituent off the page", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const params = makeBuildStablecoinDetailViewModelParams({ supplemental: { reserves: {
      enabled: true, dataUpdatedAt: now,
      live: {
        mode: "live", reserves: [], estimated: false, liveAt: now / 1000,
        sync: {
          enabled: true, status: "degraded", stale: false, bootstrap: false,
          warnings: ["liquity-v2-branches unavailable or unclassified constituents: WETH (balance-unavailable)"],
          freshness: {
            stale: false, staleReasons: [], assessedAt: now / 1000, fetchedAt: now / 1000, attemptId: "bold-attempt",
            fetchAgeSec: 0, fetchBudgetSec: 172800, freshnessMode: "not-applicable",
            sourceFreshnessInvalid: false, sourceTimestamp: null, sourceAgeSec: null,
            sourceAgeBudgetSec: null, sourceAgeBudgetCap: null,
          },
        },
      },
    } } });
    const queries = buildDetailStaleQueries(params.queries, params.supplemental, "bold-liquity")
      .filter((entry) => entry.label === "Live Reserves");
    expect(queries[0].meta?.status).toBe("degraded");
    expect(render(<StaleDataBanner queries={queries} />).container.textContent).toBe("");
  });

  it.each(["live-stale", "curated-fallback", "template-fallback", "missing-clock"] as const)(
    "never treats a fresh reserves request receipt as a generation for %s",
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
      const [reserves] = buildDetailStaleQueries(params.queries, params.supplemental, "usdt-tether")
        .filter((entry) => entry.label === "Live Reserves");
      expect(reserves.dataUpdatedAt).not.toBe(now);
      if (mode === "live-stale") {
        expect(reserves.dataUpdatedAt).toBe(producer);
        // 2x the 5h fetch budget is operator signal; readers see the banner only past 12x (ADR-42).
        const { container, unmount } = render(<StaleDataBanner queries={[reserves]} />);
        expect(container.textContent).not.toContain("Showing an older snapshot");
        unmount();
        const input = { ...reserves, label: "Live Reserves", staleTime: reserves.staleTime! };
        expect(isPublicWarning(deriveDataHealth(input, now))).toBe(false);
        expect(deriveDataHealth(input, producer + 12 * 18_000_000 + 1).state).toBe("stale");
      }
    },
  );
});
