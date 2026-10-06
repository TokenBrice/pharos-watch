import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MintAuthoritySection } from "../mint-authority-section";
import type { MintAuthorityDetailViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { makePublishedProcessDiagnostic } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinDetailClientCoin } from "@/lib/stablecoin-detail-client-coin";
import { buildMintAuthorityDetailViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";

const REVIEWED_PROFILE: MintAuthorityDetailViewModel = {
  status: "reviewed",
  reviewLabel: "Reviewed by Pharos",
  mintPathLabel: "Facilitator bucket mint",
  mintPathShortLabel: "Facilitator",
  authorityPostureLabel: "Partially bounded admin",
  authorityPostureTone: "neutral",
  confidenceLabel: "Verified",
  confidenceVerified: true,
  verdict: "Governed — facilitators mint GHO within bucket caps, controlled by DAO governance; admin powers are only partly bounded.",
  summary: "GHO supply is minted by DAO-approved facilitators within bucket capacity.",
  inheritedFrom: null,
  controls: [
    {
      key: "aave-governance",
      label: "Aave Ethereum Governance",
      roleKey: "facilitator",
      roleLabel: "Facilitator",
      authorityTypeKey: "dao-governor",
      authorityTypeLabel: "DAO governor",
      threshold: 3,
      signerCount: 5,
      directMintAbilityLabel: "Cap-limited",
      locationLabel: "ethereum / 0x1234...abcd",
      fullLocationLabel: "ethereum / 0x123400000000000000000000000000000000abcd",
      addressUrl: "https://etherscan.io/address/0x123400000000000000000000000000000000abcd",
      securitySetupLabel: "DAO governor, 3/5 threshold",
      thresholdLabel: "3/5 threshold",
      timelockLabel: "1d timelock",
      capDescription: "Facilitator bucket capacity limits minting.",
      modulesOrGuardsLabel: "No modules or guards detected",
      custodyLabel: null,
      processDiagnostics: [],
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
    compactLabel: "70 · Governed",
    bandKey: "governed",
    bandLabel: "Governed",
    postureLabel: "Partially bounded admin",
    badgeClassName: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    textClassName: "text-blue-700 dark:text-blue-400",
    detail: "Mint control posture: 70/100 (Governed).",
    caps: [],
  },
  reviewedAt: "2026-05-12",
  mintIncidents: [],
  sourceFreeRationale: null,
  unresolvedQuestions: [],
  processDiagnostics: [], processMetrics: [],
};

describe("MintAuthoritySection", () => {
  it("hides the section until a compact review is available", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={undefined} />);

    expect(html).toBe("");
  });

  it("renders a compact not-reviewed state", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection
        profile={{
          status: "not-reviewed",
          reviewLabel: "Not reviewed by Pharos",
          mintPathLabel: "Unknown",
          mintPathShortLabel: "Unknown",
          authorityPostureLabel: "Unknown",
          authorityPostureTone: "neutral",
          confidenceLabel: "Not reviewed",
          confidenceVerified: false,
          verdict: null,
          summary: "Unknown does not mean no privileged mint authority.",
          inheritedFrom: null,
          controls: [],
          sources: [],
          score: null,
          reviewedAt: null,
          mintIncidents: [],
          sourceFreeRationale: null,
          unresolvedQuestions: [],
          processDiagnostics: [], processMetrics: [],
        }}
      />,
    );

    expect(html).toContain("Not reviewed by Pharos");
    expect(html).toContain("Mint control posture: NR");
    expect(html).toContain("Unknown does not mean no privileged mint authority.");
  });

  it("keeps one verdict in the summary layer and folds the narrative after Primary controls", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" />);

    expect(html).toContain(REVIEWED_PROFILE.verdict!);
    const verdictAt = html.indexOf(REVIEWED_PROFILE.verdict!);
    const controlsAt = html.indexOf(">Primary controls<");
    const notesAt = html.indexOf(">Review notes<");
    const narrativeAt = html.indexOf(REVIEWED_PROFILE.summary);
    expect(verdictAt).toBeLessThan(controlsAt);
    expect(controlsAt).toBeLessThan(notesAt);
    expect(notesAt).toBeLessThan(narrativeAt);
    // No issuance evidence published: no diagnostics fold at all.
    expect(html).not.toContain("Issuance diagnostics");
  });

  it("renders the band beside the score and links inherited mint risk to the parent review", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection
        profile={{ ...REVIEWED_PROFILE, inheritedFrom: { symbol: "USDe", href: "/stablecoin/usde-ethena/#mint-authority" } }}
        symbol="sUSDe"
      />,
    );

    expect(html).toContain(">70 · Governed<");
    expect(html).toContain("Inherits USDe mint risk");
    expect(html).toMatch(/href="\/stablecoin\/usde-ethena\/?#mint-authority"/);
  });

  it("renders control and source link destinations with the V9 methodology stamp", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection profile={REVIEWED_PROFILE} />,
    );

    expect(html).toContain("https://etherscan.io/address/0x123400000000000000000000000000000000abcd");
    expect(html).toContain("https://example.com/gho-facilitators");
    // 9.1: the card publishes the V9 mint component, so it stamps the
    // safety-score identity rather than the retired mint-authority lane.
    expect(html).toContain(`Methodology ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}`);
    expect(html).not.toContain("Methodology v1.3");
  });

  it.each([
    { id: "dai-makerdao", total: 149, omitted: 137 },
    { id: "usds-sky", total: 19, omitted: 7 },
  ])("discloses the full $id census count while rendering only the bounded controls", ({ id, total, omitted }) => {
    const coin = TRACKED_META_BY_ID.get(id)!;
    const view = buildMintAuthorityDetailViewModel(buildStablecoinDetailClientCoin(coin));
    const html = renderToStaticMarkup(<MintAuthoritySection profile={view} symbol={coin.symbol} />);

    expect(html.match(/<li class="px-3 py-2\.5">/g)).toHaveLength(12);
    expect(html).toContain(`Showing 12 of ${total} primary controls; and ${omitted} more controls.`);
    expect(html).toContain(`Primary controls</span>`);
    expect(html).toContain(`>(${total})</span>`);
    expect(html).toContain(`through ${total} controls`);
    expect(html).toContain(`+${total - 3} more in Primary controls`);
    expect(html).toContain(`href="${view.controlCensusUrl}"`);
    expect(html).toMatch(/href="\/methodology\/?#mint-authority-score"/);
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
            compactLabel: "10 · Exposed",
            bandLabel: "Exposed",
            badgeClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
            textClassName: "text-red-700 dark:text-red-400",
            caps: [
              {
                kind: "signal:centralized-mint:critical",
                label: "Centralized mint (critical)",
                limitLabel: "<= 10",
                reason: "Economically effective minting is unbounded or compromised.",
              },
            ],
          },
          mintIncidents: [
            {
              date: "2024-06-13",
              status: "active",
              resolvedAt: null,
              summary: "Privileged mint authority created unbacked supply during an exploit.",
              sources: [{ label: "Incident report", url: "https://example.com/incident" }],
            },
          ],
        }}
      />,
    );

    // An active incident keeps the loud in-summary callout.
    expect(html).toContain("Mint incident 2024-06-13");
    expect(html).toContain("Privileged mint authority created unbacked supply");
    // Structural caps render inside the scoring breakdown with their reason.
    expect(html).toContain("Centralized mint (critical)");
    expect(html).toContain("&lt;= 10");
    expect(html).toContain("Economically effective minting is unbounded or compromised.");
    expect(html).toContain("Incident report");
    expect(html).toContain("https://example.com/incident");
    expect(html).toContain("Single-key address - custody unverifiable");
  });

  it("folds resolved incidents into a calm incident history ledger", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection
        profile={{
          ...REVIEWED_PROFILE,
          mintIncidents: [
            {
              date: "2025-10-04",
              status: "resolved",
              resolvedAt: "2025-10-04",
              summary: "Second exploit borrowed stablecoin with no collateral.",
              sources: [],
            },
            {
              date: "2024-01-30",
              status: "resolved",
              resolvedAt: null,
              summary: "First exploit turned the borrow route into bad debt.",
              sources: [],
            },
          ],
        }}
      />,
    );

    // Resolved incidents are a historical record behind the disclosure: each
    // carries the resolved status word and none is presented as active.
    expect(html).toContain("Incident history");
    expect(html).toMatch(/Mint incident 2025-10-04<span[^>]*>Resolved</);
    expect(html).toContain("Second exploit borrowed stablecoin with no collateral.");
    expect(html).toMatch(/Mint incident 2024-01-30<span[^>]*>Resolved</);
    expect(html).toContain("First exploit turned the borrow route into bad debt.");
    expect(html).not.toMatch(/>Active</);
  });

  it("draws the mint rail and band ladder when a symbol is provided, absorbing the path and posture chips", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={REVIEWED_PROFILE} symbol="GHO" />);

    // Band ladder lights the published band; the standalone band text goes.
    expect(html).toContain("Hardened");
    expect(html).toContain("Exposed");
    // Rail stations: issuer path, control glyph row, supply symbol + posture.
    expect(html).toContain("Facilitator");
    expect(html).toContain("3/5");
    expect(html).toContain("GHO");
    expect(html).toContain("Partially bounded admin");
    // Absorbed chips: the full mint-path label survives only as the origin title.
    expect(html).not.toContain(">Facilitator bucket mint<");
    expect(html).toContain("Facilitator bucket mint");
  });

  it("keeps the chip summary when no symbol is available for the rail", () => {
    const html = renderToStaticMarkup(<MintAuthoritySection profile={REVIEWED_PROFILE} />);
    expect(html).toContain("Facilitator bucket mint");
    expect(html).toContain("Partially bounded admin");
  });

  it("renders verification gaps when review questions remain", () => {
    const html = renderToStaticMarkup(
      <MintAuthoritySection
        profile={{
          ...REVIEWED_PROFILE,
          sourceFreeRationale: "No public Safe module page exists for this chain.",
          unresolvedQuestions: ["Confirm whether the proxy admin can upgrade mint logic."],
        }}
      />,
    );

    expect(html).toContain("Verification gaps");
  });
});

