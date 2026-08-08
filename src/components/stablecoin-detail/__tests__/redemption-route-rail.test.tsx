import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RedemptionRouteRail } from "../redemption-route-rail";

const BASE_PROPS = {
  accessLabel: "Issuer / institutional",
  settlementLabel: "Same day",
  outputAssetLabel: "Stable output",
  routeFamilyLabel: "Offchain issuer",
};

describe("RedemptionRouteRail", () => {
  it("renders holder, gate, venue, settlement, and output from published fields", () => {
    const html = renderToStaticMarkup(<RedemptionRouteRail {...BASE_PROPS} accessModel="issuer-api" />);

    expect(html).toContain("Holder");
    expect(html).toContain("Issuer / institutional");
    expect(html).toContain("Offchain issuer");
    expect(html).toContain("Same day");
    expect(html).toContain("Stable output");
  });

  it("draws a closed gate for restricted access and an open gate for permissionless routes", () => {
    const closed = renderToStaticMarkup(<RedemptionRouteRail {...BASE_PROPS} accessModel="issuer-api" />);
    expect(closed).toContain("bg-foreground/60");
    expect(closed).not.toContain("border-dashed border-emerald-600/70");

    const open = renderToStaticMarkup(
      <RedemptionRouteRail {...BASE_PROPS} accessModel="permissionless-onchain" accessLabel="Permissionless onchain" />,
    );
    expect(open).toContain("border-dashed border-emerald-600/70");
    expect(open).not.toContain("bg-foreground/60");
  });

  it("keeps the FactGrid fallback for narrow viewports", () => {
    const html = renderToStaticMarkup(<RedemptionRouteRail {...BASE_PROPS} accessModel="manual" />);
    // The sm:hidden grid carries the same three facts as label-over-value.
    expect(html).toContain("sm:hidden");
    expect(html).toContain("Access");
    expect(html).toContain("Settlement");
    expect(html).toContain("Output");
  });
});
