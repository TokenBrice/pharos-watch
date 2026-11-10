import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MintAuthorityRail } from "../mint-authority-rail";
import type { MintAuthorityDetailControlViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";

function makeControl(overrides: Partial<MintAuthorityDetailControlViewModel> = {}): MintAuthorityDetailControlViewModel {
  return {
    key: "master-minter:ethereum:0xabc",
    label: "MasterMinter",
    roleKey: "minter-admin",
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
    processDiagnostics: [],
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

  it.each([
    { overrides: {}, expected: ">Minter admin multisig<" },
    { overrides: { roleKey: "timelock", roleLabel: "Timelock", authorityTypeKey: "timelock", authorityTypeLabel: "Timelock" }, expected: ">Timelock<" },
    { overrides: { roleKey: "governor", roleLabel: "Governor", authorityTypeKey: "contract", authorityTypeLabel: "Contract" }, expected: ">Governor<" },
    { overrides: { roleKey: "other", roleLabel: "Other", authorityTypeKey: "contract", authorityTypeLabel: "Contract" }, expected: ">Contract<" },
  ])("labels the control chip by role, falling back to type for generic roles ($expected)", ({ overrides, expected }) => {
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={[makeControl(overrides)]} />);
    expect(html).toContain(expected);
  });

  it("states the multisig threshold accessibly alongside the signer dots", () => {
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={[makeControl()]} />);
    expect(html).toContain('title="3 of 6 signers required"');
    expect(html).toContain("3/6");
  });

  it("falls back to a bare numeric threshold past the dot budget", () => {
    const html = renderToStaticMarkup(
      <MintAuthorityRail {...BASE_PROPS} controls={[makeControl({ threshold: 5, signerCount: 11 })]} />,
    );
    expect(html).toContain("5/11");
    // Past the budget the dot row is dropped entirely, so its signer title goes too.
    expect(html).not.toContain("signers required");
  });

  it("caps rail controls at three and points to the disclosure for the rest", () => {
    const controls = [0, 1, 2, 3, 4].map((index) =>
      makeControl({ key: `control-${index}`, roleLabel: `Ctl-${index}`, authorityTypeKey: "contract" }),
    );
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={controls} />);

    expect(html).toContain(">Ctl-0<");
    expect(html).toContain(">Ctl-1<");
    expect(html).toContain(">Ctl-2<");
    expect(html).not.toContain("Ctl-3");
    expect(html).not.toContain("Ctl-4");
    expect(html).toContain("+2 more in Primary controls");
  });

  it("bounds the overflow by the Primary controls fold while keeping the census count in the label", () => {
    const controls = [0, 1, 2, 3].map((index) => makeControl({ key: `control-${index}`, roleLabel: `Ctl-${index}` }));
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={controls} totalControlCount={149} />);
    expect(html).toContain("through 149 controls");
    // The fold holds all four rows and draws three, so one row remains there;
    // the census remainder belongs to the fold's own "Showing 4 of 149" line.
    expect(html).toContain("+1 more in Primary controls");
    expect(html).not.toContain("+146 more in Primary controls");
    expect(html).not.toContain("through 4 controls");
  });

  it("merges controls that would draw identical chips into one counted node", () => {
    const minter = {
      roleKey: "direct-minter",
      roleLabel: "Direct minter",
      authorityTypeKey: "contract",
      authorityTypeLabel: "Contract",
      threshold: null,
      signerCount: null,
    };
    const controls = [
      makeControl({ ...minter, key: "psm", label: "LitePSM" }),
      makeControl({ ...minter, key: "flash", label: "DssFlash" }),
      makeControl({ ...minter, key: "vat", label: "Vat join" }),
      makeControl({ key: "admin", label: "Ward Safe" }),
    ];
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={controls} />);

    expect(html.split(">Direct minter<")).toHaveLength(2);
    expect(html).toContain("×3");
    // Every merged control stays named in the node's hover text.
    expect(html).toContain("LitePSM, DssFlash, Vat join");
    expect(html).toContain(">Minter admin multisig<");
    // All four controls are drawn, so nothing is left to point to.
    expect(html).not.toContain("more in Primary controls");
    expect(html).toContain("through 4 controls");
  });

  it("keeps controls apart when their signer thresholds differ", () => {
    const controls = [
      makeControl({ key: "a", threshold: 2, signerCount: 4 }),
      makeControl({ key: "b", threshold: 3, signerCount: 6 }),
    ];
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={controls} />);
    expect(html.split(">Minter admin multisig<")).toHaveLength(3);
    expect(html).not.toContain("×");
  });

  it("renders every control with no overflow notice at exactly the cap", () => {
    const controls = [0, 1, 2].map((index) =>
      makeControl({ key: `control-${index}`, roleLabel: `Ctl-${index}`, authorityTypeKey: "contract" }),
    );
    const html = renderToStaticMarkup(<MintAuthorityRail {...BASE_PROPS} controls={controls} />);

    expect(html).toContain(">Ctl-2<");
    expect(html).not.toContain("more in Primary controls");
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
