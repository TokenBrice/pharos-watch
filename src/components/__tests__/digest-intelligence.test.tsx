import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DigestIntelligencePanel } from "@/components/digest-intelligence";

describe("DigestIntelligencePanel", () => {
  it("prints bps figures with a separator and space, and sentence-case statuses", () => {
    const html = renderToStaticMarkup(
      <DigestIntelligencePanel
        riskTape={[{ id: "depegs", label: "Depegs", value: "MSUSD 5070bps", tone: "critical", detail: "" }]}
        standingConditions={[{ stablecoinId: "pmusd", symbol: "pmUSD", ageDays: 124, currentBps: -4953 }]}
        forwardLookOutcomes={[{ id: "o1", triggerId: "trigger-o1", label: "USTB weekly supply move", status: "missed", detail: "" }]}
      />,
    );

    expect(html).toContain("MSUSD 5,070 bps");
    expect(html).toContain("pmUSD d124 -4,953 bps");
    expect(html).toContain("Missed: USTB weekly supply move");
    expect(html).not.toMatch(/uppercase|tracking-/);
  });

  it("keeps the direction of a standing deviation visible", () => {
    const render = (currentBps: number) => renderToStaticMarkup(
      <DigestIntelligencePanel
        standingConditions={[{ stablecoinId: "xau", symbol: "XAUm", ageDays: 10, currentBps }]}
      />,
    );
    const above = render(1660);
    const below = render(-1660);
    expect(above).toContain("XAUm d10 +1,660 bps");
    expect(below).toContain("XAUm d10 -1,660 bps");
    expect(above).not.toBe(below);
  });
});
