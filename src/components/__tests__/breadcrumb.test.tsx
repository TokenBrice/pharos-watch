import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Breadcrumb } from "@/components/breadcrumb";

describe("Breadcrumb", () => {
  it("renders one item as plain current page", () => {
    const html = renderToStaticMarkup(<Breadcrumb items={[{ label: "Dashboard" }]} />);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Dashboard");
  });

  it("renders two items with a link then the current page", () => {
    const html = renderToStaticMarkup(
      <Breadcrumb items={[{ label: "Dashboard", href: "/" }, { label: "Tether" }]} />,
    );
    expect(html).toContain('href="/"');
    expect(html).toContain("Dashboard");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Tether");
  });

  it("renders three items with separators between each", () => {
    const html = renderToStaticMarkup(
      <Breadcrumb
        items={[
          { label: "Dashboard", href: "/" },
          { label: "USD Stablecoins", href: "/stablecoins/usd/" },
          { label: "Tether" },
        ]}
      />,
    );
    // Two separators
    const matches = html.match(/aria-hidden="true"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("includes the pharos-focus-ring class on links", () => {
    const html = renderToStaticMarkup(
      <Breadcrumb items={[{ label: "Dashboard", href: "/" }, { label: "Here" }]} />,
    );
    expect(html).toContain("pharos-focus-ring");
  });
});
