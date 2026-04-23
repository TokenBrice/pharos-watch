// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorldMapInteractive,
  type CountryInfo,
} from "@/app/alt-pegs/fiat-world-atlas/world-map-interactive";

const euroInfo: CountryInfo = {
  peg: "EUR",
  label: "Euro",
  coinCount: 13,
  symbolPreview: "EURC · EURCV · AEUR",
};

const yenInfo: CountryInfo = {
  peg: "JPY",
  label: "Yen",
  coinCount: 1,
  symbolPreview: "JPYC",
};

function MockMap() {
  return (
    <svg data-testid="mock-svg">
      <path id="DE" data-testid="path-DE" />
      <path id="JP" data-testid="path-JP" />
      <path id="KZ" data-testid="path-KZ" />
    </svg>
  );
}

describe("WorldMapInteractive", () => {
  afterEach(() => cleanup());

  it("shows a tooltip with peg info when hovering a tracked country", () => {
    const { getByTestId, getByRole } = render(
      <WorldMapInteractive countryInfo={{ DE: euroInfo, JP: yenInfo }}>
        <MockMap />
      </WorldMapInteractive>,
    );

    fireEvent.mouseMove(getByTestId("path-DE"), {
      clientX: 100,
      clientY: 100,
    });

    const tooltip = getByRole("tooltip");
    expect(tooltip.textContent).toContain("Euro");
    expect(tooltip.textContent).toContain("13 coins");
    expect(tooltip.textContent).toContain("EURC · EURCV · AEUR");
    expect(tooltip.getAttribute("data-peg")).toBe("EUR");
  });

  it("uses singular 'coin' when coinCount is 1", () => {
    const { getByTestId, getByRole } = render(
      <WorldMapInteractive countryInfo={{ JP: yenInfo }}>
        <MockMap />
      </WorldMapInteractive>,
    );

    fireEvent.mouseMove(getByTestId("path-JP"), {
      clientX: 50,
      clientY: 50,
    });

    const tooltip = getByRole("tooltip");
    expect(tooltip.textContent).toContain("1 coin ·");
    expect(tooltip.textContent).not.toContain("1 coins");
  });

  it("clears the tooltip on mouse leave", () => {
    const { getByTestId, queryByRole } = render(
      <WorldMapInteractive countryInfo={{ DE: euroInfo }}>
        <MockMap />
      </WorldMapInteractive>,
    );

    fireEvent.mouseMove(getByTestId("path-DE"), {
      clientX: 100,
      clientY: 100,
    });
    expect(queryByRole("tooltip")).not.toBeNull();

    fireEvent.mouseLeave(getByTestId("world-map-interactive"));
    expect(queryByRole("tooltip")).toBeNull();
  });

  it("does not show a tooltip when hovering an untracked country", () => {
    const { getByTestId, queryByRole } = render(
      <WorldMapInteractive countryInfo={{ DE: euroInfo }}>
        <MockMap />
      </WorldMapInteractive>,
    );

    fireEvent.mouseMove(getByTestId("path-KZ"), {
      clientX: 100,
      clientY: 100,
    });

    expect(queryByRole("tooltip")).toBeNull();
  });

  it("marks tracked paths with data-tracked after mount", () => {
    const { getByTestId } = render(
      <WorldMapInteractive countryInfo={{ DE: euroInfo, JP: yenInfo }}>
        <MockMap />
      </WorldMapInteractive>,
    );

    expect(getByTestId("path-DE").getAttribute("data-tracked")).toBe("true");
    expect(getByTestId("path-JP").getAttribute("data-tracked")).toBe("true");
    expect(getByTestId("path-KZ").getAttribute("data-tracked")).toBeNull();
  });
});
