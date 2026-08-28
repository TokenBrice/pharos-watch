// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { HoverProvider, useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";

type HoverState = ReturnType<typeof useHoverState>;

function Probe({ onState }: { onState: (state: HoverState) => void }) {
  const state = useHoverState();
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return null;
}

describe("HoverProvider", () => {

  function renderProbe(withProvider = true) {
    let probe: HoverState | null = null;
    const setProbe = (state: HoverState) => {
      probe = state;
    };
    const getProbe = () => {
      if (!probe) throw new Error("Hover probe was not captured");
      return probe;
    };

    render(withProvider ? (
      <HoverProvider>
        <Probe onState={setProbe} />
      </HoverProvider>
    ) : (
      <Probe onState={setProbe} />
    ));

    return getProbe;
  }

  it("defaults to no hover", () => {
    const probe = renderProbe()();
    expect(probe.hoveredCoinId).toBeNull();
    expect(probe.hoveredPeg).toBeNull();
    expect(probe.isHovered("any")).toBe(false);
    expect(probe.isSibling({ id: "x", pegCurrency: "EUR" })).toBe(false);
    expect(probe.isDimmed({ id: "x", pegCurrency: "EUR" })).toBe(false);
  });

  it("marks siblings when a coin is hovered and dims others", () => {
    const getProbe = renderProbe();
    act(() => {
      getProbe().setHoveredCoin({ id: "eurc", pegCurrency: "EUR" });
    });
    const probe = getProbe();
    expect(probe.hoveredCoinId).toBe("eurc");
    expect(probe.hoveredPeg).toBe("EUR");
    expect(probe.isHovered("eurc")).toBe(true);
    expect(probe.isSibling({ id: "eurs", pegCurrency: "EUR" })).toBe(true);
    expect(probe.isSibling({ id: "eurc", pegCurrency: "EUR" })).toBe(false);
    expect(probe.isDimmed({ id: "xaut", pegCurrency: "GOLD" })).toBe(true);
    expect(probe.isDimmed({ id: "eurs", pegCurrency: "EUR" })).toBe(false);
  });

  it("clears state when setHoveredCoin is called with null", () => {
    const getProbe = renderProbe();
    act(() => getProbe().setHoveredCoin({ id: "eurc", pegCurrency: "EUR" }));
    expect(getProbe().hoveredCoinId).toBe("eurc");
    act(() => getProbe().setHoveredCoin(null));
    expect(getProbe().hoveredCoinId).toBeNull();
    expect(getProbe().hoveredPeg).toBeNull();
  });

  it("returns a safe no-op fallback when used outside a provider", () => {
    const probe = renderProbe(false)();
    expect(probe.hoveredCoinId).toBeNull();
    expect(probe.isHovered("any")).toBe(false);
  });
});
