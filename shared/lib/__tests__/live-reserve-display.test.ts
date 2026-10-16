import { describe, expect, it } from "vitest";

import { inferReserveDisplayBadgeKindFromEvidenceClass } from "../live-reserve-adapter-descriptors";

describe("live-reserve display badge inference", () => {
  it("fails closed instead of classifying unknown evidence as live", () => {
    expect(() => inferReserveDisplayBadgeKindFromEvidenceClass("unknown" as never)).toThrow(
      "Unsupported live-reserve evidence class: unknown",
    );
  });
});
