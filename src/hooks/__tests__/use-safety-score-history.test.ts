import { beforeEach, describe, expect, it, vi } from "vitest";

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: Symbol("keepPreviousData"),
  useQuery: useQueryMock,
}));

import { CRON_24H } from "@/lib/cron-intervals";
import { useSafetyScoreHistory, useSafetyScoreHistoryV2 } from "../api-hooks";

describe("useSafetyScoreHistory", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({
      data: { data: [], meta: null },
      error: null,
      isLoading: false,
      isFetching: false,
      dataUpdatedAt: 0,
    });
  });

  it("uses stablecoin-scoped key and daily polling policy", async () => {
    useSafetyScoreHistory("usdt-tether");

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["safety-score-history", "usdt-tether", 3650],
        staleTime: CRON_24H,
        refetchInterval: 2 * CRON_24H,
        enabled: true,
      }),
    );
  });

  it("disables query when stablecoin id is empty", () => {
    useSafetyScoreHistory("");

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["safety-score-history", "", 3650],
        enabled: false,
      }),
    );
  });

  it("uses the identity-aware history endpoint with the same polling policy", () => {
    useSafetyScoreHistoryV2("usdt-tether");

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["safety-score-history-v2", "usdt-tether", 3650],
        staleTime: CRON_24H,
        refetchInterval: 2 * CRON_24H,
        enabled: true,
      }),
    );
  });
});
