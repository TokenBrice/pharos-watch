import { beforeEach, describe, expect, it, vi } from "vitest";

const { useRegisteredApiQueryMock } = vi.hoisted(() => ({
  useRegisteredApiQueryMock: vi.fn(),
}));

vi.mock("../api-hooks", () => ({
  useRegisteredApiQuery: useRegisteredApiQueryMock,
}));

import { useBlacklistEventsPage } from "../use-blacklist-events";

describe("useBlacklistEventsPage", () => {
  beforeEach(() => {
    useRegisteredApiQueryMock.mockReset();
  });

  it("includes sort fields in the query key", () => {
    useBlacklistEventsPage({
      stablecoin: "USDC",
      chainName: "Ethereum",
      eventType: "blacklist",
      query: "0xabc",
      sortBy: "stablecoin",
      sortDirection: "asc",
      limit: 25,
      offset: 50,
      includeTotal: true,
    });

    expect(useRegisteredApiQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [
          "blacklist-events",
          "USDC",
          "Ethereum",
          "blacklist",
          "0xabc",
          "stablecoin",
          "asc",
          25,
          50,
          "first",
          true,
        ],
        path: "/api/blacklist?stablecoin=USDC&chain=Ethereum&eventType=blacklist&q=0xabc&sortBy=stablecoin&sortDirection=asc&limit=25&offset=50&includeTotal=true",
      }),
      { retry: 1 },
    );
  });

  it("uses stable sort defaults in the query key", () => {
    useBlacklistEventsPage({});

    expect(useRegisteredApiQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["blacklist-events", "all", "all", "all", "", "date", "desc", 50, 0, "first", false],
        path: "/api/blacklist",
      }),
      { retry: 1 },
    );
  });
});
