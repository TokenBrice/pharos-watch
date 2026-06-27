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
    // The high-traffic Overview, Markets, and Risk groups default open so
    // common routes are one click away; deeper research/reference groups stay collapsed.
    expect(state["overview"]).toBe(true);
    expect(state["markets"]).toBe(true);
    expect(state["risk"]).toBe(true);
    expect(state["analyze"]).toBe(false);
    expect(state["learn"]).toBe(false);
    expect(state["reference"]).toBe(false);
  });

  it("merges persisted state over defaults", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ markets: false }));
    const state = getExpandedState();
    expect(state["overview"]).toBe(true); // default
    expect(state["markets"]).toBe(false); // overridden
    expect(state["risk"]).toBe(true);     // default
    expect(state["analyze"]).toBe(false); // default
    expect(state["learn"]).toBe(false);   // default
    expect(state["reference"]).toBe(false); // default
  });

  it("handles corrupted localStorage gracefully", () => {
    mockStorage.setItem(STORAGE_KEY, "not-json");
    const state = getExpandedState();
    expect(state["overview"]).toBe(true); // falls back to defaults
    expect(state["markets"]).toBe(true);
    expect(state["risk"]).toBe(true);
    expect(state["analyze"]).toBe(false);
    expect(state["learn"]).toBe(false);
    expect(state["reference"]).toBe(false);
  });

  it("ignores valid JSON with an invalid persisted shape", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify(["markets", false]));
    const state = getExpandedState();
    expect(state["overview"]).toBe(true);
    expect(state["markets"]).toBe(true);
    expect(state["risk"]).toBe(true);
    expect(state["analyze"]).toBe(false);
    expect(state["learn"]).toBe(false);
    expect(state["reference"]).toBe(false);
  });

  it("keeps only boolean values from mixed persisted entries", () => {
    mockStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        overview: false,
        markets: "false",
        risk: false,
        analyze: true,
        reference: null,
      }),
    );

    const state = getExpandedState();

    expect(state["overview"]).toBe(false);
    expect(state["markets"]).toBe(true);
    expect(state["risk"]).toBe(false);
    expect(state["analyze"]).toBe(true);
    expect(state["learn"]).toBe(false);
    expect(state["reference"]).toBe(false);
  });
});

describe("setExpandedState", () => {
  it("persists state to localStorage", () => {
    setExpandedState({ overview: true, markets: false, risk: true, analyze: false, learn: false, reference: true });
    const raw = mockStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual({
      overview: true,
      markets: false,
      risk: true,
      analyze: false,
      learn: false,
      reference: true,
    });
  });
});

describe("useNavCollapse", () => {
  function NavCollapseProbe() {
    const navCollapse = useNavCollapse();
    return createElement("div", { "data-expanded": String(navCollapse.isExpanded("markets")) });
  }

  it("renders the hydration pass from defaults before applying localStorage state", async () => {
    // Defaults expand the Markets group, so the server pass should reflect
    // that baseline regardless of the persisted state that will later hydrate.
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ markets: false }));

    expect(renderToString(createElement(NavCollapseProbe))).toContain('data-expanded="true"');

    const { result } = renderHook(() => useNavCollapse());

    // After client hydration, the persisted override (false) should win over
    // the default (true).
    await waitFor(() => {
      expect(result.current.isExpanded("markets")).toBe(false);
    });
  });
});
