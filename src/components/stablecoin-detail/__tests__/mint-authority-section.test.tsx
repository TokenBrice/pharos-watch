import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MintAuthoritySection } from "../mint-authority-section";
import type { MintAuthorityDetailViewModel } from "@/lib/stablecoin-detail-view-model";

const REVIEWED_PROFILE: MintAuthorityDetailViewModel = {
  status: "reviewed",
  reviewLabel: "Reviewed by Pharos",
  mintPathLabel: "Facilitator bucket mint",
  authorityPostureLabel: "Partially bounded admin",
  confidenceLabel: "Verified",
  summary: "GHO supply is minted by DAO-approved facilitators within bucket capacity.",
  inheritedFrom: null,
  controls: [
    {
      key: "aave-governance",
      label: "Aave Ethereum Governance",
      roleLabel: "Facilitator",
      authorityTypeLabel: "DAO governor",
      directMintAbilityLabel: "Cap-limited",
      locationLabel: "ethereum / 0x1234...abcd",
      thresholdLabel: "3/5 threshold",
      timelockLabel: "1d timelock",
      capDescription: "Facilitator bucket capacity limits minting.",
      modulesOrGuardsLabel: "Not applicable",
    },
  ],
  sources: [
    {
      label: "Aave GHO facilitators",
      url: "https://example.com/gho-facilitators",
    },
  ],
};

describe("MintAuthoritySection", () => {
  it("hides the section until a compact review is available", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={undefined} />);

    expect(html).toBe("");
  });

  it("renders reviewed mint authority summary, controls, and sources", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={REVIEWED_PROFILE} />);

    expect(html).toContain("Facilitator bucket mint");
    expect(html).toContain("Partially bounded admin");
    expect(html).toContain("Confidence: Verified");
    expect(html).toContain("GHO supply is minted by DAO-approved facilitators");
    expect(html).toContain("Aave Ethereum Governance");
    expect(html).toContain("DAO governor");
    expect(html).toContain("Cap-limited");
    expect(html).toContain("3/5 threshold");
    expect(html).toContain("1d timelock");
    expect(html).toContain("Facilitator bucket capacity limits minting");
    expect(html).toContain("Aave GHO facilitators");
    expect(html).toContain("https://example.com/gho-facilitators");
  });
});
