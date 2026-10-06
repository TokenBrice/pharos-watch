import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MintingPressureArcGauge } from "@/components/minting-pressure-gauge";

describe("MintingPressureArcGauge", () => {
  it("draws routine minting in green only, never red", () => {
    const html = renderToStaticMarkup(
      <MintingPressureArcGauge mintVolume24hUsd={93} burnVolume24hUsd={7} />,
    );

    expect(html).toContain('stroke="#22c55e"');
    expect(html).not.toContain("#ef4444");
    expect(html).not.toContain("text-red");
  });

  it("reserves red for burn-dominated flow", () => {
    const html = renderToStaticMarkup(
      <MintingPressureArcGauge mintVolume24hUsd={10} burnVolume24hUsd={90} />,
    );

    expect(html).toContain('stroke="#ef4444"');
    expect(html).not.toContain('stroke="#22c55e"');
  });

  it("draws only the neutral track when balanced", () => {
    const html = renderToStaticMarkup(
      <MintingPressureArcGauge mintVolume24hUsd={50} burnVolume24hUsd={50} />,
    );

    expect(html).not.toContain("#ef4444");
    expect(html).not.toContain("#22c55e");
  });
});
