// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import { useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import { makePlacedCoin, renderAtlas } from "./atlas.test-support";

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
    const coins = [makePlacedCoin({ id: "a" }), makePlacedCoin({ id: "b", x: 60, y: 25 })];
    const { container } = renderAtlas(<><CohortThreads coins={coins} colorHex="#60a5fa" /></>);
    expect(container.querySelectorAll("line").length).toBe(0);
  });

  it("connects only same-peg peers and updates or removes connections with hover", () => {
    const { getHoverHandle, setHoverHandle } = makeHandleCapture();
    const coins = [
      makePlacedCoin({ id: "a" }),
      makePlacedCoin({ id: "b", x: 60, y: 25 }),
      makePlacedCoin({ id: "c", x: 40, y: 25 }),
      makePlacedCoin({ id: "d", pegCurrency: "JPY", x: 80, y: 30 }),
    ];
    const { container } = renderAtlas(<><Grabber onState={setHoverHandle} />
    <CohortThreads coins={coins} colorHex="#60a5fa" /></>);
    act(() => {
      getHoverHandle().setHoveredCoin({ id: "a", pegCurrency: "EUR" });
    });
    const endpoints = () => Array.from(container.querySelectorAll("line"), (line) =>
      ["x1", "y1", "x2", "y2"].map((attribute) => Number(line.getAttribute(attribute))),
    ).sort((a, b) => a[2] - b[2]);
    expect(endpoints()).toEqual([[50, 20, 40, 25], [50, 20, 60, 25]]);
    act(() => getHoverHandle().setHoveredCoin({ id: "b", pegCurrency: "EUR" }));
    expect(endpoints()).toEqual([[60, 25, 40, 25], [60, 25, 50, 20]]);
    act(() => getHoverHandle().setHoveredCoin(null));
    expect(endpoints()).toEqual([]);
    act(() => getHoverHandle().setHoveredCoin({ id: "d", pegCurrency: "JPY" }));
    expect(endpoints()).toEqual([]);
  });

  it("renders nothing when the hovered coin is not in this layer", () => {
    const { getHoverHandle, setHoverHandle } = makeHandleCapture();
    const coins = [makePlacedCoin({ id: "a" }), makePlacedCoin({ id: "b", x: 60, y: 25 })];
    const { container } = renderAtlas(<><Grabber onState={setHoverHandle} />
    <CohortThreads coins={coins} colorHex="#60a5fa" /></>);
    act(() => {
      getHoverHandle().setHoveredCoin({ id: "xaut", pegCurrency: "GOLD" });
    });
    expect(container.querySelectorAll("line").length).toBe(0);
  });
});
