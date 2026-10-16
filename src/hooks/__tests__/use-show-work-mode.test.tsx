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
