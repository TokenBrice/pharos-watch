// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock browser-storage before importing the hook module
vi.mock("@/lib/browser-storage", () => ({
  getWindowStorage: () => mockStorage,
  safeStorageGetItem: (_s: unknown, key: string) => mockStorage.getItem(key),
  safeStorageSetItem: (_s: unknown, key: string, val: string) => mockStorage.setItem(key, val),
}));

let mockStorage: Storage;
let mockPathname = "/stablecoin/m-m0/";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

function createMockStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

// Import after mocks are in place
const { getExpandedState, setExpandedState, STORAGE_KEY, useNavCollapse } = await import("@/hooks/use-nav-collapse");

beforeEach(() => {
  mockStorage = createMockStorage();
  mockPathname = "/stablecoin/m-m0/";
});

describe("getExpandedState", () => {
  it("returns defaults when localStorage is empty", () => {
    const state = getExpandedState();
    expect(state["data"]).toBe(false);
    expect(state["tools"]).toBe(false);
    expect(state["info"]).toBe(false);
  });

  it("merges persisted state over defaults", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ data: true }));
    const state = getExpandedState();
    expect(state["data"]).toBe(true);     // overridden
    expect(state["tools"]).toBe(false);   // default
    expect(state["info"]).toBe(false);    // default
  });

  it("handles corrupted localStorage gracefully", () => {
    mockStorage.setItem(STORAGE_KEY, "not-json");
    const state = getExpandedState();
    expect(state["data"]).toBe(false); // falls back to defaults
    expect(state["tools"]).toBe(false);
    expect(state["info"]).toBe(false);
  });
});

describe("setExpandedState", () => {
  it("persists state to localStorage", () => {
    setExpandedState({ data: true, tools: false, info: true });
    const raw = mockStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual({ data: true, tools: false, info: true });
  });
});

describe("useNavCollapse", () => {
  function NavCollapseProbe() {
    const navCollapse = useNavCollapse();
    return createElement("div", { "data-expanded": String(navCollapse.isExpanded("data")) });
  }

  it("renders the hydration pass from defaults before applying localStorage state", async () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ data: true }));

    expect(renderToString(createElement(NavCollapseProbe))).toContain('data-expanded="false"');

    const { result } = renderHook(() => useNavCollapse());

    await waitFor(() => {
      expect(result.current.isExpanded("data")).toBe(true);
    });
  });
});
