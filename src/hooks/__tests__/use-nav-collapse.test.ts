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
    // TRACK group (data) defaults to expanded so the highest-traffic data
    // routes are one click away on first render; Analyze, Monitor, and
    // Reference stay collapsed.
    expect(state["data"]).toBe(true);
    expect(state["tools"]).toBe(false);
    expect(state["monitor"]).toBe(false);
    expect(state["info"]).toBe(false);
  });

  it("merges persisted state over defaults", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ data: false }));
    const state = getExpandedState();
    expect(state["data"]).toBe(false);    // overridden
    expect(state["tools"]).toBe(false);   // default
    expect(state["monitor"]).toBe(false); // default
    expect(state["info"]).toBe(false);    // default
  });

  it("handles corrupted localStorage gracefully", () => {
    mockStorage.setItem(STORAGE_KEY, "not-json");
    const state = getExpandedState();
    expect(state["data"]).toBe(true); // falls back to defaults
    expect(state["tools"]).toBe(false);
    expect(state["monitor"]).toBe(false);
    expect(state["info"]).toBe(false);
  });
});

describe("setExpandedState", () => {
  it("persists state to localStorage", () => {
    setExpandedState({ data: true, tools: false, monitor: true, info: true });
    const raw = mockStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual({ data: true, tools: false, monitor: true, info: true });
  });
});

describe("useNavCollapse", () => {
  function NavCollapseProbe() {
    const navCollapse = useNavCollapse();
    return createElement("div", { "data-expanded": String(navCollapse.isExpanded("data")) });
  }

  it("renders the hydration pass from defaults before applying localStorage state", async () => {
    // Defaults now expand the data group, so the server pass should reflect
    // that baseline regardless of the persisted state that will later hydrate.
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ data: false }));

    expect(renderToString(createElement(NavCollapseProbe))).toContain('data-expanded="true"');

    const { result } = renderHook(() => useNavCollapse());

    // After client hydration, the persisted override (false) should win over
    // the default (true).
    await waitFor(() => {
      expect(result.current.isExpanded("data")).toBe(false);
    });
  });
});
