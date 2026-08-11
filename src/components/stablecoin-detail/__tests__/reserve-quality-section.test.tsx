import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReserveQualitySection } from "../reserve-quality-section";
import type { ReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";

const AMBER_VALUE_CLASS = "text-amber-600 dark:text-amber-400";

const SUMMARY: ReserveQualityClientSummary = {
  chipLabel: "Highly liquid",
  chipToneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  lede: "2 reviewed reserve slices — 100% convertible within one day.",
  mix: [
    { key: "treasury-bill", label: "Treasury bills", pct: 80, barClass: "bg-foreground/80" },
    { key: "bank-deposit", label: "Bank deposits", pct: 20, barClass: "bg-foreground/60" },
  ],
  ladder: [
    { key: "immediate", label: "Immediate", pct: 20 },
    { key: "one-day", label: "≤ 1 day", pct: 80 },
  ],
  liquidWithinOneDayPct: 100,
  unknownHorizonPct: 0,
  unidentifiedObligorsPct: 0,
  selfExposurePct: null,
  topPositionName: null,
  topPositionPct: null,
  asOf: "2026-06-30",
  sliceCount: 2,
  confidenceLabel: "Verified",
  reviewedAt: "2026-07-18",
  compositionBasis: "Monthly attestation composition table.",
  knownUnknownExposureNote: "No undisclosed obligors in the attested basket.",
  slices: [
    {
      key: "U.S. Treasury bills:0",
      name: "U.S. Treasury bills",
      pct: 80,
      assetClassLabel: "Treasury bills",
      horizonLabel: "≤ 1 day",
      riskLabel: "Very low",
      obligor: "U.S. Treasury",
      riskFactorLabels: ["duration", "liquidity"],
    },
    {
      key: "Bank deposits:1",
      name: "Bank deposits",
      pct: 20,
      assetClassLabel: "Bank deposits",
      horizonLabel: "Immediate",
      riskLabel: "Low",
      obligor: null,
      riskFactorLabels: [],
    },
  ],
  sources: [{ label: "Circle reserve report", url: "https://example.com/reserves" }],
};

describe("ReserveQualitySection", () => {
  it("renders the chip, lede, mix, ladder, and facts", () => {
    const html = renderToStaticMarkup(<ReserveQualitySection summary={SUMMARY} />);
    expect(html).toContain("Reserve quality");
    expect(html).toContain("Highly liquid");
    expect(html).toContain("100% convertible within one day");
    expect(html).toContain("Asset mix");
    expect(html).toContain("Time to liquidate");
    expect(html).toContain("Immediate");
    expect(html).toContain("≤ 1 day");
    expect(html).toContain("As of");
    expect(html).toContain("2026-06-30");
    expect(html).toContain("Slices");
    expect(html).toContain("Verified");
    // detail disclosure closed by default (native <details> without open attr)
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
  });

  it("renders nothing without a reserve quality summary", () => {
    expect(renderToStaticMarkup(<ReserveQualitySection summary={null} />)).toBe("");
    expect(renderToStaticMarkup(<ReserveQualitySection />)).toBe("");
  });

  it("describes the asset-class mix for assistive tech and legends it inline", () => {
    const html = renderToStaticMarkup(<ReserveQualitySection summary={SUMMARY} />);
    expect(html).toContain('aria-label="Asset-class mix: Treasury bills 80%, Bank deposits 20%"');
    expect(html).toContain("bg-foreground/80");
    expect(html).toContain("bg-foreground/60");
    expect(html).toContain("Treasury bills");
    expect(html).toContain("Bank deposits");
  });

  it("labels the ladder and tones only the unknown row amber", () => {
    const html = renderToStaticMarkup(<ReserveQualitySection summary={SUMMARY} />);
    expect(html).toContain('aria-label="Liquidity horizon ladder"');
    expect(html).not.toContain(AMBER_VALUE_CLASS);
    expect(html).not.toContain("bg-amber-500/50");

    const opaque = renderToStaticMarkup(
      <ReserveQualitySection
        summary={{
          ...SUMMARY,
          ladder: [...SUMMARY.ladder, { key: "unknown", label: "Unknown", pct: 45 }],
          unknownHorizonPct: 45,
        }}
      />,
    );
    expect(opaque).toContain("Unknown");
    expect(opaque).toContain(AMBER_VALUE_CLASS);
    expect(opaque).toContain("bg-amber-500/50");
    expect(opaque).toContain("45%");
  });

  it("omits review-derived facts the summary does not carry", () => {
    const html = renderToStaticMarkup(
      <ReserveQualitySection
        summary={{
          ...SUMMARY,
          unidentifiedObligorsPct: null,
          selfExposurePct: null,
          asOf: null,
          confidenceLabel: null,
        }}
      />,
    );
    expect(html).not.toContain("Unidentified obligors");
    expect(html).not.toContain("Self-exposure");
    expect(html).not.toContain("As of");
    expect(html).not.toContain("Confidence");
    expect(html).toContain("Slices");
  });

  it("renders a zero unidentified-obligor share without an amber tone", () => {
    const html = renderToStaticMarkup(<ReserveQualitySection summary={SUMMARY} />);
    expect(html).toContain("Unidentified obligors");
    // Delimited so the assertion cannot pass on the mix legend's "80%".
    expect(html).toContain(">0%<");
    expect(html).not.toContain(AMBER_VALUE_CLASS);
  });

  it("tones a non-zero unidentified-obligor share and self-exposure amber", () => {
    const html = renderToStaticMarkup(
      <ReserveQualitySection summary={{ ...SUMMARY, unidentifiedObligorsPct: 12.6, selfExposurePct: 8.8 }} />,
    );
    expect(html).toContain("Unidentified obligors");
    expect(html).toContain("12.6%");
    expect(html).toContain("Self-exposure");
    expect(html).toContain("8.8%");
    expect(html).toContain(AMBER_VALUE_CLASS);
  });

  it("names the concentrated top position in the fact tooltip", () => {
    const html = renderToStaticMarkup(
      <ReserveQualitySection
        summary={{ ...SUMMARY, topPositionName: "Hedged basis book", topPositionPct: 62.4 }} />,
    );
    expect(html).toContain("Top position");
    expect(html).toContain("62.4%");
    expect(html).toContain('title="Hedged basis book"');
  });

  it("folds slice detail, obligors, and risk factors into the disclosure", () => {
    const html = renderToStaticMarkup(<ReserveQualitySection summary={SUMMARY} />);
    expect(html).toContain("Slice detail &amp; risk factors");
    expect(html).toContain('aria-label="Reserve slices"');
    expect(html).toContain("Monthly attestation composition table.");
    expect(html).toContain("No undisclosed obligors in the attested basket.");
    expect(html).toContain("U.S. Treasury bills");
    expect(html).toContain("Very low risk");
    expect(html).toContain("Obligor: U.S. Treasury");
    expect(html).toContain("Risk factors: duration · liquidity");
  });

  it("renders the sources footer and the reviewed stamp", () => {
    const html = renderToStaticMarkup(<ReserveQualitySection summary={SUMMARY} />);
    expect(html).toContain("https://example.com/reserves");
    expect(html).toContain("Circle reserve report");
    expect(html).toContain("Reviewed 2026-07-18");
  });
});
