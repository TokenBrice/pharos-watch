import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StablecoinModuleTitle } from "../module-title";

describe("StablecoinModuleTitle", () => {
  it("renders the bare module title by default; the dossier header already names the coin", () => {
    const html = renderToStaticMarkup(<StablecoinModuleTitle>Reserve quality</StablecoinModuleTitle>);

    expect(html).not.toContain("logo");
    expect(html).not.toContain("·");
    expect(html).toContain("Reserve quality");
  });

  it("keeps an explicit coin identity for out-of-context surfaces", () => {
    const html = renderToStaticMarkup(
      <StablecoinModuleTitle symbol="BD" logoSrc={undefined}>Safety Score</StablecoinModuleTitle>,
    );

    expect(html).toContain('aria-label="BD logo"');
    expect(html).toContain(">BD<");
    expect(html).toContain("Safety Score");
  });
});
