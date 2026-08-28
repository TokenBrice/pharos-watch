// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelectorState } from "../use-selector-state";

beforeEach(() => {
  window.history.replaceState(null, "", "/screener/picker/?scope=all");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSelectorState", () => {
  it("repairs an over-advanced URL step without removing unrelated parameters", async () => {
    window.history.replaceState(null, "", "/screener/picker/?scope=all&p=treasury&step=result");

    renderHook(() => useSelectorState());

    await waitFor(() => {
      expect(window.location.search).toBe("?scope=all&p=treasury&step=3");
    });
  });

  it("pushes ordinary transitions and replaces relaxation transitions while preserving unrelated parameters", () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { result } = renderHook(() => useSelectorState());
    pushState.mockClear();
    replaceState.mockClear();

    act(() => {
      result.current.dispatch({ type: "answer-profile", value: "yield" });
    });

    expect(window.location.search).toBe("?scope=all&p=yield&step=2");
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();

    act(() => {
      result.current.dispatch({ type: "relax", constraint: "venue" });
    });

    expect(window.location.search).toBe("?scope=all&p=yield&v=all&step=2");
    expect(replaceState).toHaveBeenCalledTimes(1);
  });
});
