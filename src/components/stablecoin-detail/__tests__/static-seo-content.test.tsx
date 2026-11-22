// @vitest-environment jsdom
import { RailSafetySummary } from "../rail-safety-summary";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinAiSummary } from "@shared/types/editorial";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import * as blacklistStatus from "@shared/lib/blacklist-status";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { projectBlacklistabilityClientSummary } from "@/lib/stablecoin-detail-blacklistability-client";
import { STABLECOIN_HISTORICAL_CONTEXT } from "@/lib/stablecoin-detail-historical-context";

vi.mock("next/link", async () => (await import("@/test-utils/frontend")).createNextLinkMock());
const mockGetSnapshotSafetyAssessment = vi.hoisted(() => vi.fn<(id: string) => { grade: string; score: number | null; bucket: string } | null>(() => null));
vi.mock("@/lib/safety-grade-snapshot", () => ({ getSnapshotSafetyAssessment: mockGetSnapshotSafetyAssessment }));
vi.mock("@/lib/datasets/public-dataset-current", () => ({ PUBLIC_DATASET_CURRENT_DATE: "2026-10-19" }));
const mockRedemptionConfigs = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@shared/lib/redemption-backstop-configs", () => ({ REDEMPTION_BACKSTOP_CONFIGS: mockRedemptionConfigs }));

const { StablecoinDetailSeoContent, buildStablecoinFaqItems } = await import("../static-seo-content");
const { FaqSection } = await import("@/components/faq-section");

const coin: StablecoinMeta = {
  id: "test-dollar", name: "Test Dollar", symbol: "TSTD",
  flags: { governance: "centralized-dependent", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false },
  collateral: "Cash, Treasury bills, and overnight repos.",
  pegMechanism: "Primary market mint and redeem arbitrage plus secondary market liquidity.",
  jurisdiction: { country: "United States", regulator: "NYDFS", license: "Limited Purpose Trust" },
  proofOfReserves: { type: "independent-audit", provider: "Example Auditor", url: "https://example.com/reserves" },
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
  updatedAt: "2026-05-02", authoredBy: "ai", model: "claude-opus-4-7",
  reviewedBy: "@TokenBrice", reviewedAt: "2026-05-02", factsAsOf: "2026-05-02",
};

function renderFaqJsonLd(items: ReturnType<typeof buildStablecoinFaqItems>, title?: string) {
  const view = render(<FaqSection items={items} title={title} includeJsonLd collapsed />);
  const script = view.container.querySelector('script[type="application/ld+json"]');
  return { ...view, jsonLd: script ? JSON.parse(script.textContent!) : null, script };
}

