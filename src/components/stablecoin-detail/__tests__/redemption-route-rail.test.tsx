import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RedemptionRouteRail } from "../redemption-route-rail";
import { REDEMPTION_ACCESS_PASSPORT_LABELS, REDEMPTION_HOLDER_ELIGIBILITY_LABELS } from "@shared/lib/classification";
import type { RedemptionHolderEligibility } from "@shared/types/redemption";

const BASE_PROPS = {
  accessLabel: "Issuer / institutional",
  holderEligibility: "verified-customer" as const,
  settlementLabel: "Same day",
  outputAssetLabel: "Stable output",
  routeFamilyLabel: "Offchain issuer",
};

const OPEN_CONTRACT_PROPS = {
  ...BASE_PROPS,
  accessModel: "permissionless-onchain" as const,
  accessLabel: "Permissionless onchain",
};

const RESTRICTED_ELIGIBILITIES = (
  Object.keys(REDEMPTION_HOLDER_ELIGIBILITY_LABELS) as RedemptionHolderEligibility[]
).filter((eligibility) => eligibility !== "any-holder");

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
      <RedemptionRouteRail {...OPEN_CONTRACT_PROPS} holderEligibility="any-holder" />,
    );

    expect(permissionless).toContain(REDEMPTION_ACCESS_PASSPORT_LABELS["permissionless-onchain"]);
    expect(permissionless).not.toContain(REDEMPTION_ACCESS_PASSPORT_LABELS["issuer-api"]);
    expect(permissionless).toContain(
      'aria-label="Redemption route: holders exit through Permissionless onchain access to Offchain issuer, settling Same day into Stable output."',
    );
  });

  it("draws the gate open only for a permissionless contract that any holder may use", () => {
    const open = renderToStaticMarkup(<RedemptionRouteRail {...OPEN_CONTRACT_PROPS} holderEligibility="any-holder" />);

    expect(open).toContain(">Permissionless<");
    expect(open).toContain("state-positive");
    expect(open).toContain("border-dashed");
    expect(open).not.toContain("bg-foreground/60");
  });

  it.each(RESTRICTED_ELIGIBILITIES)(
    "draws an open contract closed and names its %s eligibility instead of the open gate",
    (holderEligibility) => {
      const label = REDEMPTION_HOLDER_ELIGIBILITY_LABELS[holderEligibility];
      const closed = renderToStaticMarkup(<RedemptionRouteRail {...OPEN_CONTRACT_PROPS} holderEligibility={holderEligibility} />);

      expect(closed).toContain(`>${label}<`);
      expect(closed).not.toContain(">Permissionless<");
      expect(closed).not.toContain("state-positive");
      expect(closed).not.toContain("border-dashed");
      expect(closed).toContain("bg-foreground/60");
      // The contract's own access label stays on hover; the diagram label spells out the gate as drawn.
      expect(closed).toContain('title="Permissionless onchain"');
      expect(closed).toContain(
        `aria-label="Redemption route: holders exit through Permissionless onchain access (${label}) to Offchain issuer, settling Same day into Stable output."`,
      );
    },
  );

  it("leaves a route that is closed by its access model on the bounded access label", () => {
    const whitelisted = renderToStaticMarkup(
      <RedemptionRouteRail {...BASE_PROPS} accessModel="whitelisted-onchain" holderEligibility="whitelisted-primary" />,
    );

    expect(whitelisted).toContain(`>${REDEMPTION_ACCESS_PASSPORT_LABELS["whitelisted-onchain"]}<`);
    expect(whitelisted).not.toContain(REDEMPTION_HOLDER_ELIGIBILITY_LABELS["whitelisted-primary"]);
    expect(whitelisted).toContain("bg-foreground/60");
  });
});
