// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, apiFetchWithMetaMock, routerPrefetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(async () => ({})),
  apiFetchWithMetaMock: vi.fn(async () => ({ data: { gauge: {}, coins: [], hourly: [] }, meta: null })),
  routerPrefetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    prefetch: routerPrefetchMock,
  }),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: apiFetchMock,
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

import { useNavPrefetch } from "../use-nav-prefetch";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useNavPrefetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetchMock.mockClear();
    apiFetchWithMetaMock.mockClear();
    routerPrefetchMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warms /flows with the same meta-envelope query shape used by the consuming hook", async () => {
    const { result } = renderHook(() => useNavPrefetch(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      result.current.prefetch("/flows");
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      "/api/mint-burn-flows",
      expect.anything(),
      expect.anything(),
      3600,
      undefined,
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(routerPrefetchMock).toHaveBeenCalledWith("/flows");
  });
});
