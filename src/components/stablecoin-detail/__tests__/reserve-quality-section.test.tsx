import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReserveQualitySection } from "../reserve-quality-section";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import type { ReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";

const AMBER_VALUE_CLASS = "text-amber-600 dark:text-amber-400";

/**
 * One ladder row's markup, so a row can lose its own tone or figure without
 * another row's tone satisfying the assertion.
 */
function ladderRow(html: string, label: string): string {
  const ladder = html.split('aria-label="Liquidity horizon ladder"')[1] ?? "";
  const rows = ladder.split("<li ").slice(1).map((chunk) => chunk.split("</li>")[0] ?? "");
  const row = rows.find((chunk) => chunk.includes(`>${label}</span>`));
  expect(row, `ladder row ${label}`).toBeDefined();
  return row!;
}

/** A fact-grid cell's own value text and tone classes, scoped to its label. */
function factCell(html: string, label: string): { value: string; valueClass: string } {
  // Locates `>${label}</span><span class="…">…</span>` without building a
  // RegExp from the label: quoted class value, then plain text to `</span>`.
  const marker = `>${label}</span><span class="`;
  const at = html.indexOf(marker);
  const classEnd = at === -1 ? -1 : html.indexOf('"', at + marker.length);
  const valueStart = classEnd !== -1 && html[classEnd + 1] === ">" ? classEnd + 2 : -1;
  const valueLt = valueStart === -1 ? -1 : html.indexOf("<", valueStart);
  const matched = valueStart !== -1 && valueLt !== -1 && html.startsWith("</span>", valueLt);
  expect(matched, `fact cell ${label}`).toBe(true);
  return { valueClass: html.slice(at + marker.length, classEnd), value: html.slice(valueStart, valueLt) };
}

const SUMMARY: ReserveQualityClientSummary = {
  chipLabel: "Highly liquid",
  chipToneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  lede: "2 reviewed reserve slices — 100% convertible within one day.",
  mix: [
    { key: "treasury-bill", label: "Treasury bills", pct: 80, barClass: "bg-foreground/80" },
    { key: "bank-deposit", label: "Bank deposits", pct: 20, barClass: "bg-foreground/60" },
  ],
  ladder: [
    { key: "immediate", tone: "ok", label: "Immediate", pct: 20 },
    { key: "one-day", tone: "info", label: "≤ 1 day", pct: 80 },
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
  it("folds the slice detail disclosure closed by default", () => {
    const html = renderToStaticMarkup(<ReserveQualitySection summary={SUMMARY} />);
    expect(html).toContain("Slice detail &amp; risk factors");
    // Native <details> renders `open` after its class/id attributes when set,
    // so the absence check has to allow for preceding attributes.
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>]/);
  });

  it("renders nothing without a reserve quality summary", () => {
    expect(renderToStaticMarkup(<ReserveQualitySection summary={null} />)).toBe("");
    expect(renderToStaticMarkup(<ReserveQualitySection />)).toBe("");
  });

  it("describes the asset-class mix for assistive tech and legends it inline", () => {
    const html = renderToStaticMarkup(<ReserveQualitySection summary={SUMMARY} />);
    expect(html).toContain('aria-label="Asset-class mix: Treasury bills 80%, Bank deposits 20%"');
    expect(html).toContain("Treasury bills");
    expect(html).toContain("Bank deposits");
  });

  it("tones each ladder row by its own horizon severity", () => {
    const html = renderToStaticMarkup(<ReserveQualitySection summary={SUMMARY} />);
    expect(html).toContain('aria-label="Liquidity horizon ladder"');

    const immediate = ladderRow(html, "Immediate");
    expect(immediate).toContain(SEVERITY_TONE_CLASS.ok.bar);
    expect(immediate).toContain(SEVERITY_TONE_CLASS.ok.text);
    expect(immediate).toContain("20%");

    const oneDay = ladderRow(html, "≤ 1 day");
    expect(oneDay).toContain(SEVERITY_TONE_CLASS.info.bar);
    expect(oneDay).toContain(SEVERITY_TONE_CLASS.info.text);
    expect(oneDay).toContain("80%");
    expect(oneDay).not.toContain(SEVERITY_TONE_CLASS.ok.bar);
  });

  it("reads an unknown horizon as a neutral share, not as a severity step", () => {
    // A share of the basket is not a risk level: the unknown row reads as a
    // label, not as a severity tone (design polish F4 / §5.3, §5.4).
    const html = renderToStaticMarkup(
      <ReserveQualitySection
        summary={{
          ...SUMMARY,
          ladder: [...SUMMARY.ladder, { key: "unknown", tone: "neutral", label: "Unknown", pct: 45 }],
          unknownHorizonPct: 45,
        }}
      />,
    );
    const unknown = ladderRow(html, "Unknown");
    expect(unknown).toContain("45%");
    expect(unknown).toContain(SEVERITY_TONE_CLASS.neutral.bar);
    expect(unknown).toContain(SEVERITY_TONE_CLASS.neutral.text);
    expect(unknown).not.toContain(SEVERITY_TONE_CLASS.watch.bar);
    expect(unknown).not.toContain(SEVERITY_TONE_CLASS.watch.text);
  });

  it("keeps a fractional ladder share visible instead of an empty track", () => {
    const html = renderToStaticMarkup(
      <ReserveQualitySection
        summary={{ ...SUMMARY, ladder: [{ key: "immediate", tone: "ok", label: "Immediate", pct: 0.1 }] }}
      />,
    );
    expect(html).toContain("min-width:3px");
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
    const unidentified = factCell(html, "Unidentified obligors");
    expect(unidentified.value).toBe("0%");
    expect(unidentified.valueClass).not.toContain(AMBER_VALUE_CLASS);
  });

  it("tones a non-zero unidentified-obligor share and self-exposure amber, per fact", () => {
    const html = renderToStaticMarkup(
      <ReserveQualitySection summary={{ ...SUMMARY, unidentifiedObligorsPct: 12.6, selfExposurePct: 8.8 }} />,
    );
    const unidentified = factCell(html, "Unidentified obligors");
    expect(unidentified.value).toBe("12.6%");
    expect(unidentified.valueClass).toContain(AMBER_VALUE_CLASS);

    const selfExposure = factCell(html, "Self-exposure");
    expect(selfExposure.value).toBe("8.8%");
    expect(selfExposure.valueClass).toContain(AMBER_VALUE_CLASS);
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
