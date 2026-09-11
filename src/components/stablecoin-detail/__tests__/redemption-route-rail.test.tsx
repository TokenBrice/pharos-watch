import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RedemptionRouteRail } from "../redemption-route-rail";
import { REDEMPTION_ACCESS_PASSPORT_LABELS } from "@shared/lib/redemption-backstop-scoring";

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

  it("names the access gate with the published passport vocabulary and the full access label", () => {
    const restricted = renderToStaticMarkup(<RedemptionRouteRail {...BASE_PROPS} accessModel="issuer-api" />);

    expect(restricted).toContain(REDEMPTION_ACCESS_PASSPORT_LABELS["issuer-api"]);
    expect(restricted).not.toContain(REDEMPTION_ACCESS_PASSPORT_LABELS["permissionless-onchain"]);
    // The truncating full label stays reachable on hover and in the diagram label.
    expect(restricted).toContain('title="Issuer / institutional"');
    expect(restricted).toContain(
      'aria-label="Redemption route: holders exit through Issuer / institutional access to Offchain issuer, settling Same day into Stable output."',
    );

    const permissionless = renderToStaticMarkup(
      <RedemptionRouteRail {...BASE_PROPS} accessModel="permissionless-onchain" accessLabel="Permissionless onchain" />,
    );

    expect(permissionless).toContain(REDEMPTION_ACCESS_PASSPORT_LABELS["permissionless-onchain"]);
    expect(permissionless).not.toContain(REDEMPTION_ACCESS_PASSPORT_LABELS["issuer-api"]);
    expect(permissionless).toContain(
      'aria-label="Redemption route: holders exit through Permissionless onchain access to Offchain issuer, settling Same day into Stable output."',
    );
  });

  it("repeats the route facts in the labelled fallback grid for narrow columns", () => {
    const html = renderToStaticMarkup(<RedemptionRouteRail {...BASE_PROPS} accessModel="manual" />);

    // The fallback grid carries the same three facts as label-over-value.
    expect(html).toContain('aria-label="Route properties"');
    expect(html).toContain("Access");
    expect(html).toContain("Settlement");
    expect(html).toContain("Output");
  });
});
