import { describe, expect, it, vi } from "vitest";
import { buildVerbPreview, clampCommandPaletteSelectedIndex, executeParsedVerb } from "@/components/command-palette-actions";
import { parsePaletteInput } from "@/lib/command-palette-verbs";

describe("command palette action helpers", () => {
  it("clamps selected index when the result set shrinks or empties", () => {
    expect(clampCommandPaletteSelectedIndex(4, 2)).toBe(1);
    expect(clampCommandPaletteSelectedIndex(1, 0)).toBe(0);
    expect(clampCommandPaletteSelectedIndex(-1, 5)).toBe(0);
    expect(clampCommandPaletteSelectedIndex(2, 5)).toBe(2);
  });

  it.each([
    ["screen safety>=80 safety>=90", true, 1],
    ["screen dews>=20 dews<=80", true, 2],
    ["screen type=invalid safety>=80", true, 1],
    ["screen safety>=0", false, 0],
    ["screen type=invalid", false, 0],
    ["screen dews>=80 dews<=20", false, 2],
    ["screen supply>=200 supply<=100", false, 2],
    ["screen safety>=110", false, 1],
  ])("previews only admitted constraints and never executes rejected bounds: %s", (input, runnable, count) => {
    const parsed = parsePaletteInput(input);
    const preview = buildVerbPreview(parsed);
    expect(preview?.runnable).toBe(runnable);
    const executor = {
      push: vi.fn(), closePalette: vi.fn(), addToWatchlist: vi.fn(),
      removeFromWatchlist: vi.fn(), clearWatchlist: vi.fn(),
    };
    expect(executeParsedVerb(parsed, executor)).toBe(runnable);
    expect(executor.push).toHaveBeenCalledTimes(runnable ? 1 : 0);
    if (runnable) {
      expect(preview?.label).toBe(`Screen ${count} filter${count === 1 ? "" : "s"}`);
      if (parsed.kind !== "screen") throw new Error("expected screen");
      expect(Object.keys(parsed.filters)).toHaveLength(count);
      expect(executor.push).toHaveBeenCalledWith(parsed.href);
    } else if (parsed.kind === "screen" && parsed.error) {
      expect(preview?.sublabel).toBe(parsed.error);
    }
  });
});
