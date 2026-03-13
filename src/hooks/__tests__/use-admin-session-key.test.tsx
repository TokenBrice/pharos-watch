// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_KEY_IDLE_TIMEOUT_MINUTES,
  useAdminSessionKey,
} from "../use-admin-session-key";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return { queryClient, Wrapper };
}

describe("useAdminSessionKey", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.useRealTimers();
  });

  it("keeps the admin key in memory only and advances a secret-free session revision", () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAdminSessionKey(), { wrapper: Wrapper });

    expect(result.current.adminKey).toBe("");
    expect(result.current.adminSessionRevision).toBe(0);

    act(() => {
      result.current.handleKeySubmit("operator-secret");
    });

    expect(result.current.adminKey).toBe("operator-secret");
    expect(result.current.adminSessionRevision).toBe(1);
    expect(result.current.lastExitReason).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("expires after inactivity and clears cached admin queries", () => {
    const { queryClient, Wrapper } = createWrapper();
    const { result } = renderHook(() => useAdminSessionKey(), { wrapper: Wrapper });

    act(() => {
      result.current.handleKeySubmit("operator-secret");
    });

    queryClient.setQueryData(["status", result.current.adminSessionRevision], { ok: true });
    expect(queryClient.getQueryData(["status", result.current.adminSessionRevision])).toEqual({ ok: true });

    act(() => {
      vi.advanceTimersByTime(ADMIN_KEY_IDLE_TIMEOUT_MINUTES * 60 * 1000);
    });

    expect(result.current.adminKey).toBe("");
    expect(result.current.lastExitReason).toBe("expired");
    expect(queryClient.getQueryData(["status", 1])).toBeUndefined();
  });
});
