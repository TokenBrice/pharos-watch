// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import { HoverProvider, useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

function makeCoin(id: string, peg: PlacedCoin["pegCurrency"], x: number, y: number): PlacedCoin {
  return {
    id,
    symbol: id.toUpperCase(),
    name: id,
    href: `/s/${id}`,
    logoSrc: `/l/${id}.png`,
    pegCurrency: peg,
    marketCap: 1_000_000,
    x,
    y,
    sizePx: 40,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __hoverHandle: ReturnType<typeof useHoverState>;
}

function Grabber() {
  globalThis.__hoverHandle = useHoverState();
  return null;
}

describe("CohortThreads", () => {
  afterEach(() => cleanup());

  it("renders nothing when no coin is hovered", () => {
    const coins = [makeCoin("a", "EUR", 50, 20), makeCoin("b", "EUR", 60, 25)];
    const { container } = render(
      <HoverProvider>
        <CohortThreads coins={coins} colorHex="#60a5fa" />
      </HoverProvider>,
    );
    expect(container.querySelectorAll("line").length).toBe(0);
  });

  it("draws N-1 lines when hovering a coin with N siblings", () => {
    const coins = [
      makeCoin("a", "EUR", 50, 20),
      makeCoin("b", "EUR", 60, 25),
      makeCoin("c", "EUR", 40, 25),
      makeCoin("d", "JPY", 80, 30),
    ];
    const { container } = render(
      <HoverProvider>
        <Grabber />
        <CohortThreads coins={coins} colorHex="#60a5fa" />
      </HoverProvider>,
    );
    act(() => {
      globalThis.__hoverHandle.setHoveredCoin({ id: "a", pegCurrency: "EUR" });
    });
    const lines = container.querySelectorAll("line");
    expect(lines.length).toBe(2);
  });

  it("renders nothing when the hovered coin is not in this layer", () => {
    const coins = [makeCoin("a", "EUR", 50, 20), makeCoin("b", "EUR", 60, 25)];
    const { container } = render(
      <HoverProvider>
        <Grabber />
        <CohortThreads coins={coins} colorHex="#60a5fa" />
      </HoverProvider>,
    );
    act(() => {
      globalThis.__hoverHandle.setHoveredCoin({ id: "xaut", pegCurrency: "GOLD" });
    });
    expect(container.querySelectorAll("line").length).toBe(0);
  });
});
