// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  sources: [
    { label: "Product documentation", url: "https://example.com/docs" },
    { label: "Reserve API", url: "https://example.com/api/reserves" },
  ],
};

describe("StablecoinDetailSeoContent", () => {

  it("renders one hidden h1 plus a visible static profile with taxonomy links and facts", () => {
    const { container } = render(<StablecoinDetailSeoContent coin={coin} summary={summary} />);

    const headings = container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.className).toContain("sr-only");
    expect(headings[0]?.textContent).toContain("Test Dollar (TSTD) stablecoin analytics");

    expect(screen.getByRole("heading", { name: "Static stablecoin profile" })).toBeTruthy();
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
    expect(screen.getByText(/Independent Audit by Example Auditor/)).toBeTruthy();
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
    expect(screen.getByRole("link", { name: "Product documentation" }).getAttribute("href")).toBe(
      "https://example.com/docs",
    );
    expect(screen.getByRole("link", { name: "Reserve API" }).getAttribute("href")).toBe(
      "https://example.com/api/reserves",
    );
    expect(
      screen.getByText(
        "AI summary · drafted by claude-opus-4-7 · reviewed by @TokenBrice on May 2, 2026 · facts as of May 2, 2026",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Is TSTD safe?" })).toBeTruthy();
    expect(screen.getByText(/Pharos does not mark TSTD as absolutely safe/)).toBeTruthy();
    expect(
      screen.getByText(/Treat the live peg, liquidity, reserve, dependency, and Safety Score sections below/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Compare TSTD" }).getAttribute("href")).toBe("/compare/?coins=test-dollar");
    expect(screen.getByRole("link", { name: "Telegram alerts" }).getAttribute("href")).toBe(
      "/pharoswatchbot/#getting-started",
    );
    expect(screen.getByRole("link", { name: "Digest RSS" }).getAttribute("href")).toBe("/feed/digest.xml");
    expect(screen.getByRole("link", { name: "API access" }).getAttribute("href")).toBe("/api/");
    expect(screen.getByText("/subscribe dews,depeg,safety test-dollar")).toBeTruthy();
    expect(container.textContent).toContain("Source: checked-in StablecoinMeta profile fields.");
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

  it("renders crawlable parent and sibling links for tracked variants", () => {
    const variantCoin: StablecoinMeta = {
      ...coin,
      id: "test-savings-dollar",
      name: "Test Savings Dollar",
      symbol: "sTSTD",
      variantOf: "usds-sky",
      variantKind: "savings-passthrough",
    };

    const { container } = render(<StablecoinDetailSeoContent coin={variantCoin} />);

    expect(screen.getByText("Variant Relationship")).toBeTruthy();
    expect(container.textContent).toContain("modeled as a savings variant of");
    expect(container.textContent).toContain(
      "Pharos treats parent stress, redemption, mint authority, and dependency context as relevant",
    );
    expect(
      screen.getByRole("link", {
        name: "View Sky Dollar (USDS) parent asset",
      }).getAttribute("href"),
    ).toBe("/stablecoin/usds-sky/");
    expect(screen.getAllByText("Savings variant").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /View related .* variant/ })).toHaveLength(2);
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
    // Without a rated snapshot grade the safety answer must stay honest — no
    // absolute-safety claims.
    expect(items[1].answer).toContain("Pharos does not mark TSTD as absolutely safe");
    expect(items[2].answer).toContain("Real-World Asset Backed");
    expect(items[2].answer).toContain("Cash, Treasury bills, and overnight repos");
    expect(items[2].answer).toContain("Example Auditor");
    expect(items[3].answer).toContain("freeze");

    // Same composition the detail page mounts in both render states.
    const { container } = render(<FaqSection items={items} title="TSTD quick answers" includeJsonLd />);
    expect(screen.getByText("TSTD quick answers")).toBeTruthy();
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
      expect(answer).toContain("TSTD holds an A- Safety Score grade (88/100)");
      expect(answer).toContain("overall safe, though no stablecoin is entirely risk-free");
      expect(answer).toContain("CeFi-Dependent governance model");
      expect(answer).toContain("Treat the live peg, liquidity, reserve, dependency, and Safety Score sections below");

      mockGetSnapshotSafetyAssessment.mockReturnValue({ grade: "C+", score: 55, bucket: "neutral" });
      answer = buildStablecoinFaqItems(coin)[1].answer;
      expect(answer).toContain("TSTD holds a C+ Safety Score grade (55/100)");
      expect(answer).toContain("does not consider it clearly safe");

      mockGetSnapshotSafetyAssessment.mockReturnValue({ grade: "F", score: 12, bucket: "risky" });
      answer = buildStablecoinFaqItems(coin)[1].answer;
      expect(answer).toContain("Pharos does not assess TSTD as safe");
      expect(answer).toContain("an F Safety Score grade (12/100)");

      mockGetSnapshotSafetyAssessment.mockReturnValue({ grade: "B", score: null, bucket: "safe" });
      answer = buildStablecoinFaqItems(coin)[1].answer;
      expect(answer).toContain("TSTD holds a B Safety Score grade in Pharos's latest published rating");

      // Frozen archives never surface a snapshot grade.
      const frozenAnswer = buildStablecoinFaqItems({ ...coin, status: "frozen", frozenAt: "2026-05-01" })[1].answer;
      expect(frozenAnswer).toContain("frozen Pharos archive");
      expect(frozenAnswer).not.toContain("Safety Score grade");
    } finally {
      mockGetSnapshotSafetyAssessment.mockReturnValue(null);
    }
  });
});
