// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { DeviationIcon } from "@/components/severity-icon";


describe("DeviationIcon", () => {
  it("renders an svg element for a healthy deviation", () => {
    const { container } = render(<DeviationIcon absBps={10} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders with aria-hidden=true to hide from screen readers", () => {
    const { container } = render(<DeviationIcon absBps={10} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("applies default size class h-3 w-3", () => {
    const { container } = render(<DeviationIcon absBps={10} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("h-3");
    expect(svg?.getAttribute("class")).toContain("w-3");
  });

  it("applies custom className when provided", () => {
    const { container } = render(
      <DeviationIcon absBps={10} className="h-5 w-5 custom-icon" />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("custom-icon");
  });

  it("renders different SVG for healthy vs severe deviation", () => {
    const { container: healthy } = render(<DeviationIcon absBps={10} />);
    const healthySvgContent = healthy.querySelector("svg")?.innerHTML;
    cleanup();

    const { container: severe } = render(<DeviationIcon absBps={600} />);
    const severeSvgContent = severe.querySelector("svg")?.innerHTML;

    expect(healthySvgContent).not.toBe(severeSvgContent);
  });

  it("renders for mild threshold (50-200 bps)", () => {
    const { container } = render(<DeviationIcon absBps={100} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders for moderate threshold (200-500 bps)", () => {
    const { container } = render(<DeviationIcon absBps={300} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders for severe threshold (>500 bps)", () => {
    const { container } = render(<DeviationIcon absBps={501} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
