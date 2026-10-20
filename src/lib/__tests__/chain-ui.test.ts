import { describe, expect, it } from "vitest";
import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";
import { WAKE_HUE_PCT } from "@shared/lib/harbor-scene";
import { deltaColor, formatChainShare, trendColor } from "../chain-ui";

describe("chain-ui", () => {
  it("tints a supply change only from Harbor's wake hue threshold; a measured zero stays neutral", () => {
    expect(trendColor(null)).toBe("text-muted-foreground");
    expect(trendColor(0)).toBe("text-foreground");
    expect(trendColor(0.049)).toBe("text-foreground");
    expect(trendColor(WAKE_HUE_PCT / 100)).toBe(DIRECTION_TONE_CLASSES.up);
    expect(trendColor(-WAKE_HUE_PCT / 100)).toBe(DIRECTION_TONE_CLASSES.down);
  });

  it("tints other windows and per-coin changes by direction only, a measured zero neutral", () => {
    expect(deltaColor(null)).toBe("text-muted-foreground");
    expect(deltaColor(0)).toBe("text-foreground");
    expect(deltaColor(0.001)).toBe(DIRECTION_TONE_CLASSES.up);
    expect(deltaColor(-0.001)).toBe(DIRECTION_TONE_CLASSES.down);
  });

  it("never prints a nonzero share as 0.0%", () => {
    expect(formatChainShare(null)).toBe("Unavailable");
    expect(formatChainShare(0)).toBe("0.0%");
    expect(formatChainShare(0.0001)).toBe("<0.1%");
    expect(formatChainShare(0.0006)).toBe("0.1%");
    expect(formatChainShare(0.4631)).toBe("46.3%");
  });
});
