import { describe, expect, it } from "vitest";
import { resolveQueryViewState } from "@/lib/query-view-state";

describe("resolveQueryViewState", () => {
  it("keeps retained data visible with an explicit stale state", () => {
    expect(resolveQueryViewState({ hasData: true, isLoading: false, error: new Error("offline") })).toBe(
      "stale-with-data",
    );
  });

  it("does not translate a failed empty request into an empty state", () => {
    expect(
      resolveQueryViewState({ hasData: false, isLoading: false, error: new Error("offline"), isEmpty: true }),
    ).toBe("unavailable");
  });

  it("distinguishes initial loading, valid empty, and ready data", () => {
    expect(resolveQueryViewState({ hasData: false, isLoading: true, error: null })).toBe("loading");
    expect(resolveQueryViewState({ hasData: true, isLoading: false, error: null, isEmpty: true })).toBe("empty");
    expect(resolveQueryViewState({ hasData: true, isLoading: false, error: null })).toBe("ready");
  });
});
