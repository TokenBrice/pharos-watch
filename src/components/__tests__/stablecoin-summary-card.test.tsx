import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeroCompactSupplyCell } from "@/components/stablecoin-detail/hero-card-metrics";

describe("stablecoin summary card", () => {
  it("renders an em dash when historical supply deltas are unavailable", () => {
    const markup = renderToStaticMarkup(
      <HeroCompactSupplyCell
        supply={1_000}
        coinSymbol="USDT"
        safePrevWeek={null}
        prevWeekTrendClass="text-muted-foreground"
        hasPrevMonth
        safePrevMonth={null}
        prevMonthTrendClass="text-muted-foreground"
      />,
    );

    expect(markup).toContain("30D");
    expect(markup.match(/—/g)).toHaveLength(2);
  });
});
