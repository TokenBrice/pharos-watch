// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { DeviationIcon } from "@/components/severity-icon";


describe("DeviationIcon", () => {
  it("renders different SVG for healthy vs severe deviation", () => {
    const { container: healthy } = render(<DeviationIcon absBps={10} />);
    const healthySvgContent = healthy.querySelector("svg")?.innerHTML;
    cleanup();

    const { container: severe } = render(<DeviationIcon absBps={600} />);
    const severeSvgContent = severe.querySelector("svg")?.innerHTML;

    expect(healthySvgContent).not.toBe(severeSvgContent);
  });

});
