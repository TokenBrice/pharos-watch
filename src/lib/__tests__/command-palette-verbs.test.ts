import { describe, expect, it } from "vitest";
import { parsePaletteInput } from "@/lib/command-palette-verbs";

describe("parsePaletteInput", () => {
  it("maps tape stablecoin aliases to the timeline coin filter", () => {
    const parsed = parsePaletteInput("tape: stablecoin=usdc-circle severity=critical");

    expect(parsed).toEqual({
      kind: "tape",
      filters: {
        coin: "usdc-circle",
        severity: "critical",
      },
      href: "/timeline/?coin=usdc-circle&severity=critical",
    });
  });
});
