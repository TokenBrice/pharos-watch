import { describe, expect, it } from "vitest";
import { resolveCanonicalChain } from "../sources-helpers";

describe("resolveCanonicalChain", () => {
  it("preserves alias and unknown-id behavior for yield sources", () => {
    expect(resolveCanonicalChain(" Ethereum ")).toBe("ethereum");
    expect(resolveCanonicalChain(1)).toBe("ethereum");
    expect(resolveCanonicalChain(999_999)).toBe("999999");
    expect(resolveCanonicalChain("   ")).toBeNull();
  });
});
