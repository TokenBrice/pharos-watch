import { describe, expect, it } from "vitest";
import { isUrlFilterClearValue } from "@/hooks/use-url-filters";

describe("isUrlFilterClearValue", () => {
  it("clears only explicit global sentinel values", () => {
    expect(isUrlFilterClearValue("")).toBe(true);
    expect(isUrlFilterClearValue("all")).toBe(true);
  });

  it("preserves numeric and non-sentinel string values", () => {
    expect(isUrlFilterClearValue("1")).toBe(false);
    expect(isUrlFilterClearValue("0")).toBe(false);
    expect(isUrlFilterClearValue("USD")).toBe(false);
  });
});
