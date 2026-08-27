import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MintingPressureArcGauge } from "@/components/minting-pressure-gauge";

describe("MintingPressureArcGauge", () => {
  it("renders flush zone joins with rounded outer ends", () => {
    const html = renderToStaticMarkup(
      <MintingPressureArcGauge mintVolume24hUsd={49} burnVolume24hUsd={51} />,
    );

    expect(html.match(/stroke-linecap="butt"/g)).toHaveLength(5);
    expect(html).toContain('<circle cx="20" cy="78" r="6.5" fill="#ef4444"');
    expect(html).toContain('<circle cx="140" cy="78" r="6.5" fill="#22c55e"');
  });
});
