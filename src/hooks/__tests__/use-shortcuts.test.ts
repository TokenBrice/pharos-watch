// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SHORTCUT_HREFS,
  SHORTCUTS_STORAGE_KEY,
  decodeShortcuts,
  useShortcuts,
} from "@/hooks/use-shortcuts";

const LEGACY_DEFAULT_SHORTCUT_HREFS = [
  "/chains/",
  "/upcoming/",
  "/portfolio/",
  "/alt-pegs/",
  "/cemetery/",
  "https://pharosville.pharos.watch/",
];

describe("decodeShortcuts", () => {
  it("migrates the legacy six-item default to the expanded default set", () => {
    expect(decodeShortcuts(LEGACY_DEFAULT_SHORTCUT_HREFS)).toEqual(DEFAULT_SHORTCUT_HREFS);
  });

  it("preserves custom shortcut lists", () => {
    const custom = ["/chains/", "/yield/", "/timeline/"];
    expect(decodeShortcuts(custom)).toEqual(custom);
  });

  it("falls back to the expanded default for malformed stored values", () => {
    expect(decodeShortcuts({ hrefs: LEGACY_DEFAULT_SHORTCUT_HREFS })).toEqual(DEFAULT_SHORTCUT_HREFS);
  });
});

describe("useShortcuts", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("hydrates legacy stored defaults as twelve shortcuts", async () => {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(LEGACY_DEFAULT_SHORTCUT_HREFS));

    const { result } = renderHook(() => useShortcuts());

    await waitFor(() => {
      expect(result.current.hrefs).toEqual(DEFAULT_SHORTCUT_HREFS);
    });
  });
});
