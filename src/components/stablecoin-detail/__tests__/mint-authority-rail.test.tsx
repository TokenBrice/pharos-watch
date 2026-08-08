import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MintAuthorityRail } from "../mint-authority-rail";
import type { MintAuthorityDetailControlViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";

function makeControl(overrides: Partial<MintAuthorityDetailControlViewModel> = {}): MintAuthorityDetailControlViewModel {
  return {
    key: "master-minter:ethereum:0xabc",
    label: "MasterMinter",
    roleLabel: "Minter admin",
    authorityTypeKey: "multisig",
    authorityTypeLabel: "Multisig",
    threshold: 3,
    signerCount: 6,
    directMintAbilityLabel: "Direct",
    locationLabel: "ethereum / 0xabc...def",
    fullLocationLabel: "ethereum / 0xabcdef",
    addressUrl: "https://etherscan.io/address/0xabcdef",
    securitySetupLabel: "Multisig, 3/6 threshold",
    thresholdLabel: "3/6 threshold",
    timelockLabel: null,
    capDescription: null,
    modulesOrGuardsLabel: null,
    custodyLabel: null,
    ...overrides,
  };
}

const BASE_PROPS = {
  symbol: "USDC",
  mintPathShortLabel: "Issuer direct",
  mintPathLabel: "Issuer direct mint",
  postureLabel: "Unbounded, supervised & reconciled",
  postureTone: "elevated" as const,
};

describe("MintAuthorityRail", () => {
  it("renders issuer, control, and supply stations from the view model", () => {
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={[makeControl()]} />);

    expect(html).toContain("Issuer direct");
    expect(html).toContain("Issuer direct mint"); // full label carried as the origin title
    expect(html).toContain("Multisig");
    expect(html).toContain("3/6");
    expect(html).toContain("USDC");
    expect(html).toContain("Unbounded, supervised &amp; reconciled");
  });

  it("draws one signer dot per signer with the threshold filled", () => {
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={[makeControl()]} />);
    expect(html.match(/bg-foreground\/80/g)?.length).toBe(3);
    expect(html.match(/bg-muted-foreground\/25/g)?.length).toBe(3);
  });

  it("falls back to a numeric threshold past the dot budget", () => {
    const html = renderToStaticMarkup(
      <MintAuthorityRail {...BASE_PROPS} controls={[makeControl({ threshold: 5, signerCount: 11 })]} />,
    );
    expect(html).toContain("5/11");
    expect(html).not.toContain("bg-foreground/80");
  });

  it("gives EOA controls the caution tone and short label", () => {
    const html = renderToStaticMarkup(
      <MintAuthorityRail
        {...BASE_PROPS}
        controls={[
          makeControl({
            authorityTypeKey: "eoa",
            authorityTypeLabel: "Externally owned account",
            threshold: null,
            signerCount: null,
          }),
        ]}
      />,
    );
    expect(html).toContain(">EOA<");
    expect(html).toContain("text-amber-700");
  });

  it("caps rail controls at three and points to the disclosure for the rest", () => {
    const controls = [0, 1, 2, 3, 4].map((index) => makeControl({ key: `control-${index}` }));
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={controls} />);
    expect(html).toContain("+2 more in Primary controls");
  });

  it("renders nothing without controls or with an unknown mint path", () => {
    expect(renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={[]} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <MintAuthorityRail {...BASE_PROPS} mintPathShortLabel="Unknown" controls={[makeControl()]} />,
      ),
    ).toBe("");
  });
});
