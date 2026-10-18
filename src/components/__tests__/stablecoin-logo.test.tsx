// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StablecoinLogo } from "../stablecoin-logo";
import variants from "@/lib/logo-variants.generated.json";

afterEach(cleanup);

describe("StablecoinLogo density selection", () => {
  it("publishes high-density candidates in server markup without changing the reserved header geometry", () => {
    const [src, sizes] = Object.entries(variants).find(([src]) => src.startsWith("/logos/"))!;
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
});
