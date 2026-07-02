import { beforeEach, describe, expect, it, vi } from "vitest";

const { useApiQueryMock } = vi.hoisted(() => ({
  useApiQueryMock: vi.fn(),
}));

vi.mock("../use-api-query", async () => {
  const actual = await vi.importActual<typeof import("../use-api-query")>("../use-api-query");
  return {
    ...actual,
    useApiQuery: useApiQueryMock,
  };
});

import { CRON_15MIN } from "@/lib/cron-intervals";
import { FRONTEND_API_QUERY_RUNTIME_REGISTRY } from "@/lib/api-query-runtime-registry";
import { useUsdsStatus } from "../api-hooks";

describe("useUsdsStatus", () => {
  beforeEach(() => {
    useApiQueryMock.mockReset();
    useApiQueryMock.mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
      isFetching: false,
      dataUpdatedAt: 0,
    });
  });

  it("uses the shared USDS status descriptor options", () => {
    useUsdsStatus();

    expect(useApiQueryMock).toHaveBeenCalledWith(
      ["usds-status"],
      "/api/usds-status",
      CRON_15MIN,
      expect.objectContaining({
        schema: FRONTEND_API_QUERY_RUNTIME_REGISTRY.usdsStatus.schema,
      }),
    );
  });
});
