import { describe, expect, it } from "vitest";
import { clampCommandPaletteSelectedIndex } from "@/components/command-palette-actions";

describe("command palette action helpers", () => {
  it("clamps selected index when the result set shrinks or empties", () => {
    expect(clampCommandPaletteSelectedIndex(4, 2)).toBe(1);
    expect(clampCommandPaletteSelectedIndex(1, 0)).toBe(0);
    expect(clampCommandPaletteSelectedIndex(-1, 5)).toBe(0);
    expect(clampCommandPaletteSelectedIndex(2, 5)).toBe(2);
  });
});
