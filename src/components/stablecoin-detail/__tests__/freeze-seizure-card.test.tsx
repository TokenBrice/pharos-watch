import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FreezeSeizureCard } from "../freeze-seizure-card";
import type { BlacklistabilityClientSummary } from "@/lib/stablecoin-detail-blacklistability-client";

const SUMMARY: BlacklistabilityClientSummary = {
  status: "freezable",
  statusLabel: "Freezable",
  statusToneClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  statusNote: "A reviewed issuer or protocol control can freeze or seize this token in holders' wallets.",
  evidence: "The canonical implementation exposes owner-only addBlackList and destroyBlackFunds.",
  basisLabel: "Sourced review",
  sourceFreeRationale: null,
  upstreamLabel: null,
  sources: [{ label: "Verified USDT source", url: "https://example.com/usdt" }],
  reviewedAt: "2026-08-08",
};

describe("FreezeSeizureCard", () => {
  it("renders the status chip, note, evidence, facts, and folded sources", () => {
    const html = renderToStaticMarkup(<FreezeSeizureCard summary={SUMMARY} />);
    expect(html).toContain("Freeze &amp; seizure");
    expect(html).toContain("Freezable");
    expect(html).toContain("amber");
    expect(html).toContain("can freeze or seize");
    expect(html).toContain("owner-only addBlackList");
    expect(html).toContain("Sourced review");
    expect(html).toContain("Reviewed 2026-08-08");
    expect(html).toContain("https://example.com/usdt");
    expect(html).toContain('hidden=""'); // sources folded by default
  });

  it("renders nothing without a review", () => {
    expect(renderToStaticMarkup(<FreezeSeizureCard summary={null} />)).toBe("");
    expect(renderToStaticMarkup(<FreezeSeizureCard />)).toBe("");
  });

  it("renders the not-freezable chip in the emerald tone", () => {
    const html = renderToStaticMarkup(
      <FreezeSeizureCard
        summary={{
          ...SUMMARY,
          status: "not-freezable",
          statusLabel: "Not freezable",
          statusToneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
          statusNote: "The reviewed deployments expose no issuer freeze, seizure, or holder blacklist path.",
        }}
      />,
    );
    expect(html).toContain("Not freezable");
    expect(html).toContain("emerald");
    expect(html).toContain("no issuer freeze");
  });

  it("renders the possible chip", () => {
    const html = renderToStaticMarkup(
      <FreezeSeizureCard summary={{ ...SUMMARY, status: "possible", statusLabel: "Possible" }} />,
    );
    expect(html).toContain("Possible");
  });

  it("names the upstream issuer for an inherited review", () => {
    const html = renderToStaticMarkup(
      <FreezeSeizureCard
        summary={{
          ...SUMMARY,
          status: "inherited",
          statusLabel: "Inherited",
          statusToneClass: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
          statusNote: "Freeze power sits upstream with USD Coin rather than in this token's own contract.",
          upstreamLabel: "USD Coin",
        }}
      />,
    );
    expect(html).toContain("Inherited");
    expect(html).toContain("blue");
    expect(html).toContain("Upstream");
    expect(html).toContain("USD Coin");
  });

  it("omits the upstream fact when no parent is resolved", () => {
    const html = renderToStaticMarkup(<FreezeSeizureCard summary={SUMMARY} />);
    expect(html).not.toContain("Upstream");
  });

  it("renders a source-free rationale when the review carries one", () => {
    const html = renderToStaticMarkup(
      <FreezeSeizureCard
        summary={{
          ...SUMMARY,
          basisLabel: "Rationale only",
          sourceFreeRationale: "Resolved from Pharos stablecoin metadata.",
          sources: [],
        }}
      />,
    );
    expect(html).toContain("Rationale only");
    expect(html).toContain("Resolved from Pharos stablecoin metadata.");
    expect(html).not.toContain("Sources");
  });

  it("cuts long evidence to a lead behind Read more", () => {
    const longEvidence = `${"The verified implementation exposes no holder blacklist or freeze path. ".repeat(12)}TAIL-MARKER`;
    const html = renderToStaticMarkup(<FreezeSeizureCard summary={{ ...SUMMARY, evidence: longEvidence }} />);
    expect(html).toContain("Read more");
    expect(html).not.toContain("TAIL-MARKER");
  });

  it("omits the reviewed stamp when the review carries no date", () => {
    const html = renderToStaticMarkup(<FreezeSeizureCard summary={{ ...SUMMARY, reviewedAt: null }} />);
    expect(html).not.toContain("Reviewed 2026");
  });
});
