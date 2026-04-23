// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HoverProvider, useHoverState } from "@/app/alt-pegs/fiat-world-atlas/hover-context";

declare global {
  // eslint-disable-next-line no-var
  var __probe: ReturnType<typeof useHoverState>;
}

function Probe() {
  const state = useHoverState();
  globalThis.__probe = state;
  return null;
}

describe("HoverProvider", () => {
  afterEach(() => cleanup());

  it("defaults to no hover", () => {
    render(
      <HoverProvider>
        <Probe />
      </HoverProvider>,
    );
    expect(globalThis.__probe.hoveredCoinId).toBeNull();
    expect(globalThis.__probe.hoveredPeg).toBeNull();
    expect(globalThis.__probe.isHovered("any")).toBe(false);
    expect(globalThis.__probe.isSibling({ id: "x", pegCurrency: "EUR" })).toBe(false);
    expect(globalThis.__probe.isDimmed({ id: "x", pegCurrency: "EUR" })).toBe(false);
  });

  it("marks siblings when a coin is hovered and dims others", () => {
    render(
      <HoverProvider>
        <Probe />
      </HoverProvider>,
    );
    act(() => {
      globalThis.__probe.setHoveredCoin({ id: "eurc", pegCurrency: "EUR" });
    });
    expect(globalThis.__probe.hoveredCoinId).toBe("eurc");
    expect(globalThis.__probe.hoveredPeg).toBe("EUR");
    expect(globalThis.__probe.isHovered("eurc")).toBe(true);
    expect(globalThis.__probe.isSibling({ id: "eurs", pegCurrency: "EUR" })).toBe(true);
    expect(globalThis.__probe.isSibling({ id: "eurc", pegCurrency: "EUR" })).toBe(false);
    expect(globalThis.__probe.isDimmed({ id: "xaut", pegCurrency: "GOLD" })).toBe(true);
    expect(globalThis.__probe.isDimmed({ id: "eurs", pegCurrency: "EUR" })).toBe(false);
  });

  it("clears state when setHoveredCoin is called with null", () => {
    render(
      <HoverProvider>
        <Probe />
      </HoverProvider>,
    );
    act(() => globalThis.__probe.setHoveredCoin({ id: "eurc", pegCurrency: "EUR" }));
    expect(globalThis.__probe.hoveredCoinId).toBe("eurc");
    act(() => globalThis.__probe.setHoveredCoin(null));
    expect(globalThis.__probe.hoveredCoinId).toBeNull();
    expect(globalThis.__probe.hoveredPeg).toBeNull();
  });

  it("returns a safe no-op fallback when used outside a provider", () => {
    render(<Probe />);
    expect(globalThis.__probe.hoveredCoinId).toBeNull();
    expect(globalThis.__probe.isHovered("any")).toBe(false);
  });
});
