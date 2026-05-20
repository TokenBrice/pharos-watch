// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MechanismArchetype } from "@shared/types";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";

afterEach(() => cleanup());

function renderFor(archetype: MechanismArchetype, symbol: string): string {
  const node = mechanismDiagramFor(archetype, symbol);
  expect(node).not.toBeNull();
  const { container } = render(<>{node}</>);
  const svgs = container.querySelectorAll("svg");
  expect(svgs.length).toBe(2);
  return container.innerHTML;
}

describe("mechanismDiagramFor", () => {
  it("renders the fiat-cash diagram", () => {
    expect(renderFor("fiat-cash", "USDC")).toMatchSnapshot();
  });

  it("renders the tbill diagram", () => {
    expect(renderFor("tbill", "USDC")).toMatchSnapshot();
  });

  it("renders the cdp diagram", () => {
    expect(renderFor("cdp", "USDC")).toMatchSnapshot();
  });

  it("renders the synthetic-delta-neutral diagram", () => {
    expect(renderFor("synthetic-delta-neutral", "USDC")).toMatchSnapshot();
  });

  it("renders the algorithmic diagram", () => {
    expect(renderFor("algorithmic", "USDC")).toMatchSnapshot();
  });

  it("returns null for an unknown archetype", () => {
    expect(mechanismDiagramFor("unknown" as MechanismArchetype, "X")).toBeNull();
  });
});
