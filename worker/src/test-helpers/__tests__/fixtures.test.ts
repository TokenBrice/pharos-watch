import { describe, expect, it, vi } from "vitest";
import { makeAsset } from "../__shared/fixtures";

describe("makeAsset", () => {
  it("builds without reading the wall clock", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(9_999_999_999_000);

    makeAsset();
    expect(now).not.toHaveBeenCalled();

    now.mockRestore();
  });
});
