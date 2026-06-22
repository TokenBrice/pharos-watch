import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, apiFetchWithMetaMock, keepPreviousDataMock, useQueryMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  apiFetchWithMetaMock: vi.fn(),
  keepPreviousDataMock: Symbol("keepPreviousData"),
  useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: keepPreviousDataMock,
  useQuery: useQueryMock,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: apiFetchMock,
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";
import {
  useSidebarBlacklistSignal,
  useSidebarDailyDigestSignal,
  useSidebarHealthSignal,
  useSidebarPegSummarySignal,
} from "../use-sidebar-nav-signal-data";
import { useStabilityIndexLight } from "../use-stability-index-light";

type CapturedQueryOptions = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled?: boolean;
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

describe("sidebar/light query cache shape", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchWithMetaMock.mockReset();
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue(queryResult(undefined));
  });

  it("uses the registered peg summary key and meta-compatible cached value", async () => {
    const descriptor = FRONTEND_API_QUERY_REGISTRY.pegSummary;
    const cachedValue = {
      data: { coins: [] },
      meta: { ageSeconds: 0, status: "fresh", updatedAt: 1 },
    };
    useQueryMock.mockReturnValue(queryResult(cachedValue));
    apiFetchWithMetaMock.mockResolvedValue(cachedValue);

    const result = useSidebarPegSummarySignal();
    const options = capturedOptions();

    expect(options.queryKey).toEqual(descriptor.queryKey);
    expect(options.retry).toBe(1);
    expect(result.data).toBe(cachedValue.data);
    expect(result.meta).toBe(cachedValue.meta);
    await expect(options.queryFn()).resolves.toBe(cachedValue);
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      descriptor.path,
      descriptor.schema,
      undefined,
      descriptor.metaMaxAgeSec,
      undefined,
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("uses the registered blacklist summary key and meta-compatible cached value", async () => {
    const descriptor = FRONTEND_API_QUERY_REGISTRY.blacklistSummary;
    const cachedValue = {
      data: { stats: { perCoinRecentEventTypes: {} } },
      meta: { ageSeconds: 0, status: "fresh", updatedAt: 1 },
    };
    useQueryMock.mockReturnValue(queryResult(cachedValue));
    apiFetchWithMetaMock.mockResolvedValue(cachedValue);

    const result = useSidebarBlacklistSignal(false);
    const options = capturedOptions();

    expect(options.queryKey).toEqual(descriptor.queryKey);
    expect(options.enabled).toBe(false);
    expect(options.retry).toBe(1);
    expect(result.data).toBe(cachedValue.data);
    expect(result.meta).toBe(cachedValue.meta);
    await expect(options.queryFn()).resolves.toBe(cachedValue);
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      descriptor.path,
      descriptor.schema,
      undefined,
      descriptor.metaMaxAgeSec,
      undefined,
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("uses the registered stability index key and meta-compatible cached value", async () => {
    const descriptor = FRONTEND_API_QUERY_REGISTRY.stabilityIndex;
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
      descriptor.schema,
      undefined,
      descriptor.metaMaxAgeSec,
      undefined,
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("uses the registered health key and raw cached value", async () => {
    const descriptor = FRONTEND_API_QUERY_REGISTRY.health;
    const rawValue = { dbHealthy: true, overallStatus: "healthy" };
    useQueryMock.mockReturnValue(queryResult(rawValue));
    apiFetchMock.mockResolvedValue(rawValue);

    const result = useSidebarHealthSignal();
    const options = capturedOptions();

    expect(options.queryKey).toEqual(descriptor.queryKey);
    expect(options.retry).toBe(1);
    expect(result.data).toBe(rawValue);
    await expect(options.queryFn()).resolves.toBe(rawValue);
    expect(apiFetchMock).toHaveBeenCalledWith(descriptor.path, descriptor.schema);
    expect(apiFetchWithMetaMock).not.toHaveBeenCalled();
  });

  it("uses the registered daily digest key and raw cached value", async () => {
    const descriptor = FRONTEND_API_QUERY_REGISTRY.dailyDigest;
    const rawValue = { generatedAt: 1, snapshots: [] };
    useQueryMock.mockReturnValue(queryResult(rawValue));
    apiFetchMock.mockResolvedValue(rawValue);

    const result = useSidebarDailyDigestSignal();
    const options = capturedOptions();

    expect(options.queryKey).toEqual(descriptor.queryKey);
    expect(options.retry).toBe(1);
    expect(result.data).toBe(rawValue);
    await expect(options.queryFn()).resolves.toBe(rawValue);
    expect(apiFetchMock).toHaveBeenCalledWith(descriptor.path, descriptor.schema);
    expect(apiFetchWithMetaMock).not.toHaveBeenCalled();
  });
});
