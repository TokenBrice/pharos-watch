import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FigureLeadText } from "../figure-lead-text";

const render = (text: string) => renderToStaticMarkup(<FigureLeadText text={text} />);

describe("FigureLeadText", () => {
  it("sets a leading figure in mono and keeps the words sans", () => {
    expect(render("-12 bps")).toBe('<span class="pharos-numeric">-12</span> bps');
    expect(render("2,671 pools")).toBe('<span class="pharos-numeric">2,671</span> pools');
    expect(render("15/100")).toBe('<span class="pharos-numeric">15/100</span>');
  });

  it("leaves word-like period labels and plain words untouched", () => {
    expect(render("30d vs USD 3M T-bill")).toBe("30d vs USD 3M T-bill");
    expect(render("Institutional")).toBe("Institutional");
  });
});
