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
  readJsonStorageValue: (_s: unknown, key: string, decode: (value: unknown) => unknown, fallback: unknown) => {
    const raw = mockStorage.getItem(key);
    if (!raw) return fallback;
    try {
      return decode(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  writeJsonStorageValue: (_s: unknown, key: string, value: unknown) => {
    mockStorage.setItem(key, JSON.stringify(value));
    return true;
  },
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
    // Every group starts collapsed: the desktop quick rail and its mobile tile
    // block already carry the high-traffic routes above the group headers.
    expect(state).toEqual({ markets: false, risk: false, tools: false, more: false });
  });

  it("merges persisted state over defaults", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ markets: true }));
    const state = getExpandedState();
    expect(state["markets"]).toBe(true); // overridden
    expect(state["risk"]).toBe(false); // default
    expect(state["tools"]).toBe(false); // default
    expect(state["more"]).toBe(false); // default
  });

  it("handles corrupted localStorage gracefully", () => {
    mockStorage.setItem(STORAGE_KEY, "not-json");
    expect(getExpandedState()).toEqual({ markets: false, risk: false, tools: false, more: false });
  });

  it("ignores valid JSON with an invalid persisted shape", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify(["markets", true]));
    expect(getExpandedState()).toEqual({ markets: false, risk: false, tools: false, more: false });
  });

  it("keeps only boolean values from mixed persisted entries", () => {
    mockStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        markets: "true",
        risk: true,
        tools: null,
        more: true,
      }),
    );

    const state = getExpandedState();

    expect(state["markets"]).toBe(false);
    expect(state["risk"]).toBe(true);
    expect(state["tools"]).toBe(false);
    expect(state["more"]).toBe(true);
  });

  it("survives a payload persisted under the retired group keys", () => {
    // Pre-revamp drawers persisted overview/analyze/learn/reference.
    mockStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ overview: true, analyze: true, learn: true, reference: true }),
    );

    const state = getExpandedState();

    expect(state["markets"]).toBe(false);
    expect(state["risk"]).toBe(false);
    expect(state["tools"]).toBe(false);
    expect(state["more"]).toBe(false);
  });
});

describe("setExpandedState", () => {
  it("persists state to localStorage", () => {
    setExpandedState({ markets: true, risk: false, tools: false, more: true });
    const raw = mockStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual({
      markets: true,
      risk: false,
      tools: false,
      more: true,
    });
  });
});

describe("useNavCollapse", () => {
  function NavCollapseProbe() {
    const navCollapse = useNavCollapse();
    return createElement("div", { "data-expanded": String(navCollapse.isExpanded("markets")) });
  }

  it("renders the hydration pass from defaults before applying localStorage state", async () => {
    // Defaults collapse the Markets group, so the server pass reflects that
    // baseline regardless of the persisted state that will later hydrate.
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ markets: true }));

    expect(renderToString(createElement(NavCollapseProbe))).toContain('data-expanded="false"');

    const { result } = renderHook(() => useNavCollapse());

    // After client hydration, the persisted override (true) should win over
    // the default (false).
    await waitFor(() => {
      expect(result.current.isExpanded("markets")).toBe(true);
    });
  });
});
