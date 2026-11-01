// @vitest-environment jsdom
import { RailSafetySummary } from "../rail-safety-summary";

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinAiSummary, StablecoinMeta } from "@shared/types";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const mockGetSnapshotSafetyAssessment = vi.hoisted(() =>
  vi.fn<(stablecoinId: string) => { grade: string; score: number | null; bucket: string } | null>(() => null),
);
vi.mock("@/lib/safety-grade-snapshot", () => ({
  getSnapshotSafetyAssessment: mockGetSnapshotSafetyAssessment,
}));
vi.mock("@/lib/datasets/public-dataset-current", () => ({
  PUBLIC_DATASET_CURRENT_DATE: "2026-10-19",
}));
const mockRedemptionConfigs = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@shared/lib/redemption-backstop-configs", () => ({
  REDEMPTION_BACKSTOP_CONFIGS: mockRedemptionConfigs,
}));

const { StablecoinDetailSeoContent, buildStablecoinFaqItems } = await import("../static-seo-content");
const { FaqSection } = await import("@/components/faq-section");

const coin: StablecoinMeta = {
  id: "test-dollar",
  name: "Test Dollar",
  symbol: "TSTD",
  flags: {
    governance: "centralized-dependent",
    backing: "rwa-backed",
    pegCurrency: "USD",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
  collateral: "Cash, Treasury bills, and overnight repos.",
  pegMechanism: "Primary market mint and redeem arbitrage plus secondary market liquidity.",
  jurisdiction: {
    country: "United States",
    regulator: "NYDFS",
    license: "Limited Purpose Trust",
  },
  proofOfReserves: {
    type: "independent-audit",
    provider: "Example Auditor",
    url: "https://example.com/reserves",
  },
  contracts: [
    { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
    { chain: "base", address: "0x0000000000000000000000000000000000000002", decimals: 6 },
    { chain: "solana", address: "So11111111111111111111111111111111111111112", decimals: 6 },
  ],
  infrastructures: ["m0"],
};

const summary: StablecoinAiSummary = {
  title: "Test Dollar profile",
  text: "The profile summary uses {{term:money-market-fund}}MMFs{{/term}} and stays specific. Extra detail should stay short enough for the static block.",
  updatedAt: "2026-05-02",
  authoredBy: "ai",
  model: "claude-opus-4-7",
  reviewedBy: "@TokenBrice",
  reviewedAt: "2026-05-02",
  factsAsOf: "2026-05-02",
};

describe("StablecoinDetailSeoContent", () => {
  it("withholds assertive live-claim prose while retaining summary provenance and profile facts", () => {
    const { container } = render(<StablecoinDetailSeoContent coin={coin} summary={{
      ...summary,
      text: "The {{grade}} overall grade is set by the exit pillar.",
      claimTokens: [{
        token: "grade", placeholder: "{{grade}}", source: "report-card.grade", factsAsOf: "2026-05-02",
      }],
    }} />);
    expect(container.textContent).toContain("The current Safety Score and live assessment are available on the interactive page.");
    expect(container.textContent).not.toContain("N/A overall grade");
    expect(container.textContent).not.toContain("set by the exit pillar");
    expect(container.textContent).toContain("reviewed by @TokenBrice on May 2, 2026");
    expect(container.textContent).toContain(coin.collateral);
  });


  it("labels NAV tokens by their denominated NAV rather than a fixed peg", () => {
    const navCoin: StablecoinMeta = {
      ...coin,
      id: "test-nav-dollar",
      name: "Test NAV Dollar",
      symbol: "nTSTD",
      flags: { ...coin.flags, yieldBearing: true, navToken: true },
    };

    const { container } = render(<StablecoinDetailSeoContent coin={navCoin} />);
    expect(container.textContent).toContain("peg US Dollar-denominated NAV");
    expect(container.textContent).toContain("yield-bearing token with US Dollar-denominated NAV");
  });

  it("renders one hidden h1 plus a visible static profile with taxonomy links and facts", () => {
    const { container } = render(<StablecoinDetailSeoContent coin={coin} summary={summary} />);

    const headings = container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.className).toContain("sr-only");
    expect(headings[0]?.textContent).toContain("Test Dollar (TSTD) stablecoin analytics");

    expect(screen.getByRole("heading", { name: "TSTD profile facts" })).toBeTruthy();
    expect(
      screen.getByText(/governance model CeFi-Dependent; backing model Real-World Asset Backed; peg US Dollar/),
    ).toBeTruthy();

    expect(screen.getByRole("link", { name: "Browse CeFi-Dependent stablecoins" }).getAttribute("href")).toBe(
      "/stablecoins/governance/cefi-dependent/",
    );
    expect(screen.getByRole("link", { name: "Browse Real-World Asset Backed stablecoins" }).getAttribute("href")).toBe(
      "/stablecoins/backing/rwa/",
    );
    expect(screen.getByRole("link", { name: "Browse US Dollar stablecoins" }).getAttribute("href")).toBe(
      "/stablecoins/usd/",
    );
    expect(screen.getByRole("link", { name: "Browse M0 infrastructure stablecoins" }).getAttribute("href")).toBe(
      "/stablecoins/infrastructure/m0/",
    );

    expect(screen.getByText("Cash, Treasury bills, and overnight repos.")).toBeTruthy();
    expect(screen.getByText("Primary market mint and redeem arbitrage plus secondary market liquidity.")).toBeTruthy();
    expect(screen.getByText("United States / NYDFS / Limited Purpose Trust")).toBeTruthy();
    expect(screen.getByText(/Independent Report by Example Auditor/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reserve source" }).getAttribute("href")).toBe(
      "https://example.com/reserves",
    );
    expect(container.textContent).toContain("3 deployments tracked across Ethereum, Base, and Solana.");
    expect(screen.getByRole("link", { name: "View Ethereum chain profile" }).getAttribute("href")).toBe(
      "/chains/ethereum/",
    );
    expect(screen.getByRole("link", { name: "View Base chain profile" }).getAttribute("href")).toBe(
      "/chains/base/",
    );
    expect(screen.getByRole("link", { name: "View Solana chain profile" }).getAttribute("href")).toBe(
      "/chains/solana/",
    );
    expect(screen.getByText("AI summary / Updated May 2, 2026")).toBeTruthy();
    expect(screen.getByText(/The profile summary uses MMFs and stays specific/)).toBeTruthy();
    expect(container.textContent).not.toContain("{{term:");
    expect(
      screen.getByText(
        "AI summary · drafted by claude-opus-4-7 · reviewed by @TokenBrice on May 2, 2026 · facts as of May 2, 2026",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Is TSTD safe?" })).toBeTruthy();
    expect(
      screen.getByText(/As of Oct 19, 2026, Pharos had not published a Safety Score grade for TSTD/),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("Static metadata says");
    expect(screen.getByRole("link", { name: "Compare TSTD" }).getAttribute("href")).toBe("/compare/#coins=test-dollar");
    expect(screen.getByRole("link", { name: "Telegram alerts" }).getAttribute("href")).toBe(
      "/pharoswatchbot/#getting-started",
    );
    expect(screen.getByRole("link", { name: "Digest RSS" }).getAttribute("href")).toBe("/feed/digest.xml");
    expect(screen.getByRole("link", { name: "API access" }).getAttribute("href")).toBe("/api/");
    expect(screen.getByText("/subscribe dews,depeg,safety test-dollar")).toBeTruthy();
    expect(container.textContent).toContain("Source: Pharos registry profile fields.");
    expect(container.textContent).toContain("the summary above was last updated May 2, 2026");
  });

  it("uses archive h1 wording for frozen stablecoins", () => {
    const frozenCoin: StablecoinMeta = { ...coin, status: "frozen", frozenAt: "2026-05-01" };
    const { container } = render(<StablecoinDetailSeoContent coin={frozenCoin} summary={summary} />);

    expect(container.querySelector("h1")?.textContent).toContain("Test Dollar (TSTD) frozen stablecoin archive");
    expect(screen.getByText(/Test Dollar is a frozen Pharos archive, not a current safety endorsement/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Telegram alerts" })).toBeNull();
    expect(screen.getByText(/This record preserves static and historical context/)).toBeTruthy();
  });

  it("derives the 4-question FAQ from static profile fields and renders FAQPage JSON-LD", () => {
    const items = buildStablecoinFaqItems(coin);

    expect(items.map((item) => item.question)).toEqual([
      "What is Test Dollar (TSTD)?",
      "Is TSTD safe?",
      "What backs TSTD?",
      "Can TSTD be frozen or blacklisted?",
    ]);
    expect(items[0].answer).toContain("Primary market mint and redeem arbitrage");
    // Without a rated snapshot grade the safety answer must stay honest: no
    // grade, no safety call.
    expect(items[1].answer).toContain("Pharos had not published a Safety Score grade for TSTD");
    expect(items[1].answer).toContain("makes no overall safety call");
    expect(items[1].answer).not.toMatch(/\bis safe\b|grades TSTD/);
    expect(items[2].answer).toContain("Real-World Asset Backed");
    expect(items[2].answer).toContain("Cash, Treasury bills, and overnight repos");
    expect(items[2].answer).toContain("Example Auditor");
    expect(items[3].answer).toContain("freeze");

    // Same composition the detail page mounts in both render states.
    const { container } = render(<FaqSection items={items} title="TSTD quick answers" includeJsonLd collapsed />);
    expect(screen.getByText("TSTD quick answers")).toBeTruthy();
    // One counted fold, closed by default, with every answer still in the DOM.
    const fold = screen.getByText("TSTD quick answers").closest("details");
    expect(fold?.open).toBe(false);
    expect(fold?.querySelector("summary")?.textContent).toContain(String(items.length));
    expect(screen.getByText("What backs TSTD?")).toBeTruthy();
    const jsonLdScripts = [...container.querySelectorAll('script[type="application/ld+json"]')];
    const faqJsonLd = jsonLdScripts.find((script) => script.textContent?.includes('"FAQPage"'));
    expect(faqJsonLd).toBeTruthy();
    expect(faqJsonLd!.textContent).toContain("Can TSTD be frozen or blacklisted?");
  });

  it("tiers the safety answer by the snapshot Safety Score grade", () => {
    try {
      mockGetSnapshotSafetyAssessment.mockReturnValue({ grade: "A-", score: 88, bucket: "safe" });
      let answer = buildStablecoinFaqItems(coin)[1].answer;
      expect(answer.startsWith("As of Oct 19, 2026, Pharos grades TSTD A- (88/100) on its Safety Score.")).toBe(true);
      expect(answer).toContain("upper band, which does not rule out losses.");
      // The second sentence is coin-specific: without freeze or redemption
      // evidence it falls back to the backing classification.
      expect(answer).toContain("Pharos classifies its backing as Real-World Asset Backed, with Independent Report from Example Auditor.");
      expect(answer).not.toMatch(/scores-latest|Static metadata/);

      mockGetSnapshotSafetyAssessment.mockReturnValue({ grade: "C+", score: 55, bucket: "neutral" });
      answer = buildStablecoinFaqItems(coin)[1].answer;
      expect(answer).toContain("Pharos grades TSTD C+ (55/100)");
      expect(answer).toContain("middle-band grade");

      mockGetSnapshotSafetyAssessment.mockReturnValue({ grade: "F", score: 12, bucket: "risky" });
      answer = buildStablecoinFaqItems(coin)[1].answer;
      expect(answer).toContain("Pharos grades TSTD F (12/100)");
      expect(answer).toContain("flags significant structural risk");

      mockGetSnapshotSafetyAssessment.mockReturnValue({ grade: "B", score: null, bucket: "safe" });
      answer = buildStablecoinFaqItems(coin)[1].answer;
      expect(answer).toContain("Pharos grades TSTD B on its Safety Score.");

      // Frozen archives never surface a snapshot grade.
      const frozenAnswer = buildStablecoinFaqItems({ ...coin, status: "frozen", frozenAt: "2026-05-01" })[1].answer;
      expect(frozenAnswer).toContain("frozen Pharos archive");
      expect(frozenAnswer).not.toContain("Safety Score grade");
    } finally {
      mockGetSnapshotSafetyAssessment.mockReturnValue(null);
    }
  });

  it.each([
    { grade: "A-", score: 88, bucket: "safe" },
    { grade: "C+", score: 55, bucket: "neutral" },
    { grade: "F", score: 12, bucket: "risky" },
    { grade: "B", score: null, bucket: "safe" },
  ])("dates the $grade FAQ and JSON-LD independently of a changing live grade", (assessment) => {
    mockGetSnapshotSafetyAssessment.mockReturnValue(assessment);
    try {
      const items = buildStablecoinFaqItems(coin);
      const answer = items[1].answer;
      const content = (liveGrade: string) => <>
        <RailSafetySummary items={[{
          key: "safety", label: "Safety", primary: liveGrade, secondary: null,
          href: "#report-card", colorClass: "",
        }]} />
        <FaqSection items={items} includeJsonLd collapsed />
      </>;
      const { container, rerender } = render(content("D"));
      rerender(content("C-"));
      expect(screen.getByRole("link", { name: "C-" })).toBeTruthy();
      expect(screen.getByText(answer).textContent).toContain("As of Oct 19, 2026");
      expect(answer).not.toMatch(/latest published rating|scores-latest/i);
      const jsonLd = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.textContent!);
      expect(jsonLd.mainEntity[1].acceptedAnswer.text).toBe(answer);
      expect(jsonLd.mainEntity[1].acceptedAnswer.text).toContain("As of Oct 19, 2026");
    } finally {
      mockGetSnapshotSafetyAssessment.mockReturnValue(null);
    }
  });

  describe("redemption quick answer", () => {
    const reviewedRoute = {
      routeFamily: "offchain-issuer",
      accessModel: "issuer-api",
      settlementModel: "days",
      executionModel: "offchain-request",
      outputAssetType: "physical-commodity-delivery",
      physicalCommodityDelivery: {
        commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 430,
        deliveryTermsUnbounded: true, feeModel: { bps: 0, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
      },
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "dynamic-or-unclear", feeBpsMin: 12.5, feeBpsMax: 55 },
      holderEligibility: "verified-customer",
      reviewedAt: "2026-09-21",
    };

    afterEach(() => {
      delete mockRedemptionConfigs[coin.id];
      vi.useRealTimers();
    });

    it("answers from a current reviewed route without implying that the reader qualifies", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
      mockRedemptionConfigs[coin.id] = reviewedRoute;
      const items = buildStablecoinFaqItems(coin);
      const redeem = items.find((item) => item.question === "How do you redeem TSTD?");

      expect(redeem?.answer).toBe(
        "Under the route Pharos reviewed on Sep 21, 2026, customers the issuer has verified can redeem TSTD for physical metal, starting at 430 TSTD. " +
        "Settlement takes multiple days. The reviewed redemption fee ranges from 0.125% to 0.55%, before delivery and third-party costs. " +
        "Whether a given holder qualifies is set by the route's own terms, not by this summary.",
      );
      expect(redeem?.answer).not.toMatch(/\byou can\b/i);
      // The same reviewed eligibility becomes the safety answer's coin-specific fact.
      expect(items[1].answer).toContain("direct redemption is limited to customers the issuer has verified");
    });

    it("publishes the authored schedule instead of a bare percentage ceiling", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
      mockRedemptionConfigs[coin.id] = {
        ...reviewedRoute,
        outputAssetType: "stable-single",
        physicalCommodityDelivery: undefined,
        costModel: { kind: "dynamic-or-unclear", feeDescription: "0.10% with a $1,000 minimum", feeBpsMax: 10 },
        v9RouteCostTerms: { minFeeUsd: 1_000 },
        v9RouteReviewTerms: { minRedeemUsd: 100_000 },
      };
      const answer = buildStablecoinFaqItems(coin).find((item) => item.question === "How do you redeem TSTD?")?.answer;

      expect(answer).toContain("The reviewed redemption fee: 0.10% with a $1,000 minimum.");
      expect(answer).not.toContain("at most 0.1%");
    });

    it("does not invent a payout asset the review left unresolved", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
      mockRedemptionConfigs[coin.id] = {
        ...reviewedRoute,
        outputAssetType: "bluechip-collateral",
        outputAssets: undefined,
        physicalCommodityDelivery: undefined,
        unresolvedOutputAssetKeys: ["fiat:USD", "stablecoin:identity-unspecified", "physical:XAU"],
        unresolvedOutputDisposition: "reviewed-external",
      };
      const answer = buildStablecoinFaqItems(coin).find((item) => item.question === "How do you redeem TSTD?")?.answer;

      expect(answer).toContain("can redeem TSTD for an unresolved output asset");
      expect(answer).not.toContain("blue-chip crypto collateral");
    });

    it("omits the answer once the review is older than the reviewed-evidence budget", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2028-01-01T00:00:00Z"));
      mockRedemptionConfigs[coin.id] = reviewedRoute;
      expect(buildStablecoinFaqItems(coin).map((item) => item.question)).not.toContain("How do you redeem TSTD?");
    });

    it("omits the answer for records outside active monitoring", () => {
      mockRedemptionConfigs[coin.id] = { ...reviewedRoute, reviewedAt: new Date().toISOString().slice(0, 10) };
      const frozen = buildStablecoinFaqItems({ ...coin, status: "frozen", frozenAt: "2026-05-01" });
      expect(frozen.map((item) => item.question)).not.toContain("How do you redeem TSTD?");
    });
  });

  it("leads the backing answer with the dated reserve mix and attestor period", () => {
    const backed: StablecoinMeta = {
      ...coin,
      reserves: [
        { name: "Overnight reverse repo", pct: 60.04, risk: "very-low" },
        { name: "Treasury bills", pct: 30, risk: "very-low" },
        { name: "Bank deposits", pct: 7, risk: "low" },
        { name: "Money-market funds", pct: 2.96, risk: "low" },
        { name: "Idle cash", pct: 0, risk: "low" },
      ],
      reserveReview: {
        reviewedAt: "2026-09-30", reviewer: "test", confidence: "verified", sources: [{ label: "R", url: "https://example.com" }],
        rationale: "r", compositionBasis: "b", compositionAsOf: "2026-08-31", scope: "issuer-wide",
        knownUnknownExposure: "none", knownUnknownExposurePct: 0,
      },
      proofOfReserves: { ...coin.proofOfReserves!, latestReport: { periodEnd: "2026-08-31" } },
    } as unknown as StablecoinMeta;

    expect(buildStablecoinFaqItems(backed)[2].answer).toBe(
      "Pharos records TSTD's reserves as of Aug 31, 2026 as 60% Overnight reverse repo, 30% Treasury bills, 7% Bank deposits, and 1 smaller holding. " +
      "Reserve evidence: Independent Report by Example Auditor, latest period ending Aug 31, 2026. " +
      "Pharos classifies the backing as Real-World Asset Backed.",
    );
  });

  it("keeps the provider and reserve-source link when no assurance report exists", () => {
    const noProof = { ...coin, proofOfReserves: undefined };
    const { container } = render(<StablecoinDetailSeoContent coin={noProof} />);
    expect(container.textContent).toContain("No proof-of-reserves entry in the static profile.");
    expect(buildStablecoinFaqItems(noProof)[2].answer).toContain(
      "Reserve evidence: no linked reserve proof in the static profile.",
    );
    expect(buildStablecoinFaqItems(noProof)[2].answer).not.toMatch(/Audit|Examination/);
  });

  it.each([
    ["examination", "Examination"],
    ["audit", "Audit"],
    ["unknown", "Independent Report"],
    [null, "Independent Report"],
  ] as const)("names the reviewed reserve engagement (%s) across visible and FAQ text", (method, label) => {
    const latestReport: NonNullable<NonNullable<StablecoinMeta["proofOfReserves"]>["latestReport"]> | undefined = method
      ? {
          periodEnd: "2026-08-31",
          publishedAt: "2026-09-05",
          assuranceMethod: method,
          scope: "assets-and-liabilities",
          liabilityReconciliation: "full",
          reviewer: "test",
          confidence: "verified",
          sources: [{ label: "Report", url: "https://example.com/report" }],
        }
      : undefined;
    const stated: StablecoinMeta = {
      ...coin,
      proofOfReserves: { ...coin.proofOfReserves!, ...(latestReport ? { latestReport } : {}) },
    };
    const { container } = render(<StablecoinDetailSeoContent coin={stated} />);
    expect(container.textContent).toContain(`${label} by Example Auditor`);
    expect(screen.getByRole("link", { name: "Reserve source" }).getAttribute("href")).toBe(
      "https://example.com/reserves",
    );
    const items = buildStablecoinFaqItems(stated);
    expect(items[2].answer).toContain(`Reserve evidence: ${label} by Example Auditor`);
    if (label === "Independent Report") expect(items[2].answer).not.toContain("Independent Audit");
    // The visible FAQ and its FAQPage answer carry the same corrected label.
    const faq = render(<FaqSection items={items} includeJsonLd collapsed />);
    expect(screen.getByText(items[2].answer)).toBeTruthy();
    const faqJsonLd = faq.container.querySelector('script[type="application/ld+json"]');
    expect(faqJsonLd?.textContent).toContain(items[2].answer);
  });

  it("renders the ISIN fact row only for coins with an authored ISIN", () => {
    const { rerender } = render(<StablecoinDetailSeoContent coin={coin} />);
    expect(screen.queryByText("ISIN")).toBeNull();
    rerender(<StablecoinDetailSeoContent coin={{ ...coin, identifiers: { isin: ["FR0014015LD3"] } }} />);
    expect(screen.getByText("ISIN").nextElementSibling?.textContent).toBe("FR0014015LD3");
  });
});

describe("same-ticker disambiguation", () => {
  it("lists other tracked records sharing the ticker, excluding the coin's own parent", async () => {
    const { SameTickerStablecoins, getSameTickerStablecoins, firstOneLinerClause } = await import(
      "../same-ticker-stablecoins"
    );
    const { TRACKED_STABLECOINS } = await import("@shared/lib/stablecoins/registry");
    const group = TRACKED_STABLECOINS.filter((candidate) => candidate.symbol.toLowerCase() === "usdf");
    expect(group.length).toBeGreaterThan(1);
    const [first, ...rest] = group;

    expect(getSameTickerStablecoins(first!).map((other) => other.id)).toEqual(rest.map((other) => other.id));
    // A synthetic variant of the first record shares its ticker but already
    // links that parent as a variant, so only the unrelated records remain.
    const variant = { ...first!, id: "usdf-variant-fixture", variantOf: first!.id, variantKind: "pure-wrapper" } as StablecoinMeta;
    expect(getSameTickerStablecoins(variant).map((other) => other.id)).toEqual(rest.map((other) => other.id));

    render(<SameTickerStablecoins coin={first!} />);
    expect(screen.getByRole("heading", { name: `Other coins using the ${first!.symbol} ticker` })).toBeTruthy();
    for (const other of rest) {
      expect(screen.getByRole("link", { name: `${other.name} (${other.symbol})` }).getAttribute("href")).toBe(
        `/stablecoin/${other.id}/`,
      );
    }
    expect(firstOneLinerClause("Alpha is a dollar token, backed by bills; redeemable daily.")).toBe("Alpha is a dollar token");
  });

  it("renders nothing for a unique ticker", async () => {
    const { SameTickerStablecoins } = await import("../same-ticker-stablecoins");
    const { container } = render(<SameTickerStablecoins coin={{ ...coin, symbol: "ZZUNIQUEZZ" }} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("variant relationship labels", () => {
  it("names the parent and sibling entities in their existing links", async () => {
    const { TRACKED_META_BY_ID } = await import("@shared/lib/stablecoins/registry");

    // USN and its savings wrapper stay distinct records: the parent link names
    // the full entity and the block adds no duplicate sibling entry for it.
    const usnSavings = TRACKED_META_BY_ID.get("susn-noon")!;
    const usn = render(<StablecoinDetailSeoContent coin={usnSavings} />);
    expect(screen.getAllByRole("link", { name: "View Noon USN (USN) parent asset" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "View Noon USN (USN) parent asset" }).textContent).toBe("Noon USN (USN)");
    expect(usn.container.querySelectorAll('a[href="/stablecoin/usn-noon/"]')).toHaveLength(1);
    usn.unmount();

    // A USDS variant lists the other USDS wrappers by full recorded name.
    const usdsVariant = TRACKED_META_BY_ID.get("stusds-sky")!;
    const usds = render(<StablecoinDetailSeoContent coin={usdsVariant} />);
    expect(screen.getByRole("link", { name: "View Sky Dollar (USDS) parent asset" }).textContent).toBe("Sky Dollar (USDS)");
    expect(screen.getByRole("link", { name: "View related Sky Savings USDS (sUSDS) variant" }).textContent).toBe(
      "Sky Savings USDS (sUSDS)",
    );
    expect(screen.getByRole("link", { name: "View related sky.money USDS Flagship (skyMoneyUsdsFlagship) variant" }).textContent).toBe(
      "sky.money USDS Flagship (skyMoneyUsdsFlagship)",
    );
    const siblingHrefs = screen.getAllByRole("link", { name: /variant$/ }).map((link) => link.getAttribute("href"));
    expect(new Set(siblingHrefs).size).toBe(siblingHrefs.length);
    usds.unmount();
  });
});
