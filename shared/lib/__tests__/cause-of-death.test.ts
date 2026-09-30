import { describe, expect, it } from "vitest";
import { CAUSE_HEX, CAUSE_HEX_DARK, CAUSE_META, CAUSE_OF_DEATH_VALUES, CAUSE_ORDER } from "../cause-of-death";

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

  it("orders every cause exactly once", () => {
    expect([...CAUSE_ORDER].sort()).toEqual([...CAUSE_OF_DEATH_VALUES].sort());
  });

  it("provides light and dark hex colors for each cause", () => {
    for (const cause of CAUSE_OF_DEATH_VALUES) {
      expect(CAUSE_HEX[cause]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(CAUSE_HEX_DARK[cause]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("defines every cause", () => {
    for (const cause of CAUSE_OF_DEATH_VALUES) {
      expect(CAUSE_META[cause].definition.trim()).not.toBe("");
    }
  });
});
