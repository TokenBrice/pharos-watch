// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
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

type HoverState = ReturnType<typeof useHoverState>;

function Grabber({ onState }: { onState: (state: HoverState) => void }) {
  const state = useHoverState();
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return null;
}

describe("CohortThreads", () => {

  function makeHandleCapture() {
    let hoverHandle: HoverState | null = null;
    const setHoverHandle = (state: HoverState) => {
      hoverHandle = state;
    };
    const getHoverHandle = () => {
      if (!hoverHandle) throw new Error("Hover handle was not captured");
      return hoverHandle;
    };

    return { getHoverHandle, setHoverHandle };
  }

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
    const { getHoverHandle, setHoverHandle } = makeHandleCapture();
    const coins = [
      makeCoin("a", "EUR", 50, 20),
      makeCoin("b", "EUR", 60, 25),
      makeCoin("c", "EUR", 40, 25),
      makeCoin("d", "JPY", 80, 30),
    ];
    const { container } = render(
      <HoverProvider>
        <Grabber onState={setHoverHandle} />
        <CohortThreads coins={coins} colorHex="#60a5fa" />
      </HoverProvider>,
    );
    act(() => {
      getHoverHandle().setHoveredCoin({ id: "a", pegCurrency: "EUR" });
    });
    const lines = container.querySelectorAll("line");
    expect(lines.length).toBe(2);
  });

  it("renders nothing when the hovered coin is not in this layer", () => {
    const { getHoverHandle, setHoverHandle } = makeHandleCapture();
    const coins = [makeCoin("a", "EUR", 50, 20), makeCoin("b", "EUR", 60, 25)];
    const { container } = render(
      <HoverProvider>
        <Grabber onState={setHoverHandle} />
        <CohortThreads coins={coins} colorHex="#60a5fa" />
      </HoverProvider>,
    );
    act(() => {
      getHoverHandle().setHoveredCoin({ id: "xaut", pegCurrency: "GOLD" });
    });
    expect(container.querySelectorAll("line").length).toBe(0);
  });
});
