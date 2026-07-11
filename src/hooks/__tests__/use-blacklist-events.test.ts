import { beforeEach, describe, expect, it, vi } from "vitest";

const { useApiQueryWithMetaMock } = vi.hoisted(() => ({
  useApiQueryWithMetaMock: vi.fn(),
}));

vi.mock("../use-api-query", async () => {
  const actual = await vi.importActual<typeof import("../use-api-query")>("../use-api-query");
  return {
    ...actual,
    useApiQueryWithMeta: useApiQueryWithMetaMock,
  };
});

import { CRON_BLACKLIST } from "@/lib/cron-intervals";
import { useBlacklistEventsPage } from "../use-blacklist-events";

describe("useBlacklistEventsPage", () => {
  beforeEach(() => {
    useApiQueryWithMetaMock.mockReset();
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

    expect(useApiQueryWithMetaMock).toHaveBeenCalledWith(
      [
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
      "/api/blacklist?stablecoin=USDC&chain=Ethereum&eventType=blacklist&q=0xabc&sortBy=stablecoin&sortDirection=asc&limit=25&offset=50&includeTotal=true",
      CRON_BLACKLIST,
      expect.anything(),
    );
  });

  it("uses stable sort defaults in the query key", () => {
    useBlacklistEventsPage({});

    expect(useApiQueryWithMetaMock).toHaveBeenCalledWith(
      ["blacklist-events", "all", "all", "all", "", "date", "desc", 50, 0, "first", false],
      "/api/blacklist",
      CRON_BLACKLIST,
      expect.anything(),
    );
  });
});
