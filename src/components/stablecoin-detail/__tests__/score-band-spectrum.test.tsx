import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScoreBandSpectrum, type SpectrumBand } from "../score-band-spectrum";

const BANDS: SpectrumBand[] = [
  { key: "exposed", label: "Exposed", fillClass: "bg-red-500/70", textClass: "text-red-700" },
  { key: "managed", label: "Managed", fillClass: "bg-amber-500/70", textClass: "text-amber-700" },
  { key: "hardened", label: "Hardened", fillClass: "bg-emerald-500/70", textClass: "text-emerald-700" },
];

describe("ScoreBandSpectrum", () => {
  it("lights only the active band in ordinal mode, with no marker", () => {
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum mode="ordinal" bands={BANDS} activeKey="managed" ariaLabel="Band: Managed" />,
    );
    expect(html).toContain("bg-amber-500/70");
    expect(html).not.toContain("bg-red-500/70");
    expect(html).not.toContain("bg-emerald-500/70");
    expect(html).toContain("Managed");
    // Ordinal mode positions no score marker — bands are classes, not ranges.
    expect(html).not.toContain("-translate-x-1/2");
  });

  it("sizes segments from cutoffs and notches the marker at the score in range mode", () => {
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum
        mode="range"
        bands={BANDS}
        cutoffs={[0, 40, 80]}
        activeKey="managed"
        score={63}
        ariaLabel="Score 63 of 100"
      />,
    );
    expect(html).toContain("flex-grow:40");
    expect(html).toContain("flex-grow:20");
    expect(html).toContain("left:63%");
  });

  it("renders nothing for an unknown active band", () => {
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum mode="ordinal" bands={BANDS} activeKey="nr" ariaLabel="Not rated" />,
    );
    expect(html).toBe("");
  });

  it("omits the label row when bands are unlabeled", () => {
    const unlabeled = BANDS.map((band) => ({ ...band, label: "" }));
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum mode="ordinal" bands={unlabeled} activeKey="managed" ariaLabel="Score track" />,
    );
    expect(html).not.toContain("uppercase leading-tight tracking-[0.08em]");
  });
});
