import { describe, expect, it } from "vitest";
import { getTopFoldCopy } from "@/components/status/top-fold-copy";

describe("getTopFoldCopy", () => {
  it("uses incident copy for active stale incidents", () => {
    const copy = getTopFoldCopy("stale", "stale");

    expect(copy.emphasis).toBe("steady");
    expect(copy.title).not.toBe(getTopFoldCopy("healthy", "healthy").title);
  });

  it("uses recovery-hold copy when stale is only being held by hysteresis", () => {
    const copy = getTopFoldCopy("stale", "degraded");

    expect(copy.emphasis).toBe("recovery-hold");
    expect(copy.title).not.toBe(getTopFoldCopy("degraded", "healthy").title);
    expect(copy.body).not.toBe(getTopFoldCopy("stale", "healthy").body);
  });

  it("uses recovery-hold copy when degraded is only being held by hysteresis", () => {
    const copy = getTopFoldCopy("degraded", "healthy");

    expect(copy.emphasis).toBe("recovery-hold");
    expect(copy.body).not.toBe(getTopFoldCopy("stale", "healthy").body);
    expect(copy.body).not.toBe(getTopFoldCopy("degraded", "degraded").body);
  });

  it("keeps a healthy steady state out of recovery hold", () => {
    expect(getTopFoldCopy("healthy", "healthy").emphasis).toBe("steady");
  });
});
