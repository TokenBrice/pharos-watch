// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { buildDetailStaleQueries } from "@/lib/stablecoin-detail-query-view-model";
import { makeBuildStablecoinDetailViewModelParams } from "@/lib/__tests__/fixtures/stablecoin-detail-view-model";

const DAY = 86_400;

afterEach(() => {
  vi.useRealTimers();
});

describe("detail page reserve freshness banner", () => {
  it("warns when the fetch clock crosses its 24d public band though the source 1x budget expired first", async () => {
    vi.useFakeTimers();
    const fetchedAt = 1_790_000_000;
    const sourceAt = fetchedAt - 34 * DAY;
    // Mounted just before the fetch clock's 12x band (2d budget -> 24d).
    vi.setSystemTime(new Date((fetchedAt + 24 * DAY) * 1000 - 1000));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const live = {
      mode: "live-stale" as const, reserves: [], estimated: false, liveAt: fetchedAt,
      sync: {
        enabled: true, status: "degraded" as const, stale: true, bootstrap: false,
        freshness: {
          stale: true, staleReasons: ["source-age"], assessedAt: fetchedAt, fetchedAt, attemptId: "attempt",
          fetchAgeSec: 0, fetchBudgetSec: 2 * DAY, freshnessMode: "verified" as const,
          sourceFreshnessInvalid: false, sourceTimestamp: sourceAt, sourceAgeSec: 34 * DAY,
          sourceAgeBudgetSec: 30 * DAY, sourceAgeBudgetCap: "scoring" as const,
        },
      },
    };
    const params = makeBuildStablecoinDetailViewModelParams({ supplemental: {
      reserves: { live, enabled: true, dataUpdatedAt: fetchedAt * 1000 },
    } });
    const queries = buildDetailStaleQueries(params.queries, params.supplemental, "usdt-tether")
      .filter((query) => query.label === "Live Reserves");

    render(<StaleDataBanner queries={queries} />);
    // Hydration (two frames) and the boundary hook's re-anchor run on the faked clock.
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.queryByRole("status")).toBeNull();

    // Exactly 24d is still inside the band; the boundary timer fires at +1ms.
    await act(async () => { await vi.advanceTimersByTimeAsync(901); });
    expect(screen.getByRole("status").textContent).toContain("Live Reserves");
    expect(screen.getByRole("status").getAttribute("data-health-state")).toBe("stale");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
