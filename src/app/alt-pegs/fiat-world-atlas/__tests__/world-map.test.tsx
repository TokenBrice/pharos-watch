// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";

const WORLD_SVG = '<svg viewBox="0 0 900 460"><g class="world-countries"><path id="US" /></g></svg>';

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(WORLD_SVG),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorldMap", () => {
  it("renders the world SVG with the fiat-world-map wrapper", async () => {
    const { container } = render(<WorldMap />);
    const wrapper = container.querySelector(".fiat-world-map");
    expect(wrapper).not.toBeNull();
    await waitFor(() => expect(wrapper!.querySelector("svg")).not.toBeNull());
  });

  it("does not apply any peg-specific fill overrides", () => {
    const { container } = render(<WorldMap />);
    const styleEl = container.querySelector("style");
    expect(styleEl).not.toBeNull();
    expect(styleEl!.textContent).not.toMatch(/path#\w+\{fill:/);
  });
});
