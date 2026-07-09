import { beforeEach, describe, expect, it, vi } from "vitest";

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: Symbol("keepPreviousData"),
  useQuery: useQueryMock,
}));

import { CRON_15MIN } from "@/lib/cron-intervals";
import { useUsdsStatus } from "../api-hooks";

describe("useUsdsStatus", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
      isFetching: false,
      dataUpdatedAt: 0,
    });
  });

  it("uses the shared USDS status descriptor options", () => {
    useUsdsStatus();

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["usds-status"],
        staleTime: CRON_15MIN,
        refetchInterval: 2 * CRON_15MIN,
      }),
    );
  });
});
