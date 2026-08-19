import { beforeEach, describe, expect, it, vi } from "vitest";

const { keepPreviousDataMock, useQueryMock } = vi.hoisted(() => ({
  keepPreviousDataMock: Symbol("keepPreviousData"),
  useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: keepPreviousDataMock,
  useQuery: useQueryMock,
}));

import { useYieldRankingsSummary } from "../api-hooks";

describe("useYieldRankingsSummary", () => {
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

  it("keeps the previous rankings visible across refetches", () => {
    useYieldRankingsSummary();

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["yield-rankings", "summary"],
        placeholderData: keepPreviousDataMock,
      }),
    );
  });
});
