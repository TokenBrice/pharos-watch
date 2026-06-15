import { describe, expect, it } from "vitest";
import { getDewsFreshness } from "../dews-signal-utils";

describe("getDewsFreshness", () => {
  it("treats a zero computedAt timestamp as a real stale observation", () => {
    expect(getDewsFreshness(0, 3_600, 300)).toMatchObject({
      ageSeconds: 3_600,
      stale: true,
    });
  });

  it("treats nullish computedAt values as missing", () => {
    expect(getDewsFreshness(null, 3_600, 300)).toEqual({
      ageSeconds: null,
      stale: false,
      label: null,
    });
  });
});
