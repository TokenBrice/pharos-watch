import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  StablecoinDetailIdentityProvider,
  StablecoinModuleTitle,
} from "../module-title";

describe("StablecoinModuleTitle", () => {
  it("adds the detail-page coin identity so a screenshotted module names its subject", () => {
    const html = renderToStaticMarkup(
      <StablecoinDetailIdentityProvider symbol="BD" logoSrc={undefined}>
        <StablecoinModuleTitle>Reserve quality</StablecoinModuleTitle>
      </StablecoinDetailIdentityProvider>,
    );

    expect(html).toContain('aria-label="BD logo"');
    expect(html).toContain(">BD<");
    expect(html).toContain("Reserve quality");
  });
});