describe("mint issuance diagnostics fold", () => {
  it("folds published groups after Primary controls and distinguishes missing proof from a failed screen at NR", () => {
    const base = { ...makePublishedProcessDiagnostic({
      code: "operational-cap-unproved", gate: "H2", controlRef: null, pathId: "redo", classId: "keeper-class", memberRef: null,
      field: "maxKeeperFixedRewardSupplyPpm", evidenceRefIds: ["read-code", "proof-2", "proof-3", "proof-4"],
    }, { count: 4 }), key: "process-missing", statusLabel: "Missing evidence" as const };
    const failed = { ...makePublishedProcessDiagnostic({
      code: "operational-screen-failed", gate: "H3", controlRef: null, pathId: null, classId: null, memberRef: null,
      field: "operationalExposurePpm", evidenceRefIds: [],
    }), key: "failed-exposure", statusLabel: "Failed screen" as const };
    const html = renderToStaticMarkup(<MintAuthoritySection profile={{ ...REVIEWED_PROFILE, score: null,
      processMetrics: [{ label: "Actual operational exercise delay", value: "0 s" }],
      processDiagnostics: [base, failed],
    }} />);
    expect(html).toContain("Issuance diagnostics");
    expect(html.indexOf(">Primary controls<")).toBeLessThan(html.indexOf("Issuance diagnostics"));
    expect(html).toContain(">(2)</span>");
    expect(html).toContain("in 2 groups");
    expect(html).toContain("Missing evidence");
    expect(html).toContain("Failed screen");
    expect(html).toContain("Gate H3");
    expect(html).toContain("Class keeper-class");
    expect(html).toContain("operationalExposurePpm");
    expect(html).toContain("Group total: 4 across 1 control reference. Showing 1 sampled exemplar, not an exhaustive member list.");
    expect(html).toContain("3 sampled / 4 total references");
    expect(html).toContain("0 s");
    expect(html).toContain("NR");
  });
});
