// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";

afterEach(cleanup);

describe("WorldMap", () => {
  it("renders country paths with the peg fill for tracked fiats", () => {
    const { container } = render(
      <WorldMap
        items={[
          { peg: "EUR", colorHex: "#8b5cf6" } as never,
          { peg: "JPY", colorHex: "#f43f5e" } as never,
        ]}
      />,
    );

    expect(container.querySelector("path#DE")).not.toBeNull();
    expect(container.querySelector("path#JP")).not.toBeNull();

    const styleBlock = container.querySelector("style")?.textContent ?? "";
    expect(styleBlock).toContain("path#DE{fill:#8b5cf6");
    expect(styleBlock).toContain("path#FR{fill:#8b5cf6");
    expect(styleBlock).toContain("path#JP{fill:#f43f5e");
    expect(styleBlock).not.toContain("path#US{fill:");
  });
});
