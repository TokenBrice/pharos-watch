import { describe, expect, it } from "vitest";
import { CAUSE_HEX, CAUSE_OF_DEATH_VALUES } from "../cause-of-death";

describe("cause-of-death", () => {
  it("exports the five cemetery causes", () => {
    expect([...CAUSE_OF_DEATH_VALUES].sort()).toEqual([
      "abandoned",
      "algorithmic-failure",
      "counterparty-failure",
      "liquidity-drain",
      "regulatory",
    ]);
  });

  it("provides a hex color for each cause", () => {
    for (const cause of CAUSE_OF_DEATH_VALUES) {
      expect(CAUSE_HEX[cause]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
