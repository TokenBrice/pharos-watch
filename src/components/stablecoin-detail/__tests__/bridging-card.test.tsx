import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BridgingCard } from "../bridging-card";
import type { BridgeRouteRiskClientSummary } from "@/lib/stablecoin-detail-bridge-client";

const SUMMARY: BridgeRouteRiskClientSummary = {
  tier: "issuer-native-lock-mint",
  tierLabel: "Issuer lock & mint",
  tierToneClass: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  summary: "USDT0 extends the franchise through issuer-controlled lock-and-mint rails.",
  reviewedAt: "2026-07-15",
  confidence: "verified",
  confidenceLabel: "Verified",
  routeCount: 12,
  chainCount: 9,
  canonicalRouteCount: 10,
  thirdPartyRouteCount: 2,
  sources: [{ label: "USDT0 docs", url: "https://example.com/usdt0" }],
};

describe("BridgingCard", () => {
  it("renders tier, facts, summary, and folded sources", () => {
    const html = renderToStaticMarkup(<BridgingCard summary={SUMMARY} />);
    expect(html).toContain("Bridging");
    expect(html).toContain("Issuer lock &amp; mint");
    expect(html).toContain("issuer-controlled lock-and-mint rails");
    expect(html).toContain(">12<");
    expect(html).toContain(">9<");
    expect(html).toContain("Verified");
    expect(html).toContain("Reviewed 2026-07-15");
    expect(html).toContain("https://example.com/usdt0");
    expect(html).toContain('hidden=""'); // sources folded by default
  });

  it("renders nothing without a bridge review", () => {
    expect(renderToStaticMarkup(<BridgingCard summary={null} />)).toBe("");
    expect(renderToStaticMarkup(<BridgingCard />)).toBe("");
  });

  it("keeps short summaries un-collapsed with no Read more control", () => {
    const html = renderToStaticMarkup(<BridgingCard summary={SUMMARY} />);
    expect(html).not.toContain("Read more");
  });

  it("cuts long summaries to a lead behind Read more", () => {
    const longSummary = `${"Native routes are reviewed as issuer-native multichain issuance. ".repeat(12)}TAIL-MARKER`;
    const html = renderToStaticMarkup(<BridgingCard summary={{ ...SUMMARY, summary: longSummary }} />);
    expect(html).toContain("Read more");
    expect(html).toContain("…");
    expect(html).not.toContain("TAIL-MARKER"); // collapsed lead only
  });
});
