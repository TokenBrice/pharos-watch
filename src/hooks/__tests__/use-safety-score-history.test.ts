import { beforeEach, describe, expect, it, vi } from "vitest";

const { useQueryMock, apiFetchMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  apiFetchMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: apiFetchMock,
  apiFetchWithMeta: vi.fn(),
}));

import { CRON_24H } from "@/lib/cron-intervals";
import { useSafetyScoreHistory } from "../api-hooks";

describe("useSafetyScoreHistory", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    apiFetchMock.mockReset().mockResolvedValue([]);
    useQueryMock.mockReturnValue({
      data: [],
      error: null,
      isLoading: false,
      isFetching: false,
      dataUpdatedAt: 0,
    });
  });

  it("uses stablecoin-scoped key and daily polling policy", async () => {
    useSafetyScoreHistory("usdt-tether");

    const options = useQueryMock.mock.calls[0][0] as {
      queryKey: unknown[];
      staleTime: number;
      refetchInterval: number;
      queryFn: () => Promise<unknown>;
    };

    expect(options.queryKey).toEqual(["safety-score-history", "usdt-tether", 3650]);
    expect(options.staleTime).toBe(CRON_24H);
    expect(options.refetchInterval).toBe(2 * CRON_24H);

    await options.queryFn();
    const call = apiFetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/safety-score-history?stablecoin=usdt-tether&days=3650");
    expect(call?.[1]).toEqual(expect.any(Object));
  });

  it("disables query when stablecoin id is empty", () => {
    useSafetyScoreHistory("");

    const options = useQueryMock.mock.calls[0][0] as { enabled: boolean };
    expect(options.enabled).toBe(false);
  });
});
