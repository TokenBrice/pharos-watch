import { beforeEach, describe, expect, it, vi } from "vitest";

const { useRegisteredApiQueryMock } = vi.hoisted(() => ({
  useRegisteredApiQueryMock: vi.fn(),
}));

vi.mock("../api-hooks", () => ({
  useRegisteredApiQuery: useRegisteredApiQueryMock,
}));

import { useBlacklistEventsPage } from "../use-blacklist-events";
import type { FetchBlacklistEventsParams } from "@/lib/blacklist-api";

// The request path is owned by `blacklist-api.test.ts`; what only this hook can
// lose is cache identity — every filter must reach the query key, or two filter
// selections share one cached page.
describe("useBlacklistEventsPage", () => {
  beforeEach(() => {
    useRegisteredApiQueryMock.mockReset();
  });

  it.each([
    {
      name: "every filter",
      params: {
        stablecoin: "USDC",
        chainName: "Ethereum",
        eventType: "blacklist" as const,
        query: "0xabc",
        sortBy: "stablecoin" as const,
        sortDirection: "asc" as const,
        limit: 25,
        offset: 50,
        includeTotal: true,
      },
      queryKey: ["blacklist-events", "USDC", "Ethereum", "blacklist", "0xabc", "stablecoin", "asc", 25, 50, "first", true],
    },
    {
      name: "stable defaults",
      params: {},
      queryKey: ["blacklist-events", "all", "all", "all", "", "date", "desc", 50, 0, "first", false],
    },
  ] as Array<{ name: string; params: FetchBlacklistEventsParams; queryKey: unknown[] }>)(
    "identifies a page by $name",
    ({ params, queryKey }) => {
      useBlacklistEventsPage(params);

      expect(useRegisteredApiQueryMock).toHaveBeenCalledWith(expect.objectContaining({ queryKey }), { retry: 1 });
    },
  );
});
