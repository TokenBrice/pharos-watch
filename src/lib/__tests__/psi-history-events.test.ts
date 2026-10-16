import { describe, expect, it } from "vitest";
import { BAND_ZONES } from "@/lib/psi-history-events";
import { PSI_CONDITION_BANDS } from "@shared/lib/psi-policy";
import { PSI_HEX_COLORS } from "@shared/lib/classification";

describe("buildVisiblePsiChartEvents", () => {
  it("derives contiguous chart intervals and colors from the canonical bands", () => {
    expect(BAND_ZONES).toEqual(PSI_CONDITION_BANDS.map(({ min, band }, index) => ({
      y1: min,
      y2: index === 0 ? 100 : PSI_CONDITION_BANDS[index - 1].min,
      color: PSI_HEX_COLORS[band],
      label: band,
    })));
  });

});
