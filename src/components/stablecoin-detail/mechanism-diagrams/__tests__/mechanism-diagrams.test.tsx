// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MechanismArchetype } from "@shared/types";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";

afterEach(() => cleanup());

function svgFor(archetype: MechanismArchetype, symbol: string): string {
  const node = mechanismDiagramFor(archetype, symbol);
  expect(node).not.toBeNull();
  const { container } = render(<>{node}</>);
  const svg = container.querySelector("svg");
  expect(svg).not.toBeNull();
  return svg!.outerHTML;
}

describe("mechanismDiagramFor", () => {
  it("renders the fiat-cash diagram", () => {
    expect(svgFor("fiat-cash", "USDC")).toMatchSnapshot();
  });

  it("renders the tbill diagram", () => {
    expect(svgFor("tbill", "USDC")).toMatchSnapshot();
  });

  it("renders the cdp diagram", () => {
    expect(svgFor("cdp", "USDC")).toMatchSnapshot();
  });

  it("renders the synthetic-delta-neutral diagram", () => {
    expect(svgFor("synthetic-delta-neutral", "USDC")).toMatchSnapshot();
  });

  it("renders the algorithmic diagram", () => {
    expect(svgFor("algorithmic", "USDC")).toMatchSnapshot();
  });

  it("returns null for an unknown archetype", () => {
    expect(mechanismDiagramFor("unknown" as MechanismArchetype, "X")).toBeNull();
  });
});
