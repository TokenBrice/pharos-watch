import { describe, expect, it } from "vitest";
import {
  buildDewsDisplay,
  buildDexDisplay,
  buildFlowDisplay,
  buildMcapDisplay,
  buildPegStatusDisplay,
  formatPsiDeltaValue,
  resolvePsiColorClass,
} from "@/components/kpi-bar-display-model";

describe("kpi-bar display model", () => {
  it("blanks market-cap displays when stablecoin data is absent", () => {
    const empty = buildMcapDisplay(
      { mcapChange24hPct: 1.2, mcapChange7dPct: -3.4, usdtUsdcSharePct: 66 },
      false,
    );
    expect(empty.change24Display).toBe("—");
    expect(empty.usdtShareDisplay).toBe("—");
    expect(empty.colorClass).toBe("text-muted-foreground");

    const present = buildMcapDisplay(
      { mcapChange24hPct: 1.2, mcapChange7dPct: -3.4, usdtUsdcSharePct: 66.04 },
      true,
    );
    expect(present.usdtShareDisplay).toBe("66.0%");
  });

  it("formats peg status as a fraction or em-dash", () => {
    expect(buildPegStatusDisplay({ coinsAtPeg: 137, totalTracked: 147 })).toBe("137/147");
    expect(buildPegStatusDisplay(undefined)).toBe("—");
  });

  it("gates DEX turnover on stablecoin + dex data and positive mcap", () => {
    const snapshot = { totalVol24h: 1, volVs7dAvgPct: 2, turnoverPct: 0.5 };
    expect(buildDexDisplay(snapshot, true, true, 100).turnoverDisplay).toBe("0.50%");
    expect(buildDexDisplay(snapshot, true, true, 0).turnoverDisplay).toBe("—");
    expect(buildDexDisplay(snapshot, false, true, 100).turnoverDisplay).toBe("—");
  });

  it("derives net-flow tone from the 7d value", () => {
    expect(buildFlowDisplay({ netFlow24h: 1, netFlow7d: 5 }, true).netFlow7Tone).toBe("positive");
    expect(buildFlowDisplay({ netFlow24h: 1, netFlow7d: -5 }, true).netFlow7Tone).toBe("negative");
    expect(buildFlowDisplay({ netFlow24h: 1, netFlow7d: 0 }, true).netFlow7Tone).toBe("neutral");
    expect(buildFlowDisplay({ netFlow24h: 1, netFlow7d: 5 }, false).netFlow7Tone).toBe("neutral");
  });

  it("escalates DEWS severity by band priority", () => {
    expect(buildDewsDisplay(null)).toMatchObject({ elevatedCount: 0, allCalm: false });
    expect(buildDewsDisplay({ danger: 0, alert: 0, warning: 0 })).toMatchObject({
      elevatedCount: 0,
      allCalm: true,
    });
    expect(buildDewsDisplay({ danger: 1, alert: 2, warning: 3 })).toMatchObject({
      elevatedCount: 6,
      severityClass: "text-red-700 dark:text-red-400",
    });
    expect(buildDewsDisplay({ danger: 0, alert: 2, warning: 0 }).severityClass).toBe(
      "text-yellow-700 dark:text-yellow-400",
    );
  });

  it("signs PSI deltas and passes through null", () => {
    expect(formatPsiDeltaValue(0.4)).toBe("+0.4");
    expect(formatPsiDeltaValue(-1.25)).toBe("-1.3");
    expect(formatPsiDeltaValue(null)).toBeNull();
  });

  it("resolves PSI color class only for known bands", () => {
    expect(resolvePsiColorClass("BEDROCK")).not.toBe("");
    expect(resolvePsiColorClass("")).toBe("");
    expect(resolvePsiColorClass("UNKNOWN")).toBe("");
  });
});
