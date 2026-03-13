import { beforeEach, describe, expect, it, vi } from "vitest";

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("@shared/lib/api-endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/api-endpoints")>();
  return {
    ...actual,
    getStrictContractPaths: () => [],
    getProbePaths: (group: "public" | "admin" | "manual") => {
      if (group === "public") return ["/api/health"];
      if (group === "admin") return ["/api/status"];
      return ["/api/sync-stablecoins"];
    },
  };
});

import { CRON_1MIN, createPollingQueryOptions } from "../use-api-query";
import { useHealth } from "../api-hooks";
import { useStatus } from "../use-status";
import { useEndpointProbes } from "../use-endpoint-probes";
import type { AdminAccess } from "@/lib/admin-access";

function mockQueryReturn() {
  useQueryMock.mockReturnValue({
    data: undefined,
    error: null,
    isLoading: false,
    isFetching: false,
    dataUpdatedAt: 0,
  });
}

describe("query polling policy", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    mockQueryReturn();
    vi.restoreAllMocks();
  });

  it("createPollingQueryOptions enforces stale=interval and refetch=2x interval", () => {
    const options = createPollingQueryOptions(["k"], async () => 1, 15_000);
    expect(options.staleTime).toBe(15_000);
    expect(options.refetchInterval).toBe(30_000);
    expect(options.retry).toBe(2);
  });

  it("useHealth uses shared polling policy with endpoint-specific retry", () => {
    useHealth();
    const options = useQueryMock.mock.calls[0][0] as {
      staleTime: number;
      refetchInterval: number;
      retry: number;
    };

    expect(options.staleTime).toBe(CRON_1MIN);
    expect(options.refetchInterval).toBe(2 * CRON_1MIN);
    expect(options.retry).toBe(1);
  });

  it("useStatus uses the ops proxy with no browser admin key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);
    const adminAccess: AdminAccess = { mode: "ops-proxy" };

    useStatus(adminAccess);
    const options = useQueryMock.mock.calls[0][0] as {
      enabled: boolean;
      retry: number;
      staleTime: number;
      refetchInterval: number;
      queryKey: unknown[];
      queryFn: () => Promise<unknown>;
    };

    expect(options.enabled).toBe(true);
    expect(options.retry).toBe(0);
    expect(options.staleTime).toBe(CRON_1MIN);
    expect(options.refetchInterval).toBe(2 * CRON_1MIN);
    expect(options.queryKey).toEqual(["status", "ops-proxy"]);

    await options.queryFn();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/admin/status");
    expect(init.headers).toBeInstanceOf(Headers);
    expect((init.headers as Headers).has("X-Admin-Key")).toBe(false);
  });

  it("useEndpointProbes uses shared polling and switches admin paths to same-origin proxy mode", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);
    const adminAccess: AdminAccess = { mode: "ops-proxy" };

    useEndpointProbes(adminAccess);
    const options = useQueryMock.mock.calls[0][0] as {
      enabled: boolean;
      retry: number;
      staleTime: number;
      refetchInterval: number;
      queryKey: unknown[];
      queryFn: () => Promise<unknown[]>;
    };

    expect(options.enabled).toBe(true);
    expect(options.retry).toBe(0);
    expect(options.staleTime).toBe(CRON_1MIN);
    expect(options.refetchInterval).toBe(2 * CRON_1MIN);
    expect(options.queryKey).toEqual(["endpoint-probes", "ops-proxy"]);

    await options.queryFn();
    const [publicCall, adminCall] = fetchMock.mock.calls;
    expect(publicCall[0]).toEqual(expect.stringContaining("/api/health"));
    expect((publicCall[1] as RequestInit).headers).toBeUndefined();
    expect(adminCall[0]).toBe("/api/admin/status");
    expect((adminCall[1] as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((adminCall[1] as RequestInit).headers as Headers).has("X-Admin-Key")).toBe(false);
  });
});
