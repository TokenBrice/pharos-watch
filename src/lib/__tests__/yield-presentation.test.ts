import { describe, expect, it } from "vitest";
import { buildRankChangeChipDisplay } from "@/lib/yield-presentation";

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
