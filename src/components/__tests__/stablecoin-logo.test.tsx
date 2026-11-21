// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StablecoinLogo } from "../stablecoin-logo";
import collections from "@/lib/logo-variants.generated.json";
import { compactLogoVariants } from "@/lib/logo-variants";

afterEach(cleanup);

describe("StablecoinLogo density selection", () => {
  it("publishes high-density candidates in server markup without changing the reserved header geometry", () => {
    const src = `/logos/${collections["/logos"].sources[0]}`;
    const sizes = compactLogoVariants(src)!;
    const markup = renderToStaticMarkup(<StablecoinLogo src={src} name="Test coin" size={56} />);
    expect(markup).toContain(`${src} 3x`);
    const { container } = render(<StablecoinLogo src={src} name="Test coin" size={56} />);
    const image = screen.getByRole("img", { name: "Test coin logo" });
    expect(image.getAttribute("width")).toBe("50");
    expect(image.getAttribute("height")).toBe("50");
    expect(container.querySelector("source")?.getAttribute("srcset")).toBe(
      `${sizes[100]} 1x, ${sizes[100]} 2x, ${src} 3x`,
    );
    expect((container.firstElementChild as HTMLElement).style.width).toBe("56px");
  });

  it("softens the dark-mode backplate with a lifted neutral tint and hairline ring", () => {
    const { container } = render(<StablecoinLogo src="/logos/example.png" name="Dark mark" />);
    const plate = container.firstElementChild as HTMLElement;
    expect(plate.className).toContain("dark:bg-foreground/12");
    expect(plate.className).toContain("dark:ring-1");
    expect(plate.className).not.toContain("dark:bg-foreground/90");
    expect(screen.getByRole("img", { name: "Dark mark logo" }).getAttribute("loading")).toBe("lazy");
  });

  it("supports eager image loading for above-fold table rows", () => {
    render(<StablecoinLogo src="/logos/example.png" name="Top coin" loading="eager" />);
    expect(screen.getByRole("img", { name: "Top coin logo" }).getAttribute("loading")).toBe("eager");
  });
});
