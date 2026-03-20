// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  DEFAULT_VISIBLE_COLUMNS,
  MOBILE_DEFAULT_COLUMNS,
  normalizeVisibleColumns,
  usePreference,
} from "@/hooks/use-preferences";

describe("normalizeVisibleColumns", () => {
  it("falls back to the provided defaults for non-array values", () => {
    expect(normalizeVisibleColumns("invalid", MOBILE_DEFAULT_COLUMNS)).toEqual(MOBILE_DEFAULT_COLUMNS);
  });

  it("keeps locked columns, drops invalid values, and de-duplicates by canonical order", () => {
    expect(
      normalizeVisibleColumns(["flags", "bogus", "mcap", "rank", "flags"], DEFAULT_VISIBLE_COLUMNS),
    ).toEqual(["rank", "name", "mcap", "flags"]);
  });
});

describe("usePreference", () => {
  it("applies the decoder to persisted localStorage state", () => {
    localStorage.setItem("pharos-table-columns", JSON.stringify(["mcap", "bogus", "flags"]));

    const { result } = renderHook(() =>
      usePreference("pharos-table-columns", MOBILE_DEFAULT_COLUMNS, {
        decode: (raw) => normalizeVisibleColumns(raw, MOBILE_DEFAULT_COLUMNS),
      }),
    );

    expect(result.current[0]).toEqual(["rank", "name", "mcap", "flags"]);
  });
});
