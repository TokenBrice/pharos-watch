import { describe, expect, it } from "vitest";
import { buildRankChangeChipDisplay, formatSignedPysDelta } from "@/lib/yield-presentation";

describe("formatSignedPysDelta", () => {
  it("formats signed PYS deltas and suppresses non-finite values", () => {
    expect(formatSignedPysDelta(2.345)).toBe("+2.35 PYS");
    expect(formatSignedPysDelta(-12.34)).toBe("-12.3 PYS");
    expect(formatSignedPysDelta(0)).toBe("+0.00 PYS");
    expect(formatSignedPysDelta(Number.NaN)).toBe("");
  });
});

describe("buildRankChangeChipDisplay", () => {
  it("renders positive rankDelta as an upward rank improvement", () => {
    const display = buildRankChangeChipDisplay({
      rankDelta: 4,
      pysDelta: 2.5,
      primaryDriver: "apy",
    });

    expect(display).toMatchObject({
      arrow: "▲",
      signedRank: "+4",
      short: "APY",
    });
    expect(display?.colorClass).toContain("emerald");
  });

  it("renders negative rankDelta as a rank decline", () => {
    const display = buildRankChangeChipDisplay({
      rankDelta: -2,
      pysDelta: -1.2,
      primaryDriver: "source-risk",
    });

    expect(display).toMatchObject({
      arrow: "▼",
      signedRank: "-2",
      short: "Source risk",
    });
    expect(display?.colorClass).toContain("red");
  });
});
