import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RedemptionRouteRail } from "../redemption-route-rail";
import { REDEMPTION_ACCESS_PASSPORT_LABELS } from "@shared/lib/classification";

const BASE_PROPS = {
  accessLabel: "Issuer / institutional",
  settlementLabel: "Same day",
  outputAssetLabel: "Stable output",
  routeFamilyLabel: "Offchain issuer",
};

describe("RedemptionRouteRail", () => {
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

});
