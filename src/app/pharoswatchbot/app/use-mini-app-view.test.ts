// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  initialStackFromStartParam,
  relaunchPayloadForScreen,
  useMiniAppView,
  type MiniAppScreen,
} from "./use-mini-app-view";

afterEach(() => cleanup());

describe("initialStackFromStartParam", () => {
  it.each<[string | null, MiniAppScreen[]]>([
    [null, [{ name: "home" }]],
    ["unknown-token", [{ name: "home" }]],
    ["watchlist", [{ name: "home" }]],
    ["coin_usdc-circle", [{ name: "home" }, { name: "coin", coinId: "usdc-circle" }]],
    ["why_usdc-circle", [{ name: "home" }, { name: "coin", coinId: "usdc-circle" }]],
    ["coverage_usdc-circle", [{ name: "home" }, { name: "coin", coinId: "usdc-circle" }]],
    ["settings", [{ name: "home" }, { name: "settings" }]],
    ["quiet-hours", [{ name: "home" }, { name: "settings" }]],
    ["forget", [{ name: "home" }, { name: "settings" }]],
    ["setup", [{ name: "home" }, { name: "add-coins" }]],
  ])("routes %s", (startParam, stack) => {
    expect(initialStackFromStartParam(startParam)).toEqual({ stack });
  });
});

describe("relaunchPayloadForScreen", () => {
  it.each<[MiniAppScreen, string]>([
    [{ name: "home" }, "home"],
    [{ name: "coin", coinId: "usdt-tether" }, "coin_usdt-tether"],
    [{ name: "settings" }, "settings"],
    [{ name: "add-coins" }, "setup"],
    [{ name: "group", groupId: "usd-top25" }, "home"],
    [{ name: "add-group" }, "home"],
  ])("encodes %o as %s", (screen, payload) => {
    expect(relaunchPayloadForScreen(screen)).toBe(payload);
  });

  it("round-trips coin, settings and add-coins screens", () => {
    for (const screen of [{ name: "coin", coinId: "usdt-tether" }, { name: "settings" }, { name: "add-coins" }] as MiniAppScreen[]) {
      expect(initialStackFromStartParam(relaunchPayloadForScreen(screen)).stack.at(-1)).toEqual(screen);
    }
  });
});

describe("useMiniAppView", () => {
  it("pushes, ignores duplicate pushes, pops, and initializes only once", () => {
    const { result } = renderHook(() => useMiniAppView());
    act(() => result.current.initializeFromStartParam("coin_usdc-circle"));
    expect(result.current.screen).toEqual({ name: "coin", coinId: "usdc-circle" });
    expect(result.current.depth).toBe(2);
    act(() => result.current.initializeFromStartParam("settings"));
    expect(result.current.depth).toBe(2);
    act(() => result.current.showSettings());
    act(() => result.current.showSettings());
    expect(result.current.depth).toBe(3);
    act(() => result.current.back());
    act(() => result.current.back());
    act(() => result.current.back());
    expect(result.current.screen).toEqual({ name: "home" });
    expect(result.current.depth).toBe(1);
  });
});
