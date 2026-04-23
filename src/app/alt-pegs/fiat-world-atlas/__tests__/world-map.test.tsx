// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";

afterEach(cleanup);

describe("WorldMap", () => {
  it("renders the world SVG with the fiat-world-map wrapper", () => {
    const { container } = render(<WorldMap />);
    const wrapper = container.querySelector(".fiat-world-map");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector("svg")).not.toBeNull();
  });

  it("does not apply any peg-specific fill overrides", () => {
    const { container } = render(<WorldMap />);
    const styleEl = container.querySelector("style");
    expect(styleEl).not.toBeNull();
    expect(styleEl!.textContent).not.toMatch(/path#\w+\{fill:/);
  });
});
