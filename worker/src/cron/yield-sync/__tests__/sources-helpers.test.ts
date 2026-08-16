import { describe, expect, it } from "vitest";
import { normalizeChainId } from "@shared/lib/chains";
import { resolveCanonicalChain } from "../sources-helpers";

describe("resolveCanonicalChain", () => {
  it("is the shared normalizer and preserves its alias and unknown-id contract", () => {
    expect(resolveCanonicalChain).toBe(normalizeChainId);
    expect(resolveCanonicalChain(" Ethereum ")).toBe("ethereum");
    expect(resolveCanonicalChain(1)).toBe("ethereum");
    expect(resolveCanonicalChain(999_999)).toBe("999999");
    expect(resolveCanonicalChain("   ")).toBeNull();
  });
});
