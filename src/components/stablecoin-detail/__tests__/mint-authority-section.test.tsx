import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MintAuthoritySection } from "../mint-authority-section";
import type { MintAuthorityDetailViewModel } from "@/lib/stablecoin-detail-view-model";

const REVIEWED_PROFILE: MintAuthorityDetailViewModel = {
  status: "reviewed",
  reviewLabel: "Reviewed by Pharos",
  mintPathLabel: "Facilitator bucket mint",
  mintPathShortLabel: "Facilitator",
  authorityPostureLabel: "Partially bounded admin",
  authorityPostureTone: "neutral",
  confidenceLabel: "Verified",
  confidenceVerified: true,
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
      addressUrl: "https://etherscan.io/address/0x123400000000000000000000000000000000abcd",
      securitySetupLabel: "DAO governor, 3/5 threshold",
      thresholdLabel: "3/5 threshold",
      timelockLabel: "1d timelock",
      capDescription: "Facilitator bucket capacity limits minting.",
      modulesOrGuardsLabel: "No modules or guards detected",
      custodyLabel: null,
    },
  ],
  sources: [
    {
      label: "Aave GHO facilitators",
      url: "https://example.com/gho-facilitators",
    },
  ],
  score: {
    score: 70,
    scoreLabel: "70/100",
    compactLabel: "70 Governed",
    bandLabel: "Governed",
    badgeClassName: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    textClassName: "text-blue-700 dark:text-blue-400",
    detail: "Mint Authority Score: 70/100 (Governed).",
    components: [
      {
        key: "route",
        label: "Route",
        scoreLabel: "60/100",
        weightLabel: "30%",
        textClassName: "text-blue-700 dark:text-blue-400",
      },
      {
        key: "controller",
        label: "Controller",
        scoreLabel: "80/100",
        weightLabel: "40%",
        textClassName: "text-emerald-700 dark:text-emerald-400",
      },
      {
        key: "bounds",
        label: "Bounds",
        scoreLabel: "85/100",
        weightLabel: "15%",
        textClassName: "text-emerald-700 dark:text-emerald-400",
      },
      {
        key: "posture",
        label: "Posture",
        scoreLabel: "60/100",
        weightLabel: "15%",
        textClassName: "text-blue-700 dark:text-blue-400",
      },
    ],
    rawScoreLabel: "72/100",
    confidenceCapLabel: "<= 100",
    weakestControlLabel: "Aave Ethereum Governance",
    weakestControlScoreLabel: "80/100",
    weakestControlCustodyLabel: null,
    capsApplied: [],
    unresolvedReasonLabel: null,
  },
  reviewedAt: "2026-05-12",
  mintIncident: null,
};

describe("MintAuthoritySection", () => {
  it("hides the section until a compact review is available", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={undefined} />);

    expect(html).toBe("");
  });

  it("renders reviewed mint authority summary, controls, and sources", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={REVIEWED_PROFILE} />);

    expect(html).toContain("Facilitator bucket mint");
    expect(html).toContain("70/100");
    expect(html).toContain("Governed");
    expect(html).toContain("Standalone score");
    expect(html).toContain("Not a Safety Score input");
    expect(html).toContain("Scoring breakdown");
    expect(html).toContain("Controller");
    expect(html).toContain("40%");
    expect(html).toContain("Raw score");
    expect(html).toContain("No caps applied");
    expect(html).toContain("Partially bounded admin");
    expect(html).toContain("Confidence: Verified");
    expect(html).toContain("GHO supply is minted by DAO-approved facilitators");
    expect(html).toContain("Aave Ethereum Governance");
    expect(html).toContain("DAO governor");
    expect(html).toContain("Cap-limited");
    expect(html).toContain("Setup");
    expect(html).toContain("DAO governor, 3/5 threshold");
    expect(html).toContain("Safe modules/guard");
    expect(html).toContain("No modules or guards detected");
    expect(html).toContain("https://etherscan.io/address/0x123400000000000000000000000000000000abcd");
    expect(html).toContain("1d timelock");
    expect(html).toContain("Facilitator bucket capacity limits minting");
    expect(html).toContain("Aave GHO facilitators");
    expect(html).toContain("https://example.com/gho-facilitators");
    expect(html).toContain("Methodology v1.0");
    expect(html).toContain("Reviewed 2026-05-12");
  });

  it("renders incident caps and custody context when present", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection
        profile={{
          ...REVIEWED_PROFILE,
          controls: [
            {
              ...REVIEWED_PROFILE.controls[0],
              authorityTypeLabel: "Externally owned account",
              securitySetupLabel: "Externally owned account",
              custodyLabel: "Single-key address - custody unverifiable",
            },
          ],
          score: {
            ...REVIEWED_PROFILE.score!,
            score: 10,
            scoreLabel: "10/100",
            compactLabel: "10 Exposed",
            bandLabel: "Exposed",
            badgeClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
            textClassName: "text-red-700 dark:text-red-400",
            capsApplied: ["Incident cap <= 10"],
            weakestControlCustodyLabel: "Single-key address - custody unverifiable",
          },
          mintIncident: {
            date: "2024-06-13",
            summary: "Privileged mint authority created unbacked supply during an exploit.",
          },
        }}
      />,
    );

    expect(html).toContain("Mint incident 2024-06-13");
    expect(html).toContain("Privileged mint authority created unbacked supply");
    expect(html).toContain("Incident cap &lt;= 10");
    expect(html).toContain("Single-key address - custody unverifiable");
  });
});
