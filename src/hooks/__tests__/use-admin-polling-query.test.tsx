// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UseQueryOptions } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import type * as ReactQuery from "@tanstack/react-query";
import type * as Api from "@/lib/api";
import { z } from "zod";
import { useRegisteredAdminQuery } from "../use-admin-polling-query";

const { useQueryMock, apiFetchMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(), apiFetchMock: vi.fn(),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof ReactQuery>(), useQuery: useQueryMock,
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof Api>(), apiFetch: apiFetchMock,
}));

const schema = z.object({ value: z.number() });
const descriptor = {
  queryKey: ["admin-polling-test"], path: "/api/status", producerIntervalMs: 60_000, schema, enabled: false,
};
function queryOptions() {
  return useQueryMock.mock.lastCall![0] as UseQueryOptions;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("useRegisteredAdminQuery", () => {
  it("retains the ops cache scope, descriptor gate, cadence and zero retry default", () => {
    renderHook(() => useRegisteredAdminQuery(descriptor));
    expect(queryOptions()).toMatchObject({
      queryKey: ["admin-polling-test", "ops-proxy"], enabled: false, retry: 0,
      staleTime: 60_000, refetchInterval: 120_000,
    });
  });

  it.each([
    { enabled: true, retry: false }, { enabled: false, retry: 3 },
  ])("honors explicit enabled=$enabled and retry=$retry overrides", (overrides) => {
    renderHook(() => useRegisteredAdminQuery({ ...descriptor, enabled: !overrides.enabled }, overrides));
    expect(queryOptions()).toMatchObject(overrides);
  });

  it("resolves the proxied path and forwards schema and cancellation on each fetch, not render", async () => {
    let from = 100;
    const path = vi.fn(() => `/api/status-history?from=${from}`);
    renderHook(() => useRegisteredAdminQuery({ ...descriptor, path }));
    expect(path).not.toHaveBeenCalled();
    const queryFn = queryOptions().queryFn;
    if (typeof queryFn !== "function") throw new Error("Expected polling query function");
    const signal = new AbortController().signal;
    const context = { client: new QueryClient(), queryKey: [], signal, meta: undefined };
    apiFetchMock.mockResolvedValue({ value: 1 });
    expect(await queryFn(context)).toEqual({ value: 1 });
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/admin/status-history?from=100", schema, { signal }, undefined, { bootstrapQueryKey: undefined },
    );
    from = 200;
    await queryFn(context);
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/admin/status-history?from=200", schema, { signal }, undefined, { bootstrapQueryKey: undefined },
    );
  });
});
