// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CAUSE_ORDER } from "@shared/lib/cause-of-death";
import { CemeteryCauseGlyph, CemeteryCauseGlyphDefs } from "../cemetery-cause-glyph";

describe("CemeteryCauseGlyph", () => {
  it("draws each of the five gravestones once in the sheet and references it from a slim aria-hidden marker", () => {
    const html = renderToStaticMarkup(
      <>
        <CemeteryCauseGlyphDefs />
        {CAUSE_ORDER.map((cause) => (
          <CemeteryCauseGlyph key={cause} cause={cause} />
        ))}
      </>,
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelectorAll("symbol")).toHaveLength(CAUSE_ORDER.length);
    const markers = [...host.querySelectorAll<SVGSVGElement>(":scope > svg:not(:first-child)")];
    expect(markers).toHaveLength(CAUSE_ORDER.length);
    CAUSE_ORDER.forEach((cause, i) => {
      const href = markers[i].querySelector("use")?.getAttribute("href");
      expect(href?.endsWith(`-${cause}`)).toBe(true);
      const symbol = host.querySelector(`symbol${href}`);
      expect(symbol?.querySelectorAll("polygon,polyline,ellipse,circle").length).toBeGreaterThan(3);
      expect(markers[i].getAttribute("aria-hidden")).toBe("true");
      // the marker carries no drawing of its own: the bytes live once in the sheet
      expect(markers[i].querySelector("polygon")).toBeNull();
    });
  });
});
