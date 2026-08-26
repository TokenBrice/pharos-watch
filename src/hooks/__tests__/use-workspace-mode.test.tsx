// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceMode } from "@/hooks/use-workspace-mode";

const MODES = [{ id: "first" }, { id: "second" }] as const;

beforeEach(() => {
  window.history.replaceState({ preserved: true }, "", "/admin/test/?scope=all#signals");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useWorkspaceMode", () => {
  it("hydrates from the default mode and canonicalizes a missing view with replaceState", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useWorkspaceMode({ modes: MODES, defaultMode: "second" }));

    expect(result.current.activeMode).toBe("second");
    await waitFor(() => expect(window.location.search).toBe("?scope=all&view=second"));
    expect(window.location.hash).toBe("#signals");
    expect(replaceState).toHaveBeenCalledWith(
      { preserved: true },
      "",
      "/admin/test/?scope=all&view=second#signals",
    );
    expect(pushState).not.toHaveBeenCalled();
  });

  it("resynchronizes on popstate and canonicalizes invalid navigation", async () => {
    window.history.replaceState({}, "", "/admin/test/?view=first");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { result } = renderHook(() => useWorkspaceMode({ modes: MODES, defaultMode: "first" }));

    await act(async () => {
      window.history.pushState({}, "", "/admin/test/?view=second&scope=all");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.activeMode).toBe("second");
    expect(replaceState).not.toHaveBeenCalled();

    await act(async () => {
      window.history.pushState({}, "", "/admin/test/?view=invalid&scope=all");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.activeMode).toBe("first");
    expect(window.location.search).toBe("?view=first&scope=all");
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("replaces the current history entry when selecting a mode", () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useWorkspaceMode({ modes: MODES, defaultMode: "first" }));
    replaceState.mockClear();

    act(() => result.current.selectMode("second"));

    expect(result.current.activeMode).toBe("second");
    expect(window.location.search).toBe("?scope=all&view=second");
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
  });
});