describe("StablecoinDetailSeoContent", () => {
  it.each([
    ["stusd-stoneyield", /USDC strategy positions/, "identified holdings"],
    ["msusd-metronome", /Metronome Synth eligible CDP collateral basket/, "msUSD's reserve review findings"],
  ])("describes %s without an allocation in the FAQ and JSON-LD", (id, pattern, subject) => {
    const { jsonLd } = renderFaqJsonLd(buildStablecoinFaqItems(TRACKED_META_BY_ID.get(id)!));
    const answer = screen.getByText(pattern).textContent;
    expect(answer).toContain(subject);
    expect(answer).not.toContain("%");
    if (id === "msusd-metronome") expect(answer).toContain("Reserve evidence: reviewed collateral eligibility with no verified msUSD allocation.");
    expect(jsonLd.mainEntity[2].acceptedAnswer.text).toBe(answer);
  });

  it("qualifies the USDU denominator and unresolved allocations in FAQ JSON-LD", () => {
    const { jsonLd, unmount } = renderFaqJsonLd(buildStablecoinFaqItems(TRACKED_META_BY_ID.get("usdu-usdu-finance")!));
    const answer = screen.getByText(/60\.6% Self-referential claim \(Morpho USDU Core vault shares\)/).textContent;
    expect(answer).toContain("shares of USDU's scoped reserve report as of Oct 27, 2026");
    expect(answer).toMatch(/31\.6% Self-referential claim \(USDU constituent.*7\.8% USDC constituent/);
    expect(jsonLd.mainEntity[2].acceptedAnswer.text).toBe(answer);
    unmount();

    for (const id of ["pht-pht", "mai-qidao"]) {
      const { jsonLd: unresolved, unmount: u } = renderFaqJsonLd(buildStablecoinFaqItems(TRACKED_META_BY_ID.get(id)!));
      expect(unresolved.mainEntity[2].acceptedAnswer.text).toContain("Reserve evidence: a reserve review with unresolved allocation.");
      u();
    }
  });

  it.each([
    ["alusd-alchemix", /scoped reserve report.*37\.3% InfiniFi siUSD position/],
    ["lisusd-lista", /scoped reserve report.*98% slisBNB/],
    ["nusd-nexus", /nominal pool balances for NUSD.*56\.7% USDT in the Ethereum Synapse nexus pool/],
    ["satusd-river", /gross product deposits for satUSD.*62\.5% Prime Vault custodial BTC collateral/],
    ["xo-exodus", /measured holdings in scope.*100% M0 M held in the XO extension vault/],
    ["avusd-avant", /avUSD's reserve review findings.*Unresolved whole-token reserve composition/],
    ["dusd-alto", /DUSD's reviewed nominal issuance paths.*83\.5% frxUSD.*16\.3% WETH.*0\.2% Syrup USDC.*under 0\.1% sUSDe/],
    ["usd0-usual", /82\.4% Self-referential claim \(U0R bUSD0 Zero Rate Vault\)/],
  ])("describes the reviewed backing evidence for %s", (id, expected) => {
    render(<FaqSection items={buildStablecoinFaqItems(TRACKED_META_BY_ID.get(id)!)} collapsed />);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("keeps historical editorial answers and references in the profile and FAQ JSON-LD", () => {
    const usdc = { ...coin, id: "usdc-circle", name: "USD Coin", symbol: "USDC" };
    const context = STABLECOIN_HISTORICAL_CONTEXT[usdc.id]!;
    const items = buildStablecoinFaqItems(usdc);
    expect(items.at(-1)).toEqual({ question: "Has USDC depegged?", answer: context.faq.answer });
    const html = renderToString(<StablecoinDetailSeoContent coin={usdc} />);
    expect(html).toContain(context.faq.answer);
    expect(html).toContain('href="/depeg/usdc-2023-03-11/"');
    expect(html).toContain('href="/learn/case-studies/usdc-svb-2023/"');
    const faqHtml = renderToString(<FaqSection items={items} includeJsonLd collapsed />);
    const jsonLd = JSON.parse(faqHtml.match(/<script[^>]*>(.*?)<\/script>/)![1]);
    expect(jsonLd.mainEntity.at(-1)).toEqual({ "@type": "Question", name: context.faq.question, acceptedAnswer: { "@type": "Answer", text: context.faq.answer } });
    expect(renderToString(<StablecoinDetailSeoContent coin={usdc} afterDossier />)).not.toContain(context.profileHeading);
    expect(buildStablecoinFaqItems(coin).some((i) => i.question === context.faq.question)).toBe(false);
    expect(renderToString(<StablecoinDetailSeoContent coin={coin} />)).not.toContain(context.profileHeading);
  });

  it("scopes Possible freeze controls, withholds assertive live-claim prose, and labels NAV denomination", () => {
    const status = vi.spyOn(blacklistStatus, "getResolvedBlacklistStatus").mockReturnValue("possible");
    const reviewed = { ...coin, blacklistabilityReview: { reviewedStatus: "possible" as const, evidence: "Reviewed controls", reviewer: "test", reviewedAt: "2026-10-19" } };
    try {
      const items = buildStablecoinFaqItems(reviewed);
      expect(items[1].answer).toContain("on its material deployments");
      expect(items[3].answer).toContain("on material deployments");
      expect(projectBlacklistabilityClientSummary(reviewed)?.statusNote).toContain("on its material deployments");
    } finally { status.mockRestore(); }

    const { container, unmount } = render(<StablecoinDetailSeoContent coin={coin} summary={{
      ...summary, text: "The {{grade}} overall grade is set by the exit pillar.",
      claimTokens: [{ token: "grade", placeholder: "{{grade}}", source: "report-card.grade", factsAsOf: "2026-05-02" }],
    }} />);
    expect(container.textContent).toContain("The current Safety Score and live assessment are available on the interactive page.");
    expect(container.textContent).not.toMatch(/N\/A overall grade|set by the exit pillar/);
    expect(container.textContent).toContain("reviewed by @TokenBrice on May 2, 2026");
    expect(container.textContent).toContain(coin.collateral);
    unmount();

    const nav = render(<StablecoinDetailSeoContent coin={{ ...coin, id: "test-nav-dollar", name: "Test NAV Dollar", symbol: "nTSTD", flags: { ...coin.flags, yieldBearing: true, navToken: true } }} />);
    expect(screen.getByText("Denomination").nextElementSibling?.textContent).toBe("US Dollar-denominated NAV");
    expect(nav.container.textContent).toContain("yield-bearing token with US Dollar-denominated NAV");
  });

  it("renders one hidden h1 plus a visible static profile with taxonomy links, facts, and frozen archive variant", () => {
    const { container, unmount } = render(<StablecoinDetailSeoContent coin={coin} summary={summary} />);
    const headings = container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toContain("Test Dollar (TSTD) stablecoin analytics");
    expect(screen.getByRole("heading", { name: "About TSTD" })).toBeTruthy();
    expect(screen.getByText("Governance").nextElementSibling?.textContent).toBe("CeFi-Dependent");
    expect(screen.getByText("Backing").nextElementSibling?.textContent).toBe("Real-World Asset Backed");
    expect(screen.getByText("Peg").nextElementSibling?.textContent).toBe("US Dollar");
    expect(container.textContent).not.toMatch(/static profile|registry profile fields|Static metadata says|\{\{term:/);

    for (const [name, href] of [
      ["Browse CeFi-Dependent stablecoins", "/stablecoins/governance/cefi-dependent/"],
      ["Browse Real-World Asset Backed stablecoins", "/stablecoins/backing/rwa/"],
      ["Browse US Dollar stablecoins", "/stablecoins/usd/"],
      ["Browse M0 infrastructure stablecoins", "/stablecoins/infrastructure/m0/"],
      ["Reserve source", "https://example.com/reserves"],
      ["View Ethereum chain profile", "/chains/ethereum/"],
      ["View Base chain profile", "/chains/base/"],
      ["View Solana chain profile", "/chains/solana/"],
      ["Compare TSTD", "/compare/#coins=test-dollar"],
      ["Telegram alerts", "/pharoswatchbot/#getting-started"],
      ["Digest RSS", "/feed/digest.xml"],
      ["API access", "/api/"],
    ]) expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(href);

    for (const text of [
      "Cash, Treasury bills, and overnight repos.",
      "Primary market mint and redeem arbitrage plus secondary market liquidity.",
      "United States / NYDFS / Limited Purpose Trust",
      "3 deployments tracked across Ethereum, Base, and Solana.",
      "AI summary / Updated May 2, 2026",
      "The profile summary uses MMFs and stays specific",
      "AI summary · drafted by claude-opus-4-7 · reviewed by @TokenBrice on May 2, 2026 · facts as of May 2, 2026",
      "As of Oct 19, 2026, Pharos had not published a Safety Score grade for TSTD",
      "/subscribe dews,depeg,safety test-dollar",
      "From Pharos's reviewed coin profile.",
      "the summary above was last updated May 2, 2026",
    ]) expect(container.textContent).toContain(text);
    expect(screen.getByText(/Independent Report by Example Auditor/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Is TSTD safe?" })).toBeTruthy();
    unmount();

    const frozen = render(<StablecoinDetailSeoContent coin={{ ...coin, status: "frozen", frozenAt: "2026-05-01" }} summary={summary} />);
    expect(frozen.container.querySelector("h1")?.textContent).toContain("Test Dollar (TSTD) frozen stablecoin archive");
    expect(screen.getByText(/Test Dollar is a frozen Pharos archive, not a current safety endorsement/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Telegram alerts" })).toBeNull();
    expect(screen.getByText(/This record preserves static and historical context/)).toBeTruthy();
  });

  it("derives the 4-question FAQ from static profile fields and renders FAQPage JSON-LD", () => {
    const items = buildStablecoinFaqItems(coin);
    expect(items.map((i) => i.question)).toEqual(["What is Test Dollar (TSTD)?", "Is TSTD safe?", "What backs TSTD?", "Can TSTD be frozen or blacklisted?"]);
    expect(items[0].answer).toContain("Primary market mint and redeem arbitrage");
    expect(items[1].answer).toContain("Pharos had not published a Safety Score grade for TSTD");
    expect(items[1].answer).toContain("makes no overall safety call");
    expect(items[1].answer).not.toMatch(/\bis safe\b|grades TSTD/);
    expect(items[2].answer).toContain("Real-World Asset Backed");
    expect(items[2].answer).toContain("Cash, Treasury bills, and overnight repos");
    expect(items[2].answer).toContain("Example Auditor");
    expect(items[3].answer).toContain("freeze");

    const { script } = renderFaqJsonLd(items, "TSTD quick answers");
    const fold = screen.getByText("TSTD quick answers").closest("details");
    expect(fold?.open).toBe(false);
    expect(fold?.querySelector("summary")?.textContent).toContain(String(items.length));
    expect(script?.textContent).toContain('"FAQPage"');
    expect(script?.textContent).toContain("Can TSTD be frozen or blacklisted?");
  });

  it.each([
    { grade: "A-", score: 88, bucket: "safe", lead: "As of Oct 19, 2026, Pharos grades TSTD A- (88/100) on its Safety Score.", band: "upper band, which does not rule out losses." },
    { grade: "C+", score: 55, bucket: "neutral", lead: "Pharos grades TSTD C+ (55/100)", band: "middle-band grade" },
    { grade: "F", score: 12, bucket: "risky", lead: "Pharos grades TSTD F (12/100)", band: "flags significant structural risk" },
    { grade: "B", score: null, bucket: "safe", lead: "Pharos grades TSTD B on its Safety Score.", band: null },
  ])("tiers and dates the $grade FAQ and JSON-LD independently of a changing live grade", ({ grade, score, bucket, lead, band }) => {
    mockGetSnapshotSafetyAssessment.mockReturnValue({ grade, score, bucket });
    try {
      const items = buildStablecoinFaqItems(coin);
      const answer = items[1].answer;
      expect(answer).toContain(lead);
      if (band) expect(answer).toContain(band);
      if (grade === "A-") expect(answer).toContain("Pharos classifies its backing as Real-World Asset Backed, with Independent Report from Example Auditor.");
      expect(answer).not.toMatch(/latest published rating|scores-latest|Static metadata/i);

      const content = (liveGrade: string) => <>
        <RailSafetySummary items={[{ key: "safety", label: "Safety", primary: liveGrade, secondary: null, href: "#report-card", colorClass: "" }]} />
        <FaqSection items={items} includeJsonLd collapsed />
      </>;
      const { container, rerender } = render(content("D"));
      rerender(content("C-"));
      expect(screen.getByRole("link", { name: "C-" })).toBeTruthy();
      expect(screen.getByText(answer).textContent).toContain("As of Oct 19, 2026");
      const jsonLd = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.textContent!);
      expect(jsonLd.mainEntity[1].acceptedAnswer.text).toBe(answer);
      const frozenAnswer = buildStablecoinFaqItems({ ...coin, status: "frozen", frozenAt: "2026-05-01" })[1].answer;
      expect(frozenAnswer).toContain("frozen Pharos archive");
      expect(frozenAnswer).not.toContain("Safety Score grade");
    } finally { mockGetSnapshotSafetyAssessment.mockReturnValue(null); }
  });

  describe("redemption quick answer", () => {
    const reviewedRoute = {
      routeFamily: "offchain-issuer", accessModel: "issuer-api", settlementModel: "days", executionModel: "offchain-request",
      outputAssetType: "physical-commodity-delivery",
      physicalCommodityDelivery: { commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 430, deliveryTermsUnbounded: true, feeModel: { bps: 0, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false },
      capacityModel: { kind: "supply-full" }, costModel: { kind: "dynamic-or-unclear", feeBpsMin: 12.5, feeBpsMax: 55 },
      holderEligibility: "verified-customer", reviewedAt: "2026-09-21",
    };

    function getRedeemAnswer(route: Record<string, unknown>, now = "2026-10-25T00:00:00Z", target = coin) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      mockRedemptionConfigs[target.id] = route;
      const items = buildStablecoinFaqItems(target);
      return { items, answer: items.find((i) => i.question === "How do you redeem TSTD?")?.answer };
    }

    afterEach(() => { delete mockRedemptionConfigs[coin.id]; vi.useRealTimers(); });

    it("answers from a current reviewed route without implying that the reader qualifies", () => {
      const { items, answer } = getRedeemAnswer(reviewedRoute);
      expect(answer).toBe(
        "Under the route Pharos reviewed on Sep 21, 2026, customers the issuer has verified can redeem TSTD for physical metal, starting at 430 TSTD. " +
        "Settlement takes multiple days. The reviewed redemption fee ranges from 0.125% to 0.55%, before delivery and third-party costs. " +
        "Whether a given holder qualifies is set by the route's own terms, not by this summary.",
      );
      expect(answer).not.toMatch(/\byou can\b/i);
      expect(items[1].answer).toContain("direct redemption is limited to customers the issuer has verified");
    });

    it("withholds internal fee notes, unresolved non-fiat payouts, expired reviews, and frozen records", () => {
      expect(getRedeemAnswer({ ...reviewedRoute, outputAssetType: "stable-single", physicalCommodityDelivery: undefined, costModel: { kind: "dynamic-or-unclear", feeDescription: "Internal reviewer note: 0.10% with a $1,000 minimum", feeBpsMax: 10 }, v9RouteCostTerms: { minFeeUsd: 1_000 }, v9RouteReviewTerms: { minRedeemUsd: 100_000 } }).answer).not.toContain("Internal reviewer note");

      const unresolved = getRedeemAnswer({ ...reviewedRoute, outputAssetType: "bluechip-collateral", outputAssets: undefined, physicalCommodityDelivery: undefined, unresolvedOutputAssetKeys: ["fiat:USD", "stablecoin:identity-unspecified", "physical:XAU"], unresolvedOutputDisposition: "reviewed-external" }).answer;
      expect(unresolved).toContain("can redeem TSTD for an unresolved output asset");
      expect(unresolved).not.toContain("blue-chip crypto collateral");

      expect(getRedeemAnswer({ ...reviewedRoute, outputAssetType: "stable-single", outputAssets: undefined, physicalCommodityDelivery: undefined, unresolvedOutputAssetKeys: ["fiat:MXN"], unresolvedOutputDisposition: "reviewed-external" }).answer).not.toContain("unresolved output asset");
      expect(getRedeemAnswer(reviewedRoute, "2028-01-01T00:00:00Z").answer).toBeUndefined();
      expect(getRedeemAnswer({ ...reviewedRoute, reviewedAt: "2026-10-25" }, "2026-10-25T00:00:00Z", { ...coin, status: "frozen", frozenAt: "2026-05-01" }).answer).toBeUndefined();
    });
  });

  it("leads backing answer with dated reserve mix, handles absent/live proof, and folds after-dossier/sparse/ISIN rows", () => {
    const backed = {
      ...coin,
      reserves: [{ name: "Overnight reverse repo", pct: 60.04, risk: "very-low" }, { name: "Treasury bills", pct: 30, risk: "very-low" }, { name: "Bank deposits", pct: 7, risk: "low" }, { name: "Money-market funds", pct: 2.96, risk: "low" }, { name: "Idle cash", pct: 0, risk: "low" }],
      reserveReview: { reviewedAt: "2026-09-30", reviewer: "test", confidence: "verified", sources: [{ label: "R", url: "https://example.com" }], rationale: "r", compositionBasis: "b", compositionAsOf: "2026-08-31", scope: "issuer-wide", knownUnknownExposure: "none", knownUnknownExposurePct: 0 },
      proofOfReserves: { ...coin.proofOfReserves!, latestReport: { periodEnd: "2026-08-31" } },
    } as unknown as StablecoinMeta;
    expect(buildStablecoinFaqItems(backed)[2].answer).toBe(
      "Pharos records TSTD's reserves as of Aug 31, 2026 as 60% Overnight reverse repo, 30% Treasury bills, 7% Bank deposits, and 1 smaller holding. " +
      "Reserve evidence: Independent Report by Example Auditor, latest period ending Aug 31, 2026. Pharos classifies the backing as Real-World Asset Backed.",
    );

    const noProof = { ...coin, proofOfReserves: undefined };
    const { container, rerender } = render(<StablecoinDetailSeoContent coin={noProof} />);
    expect(container.textContent).toContain("No proof-of-reserves report listed.");
    expect(buildStablecoinFaqItems(noProof)[2].answer).toContain("Reserve evidence: no proof-of-reserves report listed.");
    expect(buildStablecoinFaqItems(noProof)[2].answer).not.toMatch(/Audit|Examination/);

    const live = { ...coin, proofOfReserves: undefined, liveReservesConfig: {} } as unknown as StablecoinMeta;
    rerender(<StablecoinDetailSeoContent coin={live} includeHeading={false} afterDossier />);
    expect(container.textContent).not.toContain("No proof-of-reserves report listed");
    expect(container.textContent).toContain("Pharos tracks a live reserve feed in Reserves.");
    expect(screen.getByRole("link", { name: "Reserves" }).getAttribute("href")).toBe("#reserves");
    expect(buildStablecoinFaqItems(live)[2].answer).toContain("Reserve evidence: a live reserve feed.");

    rerender(<StablecoinDetailSeoContent coin={coin} includeHeading={false} afterDossier />);
    const fold = container.querySelector("details");
    expect(fold?.open).toBe(false);
    expect(fold?.querySelector("summary #stablecoin-static-profile-title")?.textContent).toBe("About TSTD");
    expect(fold?.textContent).toContain("Cash, Treasury bills, and overnight repos.");
    expect(fold?.textContent).toContain("in the dossier above");
    expect(screen.queryByText(/Next actions|Answer first/)).toBeNull();

    rerender(<StablecoinDetailSeoContent coin={{ ...coin, collateral: undefined, pegMechanism: undefined, jurisdiction: undefined, contracts: [] }} />);
    for (const label of ["Collateral", "Peg mechanism", "Jurisdiction", "Contracts", "ISIN"]) expect(screen.queryByText(label)).toBeNull();
    expect(container.textContent).not.toMatch(/not (specified|disclosed)|No contract deployments/);

    rerender(<StablecoinDetailSeoContent coin={{ ...coin, identifiers: { isin: ["FR0014015LD3"] } }} />);
    expect(screen.getByText("ISIN").nextElementSibling?.textContent).toBe("FR0014015LD3");
  });

  it.each([["examination", "Examination"], ["audit", "Audit"], ["unknown", "Independent Report"], [null, "Independent Report"]] as const)(
    "names the reviewed reserve engagement (%s) across visible and FAQ text",
    (method, label) => {
      const latestReport = method ? { periodEnd: "2026-08-31", publishedAt: "2026-09-05", assuranceMethod: method, scope: "assets-and-liabilities" as const, liabilityReconciliation: "full" as const, reviewer: "test", confidence: "verified" as const, sources: [{ label: "Report", url: "https://example.com/report" }] } : undefined;
      const stated: StablecoinMeta = { ...coin, proofOfReserves: { ...coin.proofOfReserves!, ...(latestReport ? { latestReport } : {}) } };
      const { container } = render(<StablecoinDetailSeoContent coin={stated} />);
      expect(container.textContent).toContain(`${label} by Example Auditor`);
      expect(screen.getByRole("link", { name: "Reserve source" }).getAttribute("href")).toBe("https://example.com/reserves");
      const items = buildStablecoinFaqItems(stated);
      expect(items[2].answer).toContain(`Reserve evidence: ${label} by Example Auditor`);
      if (label === "Independent Report") expect(items[2].answer).not.toContain("Independent Audit");
      const faq = renderFaqJsonLd(items);
      expect(screen.getByText(items[2].answer)).toBeTruthy();
      expect(faq.script?.textContent).toContain(items[2].answer);
    },
  );
});

describe("same-ticker disambiguation and variant relationships", () => {
  it("lists other tracked records sharing the ticker and renders nothing for a unique ticker", async () => {
    const { SameTickerStablecoins, getSameTickerStablecoins, firstOneLinerClause } = await import("../same-ticker-stablecoins");
    const { TRACKED_STABLECOINS } = await import("@shared/lib/stablecoins/registry");
    const [first, ...rest] = TRACKED_STABLECOINS.filter((c) => c.symbol.toLowerCase() === "usdf");
    expect(rest.length).toBeGreaterThan(0);
    expect(getSameTickerStablecoins(first!).map((o) => o.id)).toEqual(rest.map((o) => o.id));
    expect(getSameTickerStablecoins({ ...first!, id: "usdf-variant-fixture", variantOf: first!.id, variantKind: "pure-wrapper" } as StablecoinMeta).map((o) => o.id)).toEqual(rest.map((o) => o.id));

    const { unmount } = render(<SameTickerStablecoins coin={first!} />);
    expect(screen.getByRole("heading", { name: `Other coins using the ${first!.symbol} ticker` })).toBeTruthy();
    for (const other of rest) expect(screen.getByRole("link", { name: `${other.name} (${other.symbol})` }).getAttribute("href")).toBe(`/stablecoin/${other.id}/`);
    expect(firstOneLinerClause("Alpha is a dollar token, backed by bills; redeemable daily.")).toBe("Alpha is a dollar token");
    unmount();

    expect(render(<SameTickerStablecoins coin={{ ...coin, symbol: "ZZUNIQUEZZ" }} />).container.innerHTML).toBe("");
  });

  it("names parent and sibling entities and renders active-peer off-ramp links on quarantined profiles", async () => {
    const { getDisplayedVariantSiblings } = await import("../same-ticker-stablecoins");
    const usnSavings = TRACKED_META_BY_ID.get("susn-noon")!;
    const usnParent = TRACKED_META_BY_ID.get(usnSavings.variantOf!)!;
    const usn = render(<StablecoinDetailSeoContent coin={usnSavings} />);
    expect(screen.getByRole("link", { name: `View ${usnParent.name} (${usnParent.symbol}) parent asset` }).textContent).toBe(`${usnParent.name} (${usnParent.symbol})`);
    expect(usn.container.querySelectorAll(`a[href="/stablecoin/${usnParent.id}/"]`)).toHaveLength(1);
    usn.unmount();

    const usdsVariant = TRACKED_META_BY_ID.get("stusds-sky")!;
    const usdsParent = TRACKED_META_BY_ID.get(usdsVariant.variantOf!)!;
    const siblings = getDisplayedVariantSiblings(usdsVariant);
    expect(siblings.length).toBeGreaterThan(0);
    const usds = render(<StablecoinDetailSeoContent coin={usdsVariant} />);
    expect(screen.getByRole("link", { name: `View ${usdsParent.name} (${usdsParent.symbol}) parent asset` }).textContent).toBe(`${usdsParent.name} (${usdsParent.symbol})`);
    for (const sibling of siblings) {
      const link = screen.getByRole("link", { name: `View related ${sibling.name} (${sibling.symbol}) variant` });
      expect([link.textContent, link.getAttribute("href")]).toEqual([`${sibling.name} (${sibling.symbol})`, `/stablecoin/${sibling.id}/`]);
    }
    const siblingHrefs = screen.getAllByRole("link", { name: /variant$/ }).map((l) => l.getAttribute("href"));
    expect(new Set(siblingHrefs).size).toBe(siblingHrefs.length);
    usds.unmount();

    const quarantined: StablecoinMeta = { ...coin, status: "quarantined", listingStatusReview: { changedAt: "2026-11-15", reason: "Price and supply feeds temporarily suspended pending review." } };
    const { container } = render(<StablecoinDetailSeoContent coin={quarantined} activePeers={[{ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }, { id: "usdt-tether", symbol: "USDT", name: "Tether" }]} />);
    expect(container.textContent).toContain("Active peers");
    expect(screen.getByRole("link", { name: /USDC/i }).getAttribute("href")).toBe("/stablecoin/usdc-circle/");
    expect(screen.getByRole("link", { name: /USDT/i }).getAttribute("href")).toBe("/stablecoin/usdt-tether/");
    expect(screen.getByRole("link", { name: /Browse active peers/i }).getAttribute("href")).toBe("/stablecoins/usd/");
  });
});
