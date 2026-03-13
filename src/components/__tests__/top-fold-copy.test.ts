import { describe, expect, it } from "vitest";
import { getTopFoldCopy } from "@/components/status/top-fold-copy";

describe("getTopFoldCopy", () => {
  it("uses incident copy for active stale incidents", () => {
    const copy = getTopFoldCopy("stale", "stale");

    expect(copy.eyebrow).toBe("Intervention required");
    expect(copy.title).toBe("Contain the breach.");
    expect(copy.emphasis).toBe("steady");
  });

  it("uses recovery-hold copy when stale is only being held by hysteresis", () => {
    const copy = getTopFoldCopy("stale", "degraded");

    expect(copy.eyebrow).toBe("Recovery holding");
    expect(copy.title).toBe("Hold the recovery.");
    expect(copy.body).toContain("stale hold");
    expect(copy.emphasis).toBe("recovery-hold");
  });

  it("uses recovery-hold copy when degraded is only being held by hysteresis", () => {
    const copy = getTopFoldCopy("degraded", "healthy");

    expect(copy.eyebrow).toBe("Recovery holding");
    expect(copy.title).toBe("Verify the rebound.");
    expect(copy.emphasis).toBe("recovery-hold");
  });
});
