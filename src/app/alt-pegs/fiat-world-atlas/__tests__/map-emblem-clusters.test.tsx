// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MapEmblemClusters } from "@/app/alt-pegs/fiat-world-atlas/map-emblem-clusters";
import type { PegEmblemCluster } from "@/lib/alt-peg-emblems";

function makeCluster(
  peg: string,
  emblemCount: number,
): PegEmblemCluster {
  const emblems = Array.from({ length: emblemCount }, (_, i) => ({
    id: `${peg.toLowerCase()}-${i}`,
    symbol: `${peg}${i}`,
    name: `${peg} coin ${i}`,
    logoSrc: `/logos/${peg.toLowerCase()}-${i}.png`,
  }));
  return {
    peg: peg as PegEmblemCluster["peg"],
    anchor: { x: 50, y: 50 },
    colorHex: "#8b5cf6",
    emblems,
  };
}

describe("MapEmblemClusters", () => {
  afterEach(() => cleanup());

  it("renders one pill per cluster", () => {
    const clusters = [
      makeCluster("EUR", 2),
      makeCluster("JPY", 1),
      makeCluster("GBP", 3),
    ];
    const { container } = render(<MapEmblemClusters clusters={clusters} />);

    const pills = container.querySelectorAll("li[data-peg]");
    expect(pills.length).toBe(3);
  });

  it("shows maxVisible logos and a +N badge when cluster has more emblems", () => {
    const clusters = [makeCluster("EUR", 5)];
    const { container, getByTestId } = render(
      <MapEmblemClusters clusters={clusters} maxVisible={3} />,
    );

    const pill = container.querySelector("li[data-peg='EUR']");
    expect(pill).not.toBeNull();
    const images = pill!.querySelectorAll("img");
    expect(images.length).toBe(3);

    const overflow = getByTestId("overflow-EUR");
    expect(overflow.textContent).toBe("+2");
  });

  it("wrapper has pointer-events-none so hover passes through to the map", () => {
    const clusters = [makeCluster("EUR", 1)];
    const { getByTestId } = render(
      <MapEmblemClusters clusters={clusters} />,
    );
    const wrapper = getByTestId("map-emblem-clusters");
    expect(wrapper.className).toContain("pointer-events-none");
  });
});
