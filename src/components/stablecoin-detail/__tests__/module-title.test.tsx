import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  StablecoinDetailIdentityProvider,
  StablecoinModuleTitle,
} from "../module-title";

describe("StablecoinModuleTitle", () => {
  it("adds the detail-page coin identity to a module title", () => {
    const html = renderToStaticMarkup(
      <StablecoinDetailIdentityProvider symbol="BD" logoSrc={undefined}>
        <StablecoinModuleTitle>Reserve quality</StablecoinModuleTitle>
      </StablecoinDetailIdentityProvider>,
    );

    expect(html).toContain('aria-label="BD logo"');
    expect(html).toContain(">BD<");
    expect(html).toContain("Reserve quality");
  });

  it("keeps the ordinary module title outside a detail-page identity provider", () => {
    const html = renderToStaticMarkup(<StablecoinModuleTitle>Reserve quality</StablecoinModuleTitle>);

    expect(html).not.toContain("logo");
    expect(html).toContain("Reserve quality");
  });
});
