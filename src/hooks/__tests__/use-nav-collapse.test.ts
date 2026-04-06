import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock browser-storage before importing the hook module
vi.mock("@/lib/browser-storage", () => ({
  getWindowStorage: () => mockStorage,
  safeStorageGetItem: (_s: unknown, key: string) => mockStorage.getItem(key),
  safeStorageSetItem: (_s: unknown, key: string, val: string) => mockStorage.setItem(key, val),
}));

let mockStorage: Storage;

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
const { getExpandedState, setExpandedState, STORAGE_KEY } = await import("@/hooks/use-nav-collapse");

beforeEach(() => {
  mockStorage = createMockStorage();
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
