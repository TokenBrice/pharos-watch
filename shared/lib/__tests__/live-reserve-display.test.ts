import { describe, expect, it } from "vitest";

import {
  getReserveDisplayBadgeKindForAdapter,
} from "../live-reserve-display";
import { inferReserveDisplayBadgeKindFromEvidenceClass } from "../live-reserve-adapter-descriptors";

describe("live-reserve display badge inference", () => {
  it("maps every supported evidence class through the canonical resolver", () => {
    expect(inferReserveDisplayBadgeKindFromEvidenceClass("independent")).toBe("live");
    expect(inferReserveDisplayBadgeKindFromEvidenceClass("static-validated")).toBe("curated-validated");
    expect(inferReserveDisplayBadgeKindFromEvidenceClass("weak-live-probe")).toBe("proof");
  });

  it("fails closed instead of classifying unknown evidence as live", () => {
    expect(() => inferReserveDisplayBadgeKindFromEvidenceClass("unknown" as never)).toThrow(
      "Unsupported live-reserve evidence class: unknown",
    );
  });

  it("uses the same resolver for configured adapters", () => {
    expect(getReserveDisplayBadgeKindForAdapter("liquity-v1")).toBe("live");
    expect(getReserveDisplayBadgeKindForAdapter("curated-validated")).toBe("curated-validated");
    expect(getReserveDisplayBadgeKindForAdapter("single-asset")).toBe("proof");
  });
});
