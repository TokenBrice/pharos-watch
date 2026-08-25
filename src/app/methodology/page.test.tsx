import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import MethodologyPage from "@/app/methodology/page";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";

describe("MethodologyPage", () => {
  it("renders the reader guide, reading map, and section rail", () => {
    const html = renderToStaticMarkup(<MethodologyPage />);

    expect(html).toContain("Methodology");
    expect(html).toContain("How to Read This Page");
    expect(html).toContain("Reader mode keeps summaries up front.");
    expect(html).toContain("Pricing Pipeline");
    expect(html).toContain("Safety Scores");
    expect(html).toContain("Mint Authority Score");
    expect(html).toContain("Safety Score V9 Economic Control pillar, mint component");
    expect(html).toContain("Current V9 technical contract");
    expect(html).toContain("Backing 40% · Exit 35% · Economic Control 25%");
    for (const cap of V9_CANDIDATE_POLICY_V1.policy.semantic.formula.activeDepegCaps) {
      expect(html).toContain(`≥${cap.minimumBps / 100}% → ${cap.limit}`);
    }
    for (const ceiling of V9_CANDIDATE_POLICY_V1.policy.semantic.formula.trackRecordCeilings) {
      if (ceiling.limit !== null) {
        expect(html).toContain(`&lt;${ceiling.maxMonthsExclusive}m → ${ceiling.limit}`);
      }
    }
    expect(html).toContain("nearest uncapped · floor capped · 0 decimals");
    expect(html).toContain("active-depeg → structural → parent → evidence → track-record → bounded-compensability");
    expect(html).toContain("Historical V8.17 methodology");
    expect(html).toContain("Reader");
    expect(html).toContain("Analyst");
    expect(html).toContain("universal 15-minute onset confirmation window");
    expect(html).toContain("$1M");
    expect(html).toContain("March 9, 2026 trust-floor boundary");
  });

  it("renders every section anchor that methodology context deep-links to", () => {
    const html = renderToStaticMarkup(<MethodologyPage />);
    const anchors = new Set(
      Object.values(METHODOLOGY_CONTEXT)
        .map((item) => item.methodologyPath)
        .filter((path) => path.startsWith("/methodology/#"))
        .map((path) => path.slice("/methodology/#".length)),
    );

    expect(anchors.size).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(html, `methodologyPath anchor #${anchor} is not rendered on /methodology/`).toContain(`id="${anchor}"`);
    }
  });
});
