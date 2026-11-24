// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CAUSE_ORDER } from "@shared/lib/cause-of-death";
import { PLOT_ARCHETYPE_BY_CAUSE } from "@/lib/cemetery-plot-geometry";
import { CemeteryCauseGlyph, CemeteryCauseGlyphDefs, CemeteryCauseGlyphUse } from "../cemetery-cause-glyph";

describe("CemeteryCauseGlyph", () => {
  it("renders all five aria-hidden gravestone glyphs and matching symbol/use pairs", () => {
    const html = renderToStaticMarkup(
      <>
        <CemeteryCauseGlyphDefs idPrefix="test-g" />
        {CAUSE_ORDER.map((cause) => (
          <CemeteryCauseGlyph key={`i-${cause}`} cause={cause} />
        ))}
        {CAUSE_ORDER.map((cause) => (
          <CemeteryCauseGlyphUse key={`u-${cause}`} cause={cause} idPrefix="test-g" />
        ))}
      </>,
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    for (const cause of CAUSE_ORDER) {
      const symbol = host.querySelector(`symbol#test-g-${cause}`);
      expect(symbol?.querySelectorAll("polygon,polyline,ellipse,circle").length).toBeGreaterThan(3);
      const inline = host.querySelector(`svg[data-cause-glyph="${cause}"][viewBox]`);
      expect(inline?.getAttribute("aria-hidden")).toBe("true");
      expect(inline?.getAttribute("data-cause-archetype")).toBe(PLOT_ARCHETYPE_BY_CAUSE[cause]);
      expect(host.querySelector(`svg[data-cause-glyph="${cause}"] use[href="#test-g-${cause}"]`)).not.toBeNull();
    }
  });
});
