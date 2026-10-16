import { describe, expect, it } from "vitest";
import { getDigestModelLabel } from "@/lib/digest-model-label";

describe("getDigestModelLabel", () => {
  it("uses a generic Anthropic label for an unknown model id", () => {
    expect(getDigestModelLabel("claude-future-99")).toBe("Anthropic model");
  });

  it("makes missing model metadata explicit", () => {
    expect(getDigestModelLabel(undefined)).toBe("Model not recorded");
  });
});
