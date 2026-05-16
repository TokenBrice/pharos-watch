// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useShowWorkMode } from "@/hooks/use-show-work-mode";

const STORAGE_KEY = "pharos.show-work";

function setUrl(path: string) {
  window.history.replaceState(null, "", path);
}

beforeEach(() => {
  window.localStorage.clear();
  setUrl("/methodology/");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("useShowWorkMode", () => {
  it("enables from ?show-work=1 when there is no stored preference", () => {
    setUrl("/methodology/?show-work=1");

    const { result } = renderHook(() => useShowWorkMode());

    expect(result.current.enabled).toBe(true);
  });

  it("can hide while ?show-work=1 is present", () => {
    setUrl("/methodology/?show-work=1");
    const { result } = renderHook(() => useShowWorkMode());

    act(() => result.current.toggle());

    expect(result.current.enabled).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("false");
    expect(window.location.search).toBe("");
  });

  it("keeps the explicit false override on reload", () => {
    window.localStorage.setItem(STORAGE_KEY, "false");
    setUrl("/methodology/");

    const { result } = renderHook(() => useShowWorkMode());

    expect(result.current.enabled).toBe(false);
  });

  it("lets localStorage override a URL initializer", () => {
    window.localStorage.setItem(STORAGE_KEY, "false");
    setUrl("/methodology/?show-work=1");

    const { result } = renderHook(() => useShowWorkMode());

    expect(result.current.enabled).toBe(false);

    act(() => result.current.enable());

    expect(result.current.enabled).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");
  });
});
