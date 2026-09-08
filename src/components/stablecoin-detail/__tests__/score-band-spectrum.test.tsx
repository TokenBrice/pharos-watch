import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScoreBandSpectrum, type SpectrumBand } from "../score-band-spectrum";

const BANDS: SpectrumBand[] = [
  { key: "exposed", label: "Exposed", fillClass: "bg-red-500/70", textClass: "text-red-700" },
  { key: "managed", label: "Managed", fillClass: "bg-amber-500/70", textClass: "text-amber-700" },
  { key: "hardened", label: "Hardened", fillClass: "bg-emerald-500/70", textClass: "text-emerald-700" },
];

/**
 * Track segments come first, then the optional label row — both size
 * themselves with `flex-grow`, so the count tells the label row apart from a
 * restyled one and the values expose which width landed on which band.
 */
function growValues(html: string): number[] {
  return Array.from(html.matchAll(/flex-grow:([\d.]+)/g)).map((match) => Number(match[1]));
}

/** The positioned score marker is the only element carrying an inline `left`. */
function markerPositions(html: string): string[] {
  return Array.from(html.matchAll(/left:([^;"]+)/g)).map((match) => match[1]!);
}

describe("ScoreBandSpectrum", () => {
  it("lights only the active band in ordinal mode, with equal segments and no marker", () => {
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum mode="ordinal" bands={BANDS} activeKey="managed" ariaLabel="Band: Managed" />,
    );
    expect(html).toContain('role="img" aria-label="Band: Managed"');
    expect(html).toContain("bg-amber-500/70");
    expect(html).not.toContain("bg-red-500/70");
    expect(html).not.toContain("bg-emerald-500/70");
    // Three track segments plus three label spans, all equal thirds.
    const grows = growValues(html);
    expect(grows).toHaveLength(6);
    expect(grows.slice(0, 3)).toEqual([grows[0], grows[0], grows[0]]);
    // Ordinal mode positions no score marker — bands are classes, not ranges.
    expect(markerPositions(html)).toEqual([]);
    expect(html).toContain("Managed");
  });

  it("sizes segments from cutoffs in band order and notches the marker at the score", () => {
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
    expect(html).toContain('role="img" aria-label="Score 63 of 100"');
    expect(growValues(html).slice(0, 3)).toEqual([40, 40, 20]);
    expect(markerPositions(html)).toEqual(["63%"]);
  });

  it.each([
    [-5, "0%"],
    [140, "100%"],
  ])("clamps an off-scale score of %s onto the track at %s", (score, expected) => {
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum
        mode="range"
        bands={BANDS}
        cutoffs={[0, 40, 80]}
        activeKey="exposed"
        score={score}
        ariaLabel={`Score ${score} of 100`}
      />,
    );
    expect(markerPositions(html)).toEqual([expected]);
  });

  it("omits the marker for a null score while keeping the cutoff-sized track", () => {
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum
        mode="range"
        bands={BANDS}
        cutoffs={[0, 40, 80]}
        activeKey="managed"
        score={null}
        ariaLabel="Score unavailable"
      />,
    );
    expect(markerPositions(html)).toEqual([]);
    expect(growValues(html).slice(0, 3)).toEqual([40, 40, 20]);
  });

  it("falls back to equal segments when cutoffs do not cover every band", () => {
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum
        mode="range"
        bands={BANDS}
        cutoffs={[0, 40]}
        activeKey="managed"
        score={63}
        ariaLabel="Score 63 of 100"
      />,
    );
    // Never silently pin a two-cutoff width list onto three bands.
    const grows = growValues(html).slice(0, 3);
    expect(grows).toEqual([grows[0], grows[0], grows[0]]);
    expect(markerPositions(html)).toEqual(["63%"]);
  });

  it("renders nothing for an unknown active band", () => {
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum mode="ordinal" bands={BANDS} activeKey="nr" ariaLabel="Not rated" />,
    );
    expect(html).toBe("");
  });

  it("drops the whole label row when bands are unlabeled", () => {
    const unlabeled = BANDS.map((band) => ({ ...band, label: "" }));
    const html = renderToStaticMarkup(
      <ScoreBandSpectrum mode="ordinal" bands={unlabeled} activeKey="managed" ariaLabel="Score track" />,
    );
    // Track segments only: no second row of label spans survives.
    expect(growValues(html)).toHaveLength(3);
    expect(html).toContain('aria-label="Score track"');
  });
});
