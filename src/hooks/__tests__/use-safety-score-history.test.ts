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

import { CRON_24H } from "@/lib/cron-intervals";
import { useSafetyScoreHistory } from "../api-hooks";

describe("useSafetyScoreHistory", () => {
  beforeEach(() => {
    useApiQueryWithMetaMock.mockReset();
    useApiQueryWithMetaMock.mockReturnValue({
      data: [],
      meta: null,
      error: null,
      isLoading: false,
      isFetching: false,
      dataUpdatedAt: 0,
    });
  });

  it("uses stablecoin-scoped key and daily polling policy", async () => {
    useSafetyScoreHistory("usdt-tether");

    expect(useApiQueryWithMetaMock).toHaveBeenCalledWith(
      ["safety-score-history", "usdt-tether", 3650],
      "/api/safety-score-history?stablecoin=usdt-tether&days=3650",
      CRON_24H,
      expect.objectContaining({
        enabled: true,
        metaMaxAgeSec: CRON_24H / 1000,
      }),
    );
  });

  it("disables query when stablecoin id is empty", () => {
    useSafetyScoreHistory("");

    expect(useApiQueryWithMetaMock).toHaveBeenCalledWith(
      ["safety-score-history", "", 3650],
      "/api/safety-score-history?stablecoin=&days=3650",
      CRON_24H,
      expect.objectContaining({
        enabled: false,
      }),
    );
  });
});
