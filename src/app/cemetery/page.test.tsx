import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CemeteryPage from "./page";

vi.mock("@/components/cemetery-client", () => ({
  CemeteryClient: () => <section>cemetery tombstones</section>,
}));

vi.mock("@/components/cemetery-charts", () => ({
  CemeteryCharts: () => <section>cemetery charts</section>,
}));

describe("CemeteryPage", () => {
  it("places the tombstone field before the cemetery charts", () => {
    const html = renderToStaticMarkup(<CemeteryPage />);

    expect(html).toContain("Stablecoin Cemetery");
    expect(html.indexOf("cemetery tombstones")).toBeLessThan(html.indexOf("cemetery charts"));
  });
});
