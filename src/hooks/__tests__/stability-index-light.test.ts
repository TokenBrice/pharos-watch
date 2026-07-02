import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchWithMetaMock, keepPreviousDataMock, useQueryMock } = vi.hoisted(() => ({
  apiFetchWithMetaMock: vi.fn(),
  keepPreviousDataMock: Symbol("keepPreviousData"),
  useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: keepPreviousDataMock,
  useQuery: useQueryMock,
}));

vi.mock("@/lib/api", () => ({
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

import { FRONTEND_API_QUERY_RUNTIME_REGISTRY } from "@/lib/api-query-runtime-registry";
import { useStabilityIndexLight } from "../use-stability-index-light";

type CapturedQueryOptions = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  retry?: number | boolean;
};

function queryResult(data: unknown) {
  return {
    data,
    dataUpdatedAt: 0,
    error: null,
    isFetching: false,
    isLoading: false,
  };
}

function capturedOptions(): CapturedQueryOptions {
  expect(useQueryMock).toHaveBeenCalledTimes(1);
  return useQueryMock.mock.calls[0][0] as CapturedQueryOptions;
}

describe("useStabilityIndexLight", () => {
  beforeEach(() => {
    apiFetchWithMetaMock.mockReset();
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue(queryResult(undefined));
  });

  it("uses the registered stability index key and meta-compatible cached value", async () => {
    const descriptor = FRONTEND_API_QUERY_RUNTIME_REGISTRY.stabilityIndex;
    const cachedValue = {
      data: { current: null, history: [] },
      meta: { ageSeconds: 0, status: "fresh", updatedAt: 1 },
    };
    useQueryMock.mockReturnValue(queryResult(cachedValue));
    apiFetchWithMetaMock.mockResolvedValue(cachedValue);

    const result = useStabilityIndexLight();
    const options = capturedOptions();

    expect(options.queryKey).toEqual(descriptor.queryKey);
    expect(options.retry).toBe(2);
    expect(result.data).toBe(cachedValue.data);
    expect(result.meta).toBe(cachedValue.meta);
    await expect(options.queryFn()).resolves.toBe(cachedValue);
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      descriptor.path,
      expect.objectContaining({ safeParse: expect.any(Function) }),
      undefined,
      descriptor.metaMaxAgeSec,
      undefined,
    );
  });
});
