// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VerdictPill } from "../verdict-pill";
import type { StablecoinVerdictArchetype } from "@shared/lib/stablecoin-verdict";

afterEach(cleanup);

const LABELED_ARCHETYPES: { archetype: StablecoinVerdictArchetype; label: string }[] = [
  { archetype: "pre-launch", label: "Pre-Launch" },
  { archetype: "frozen-archive", label: "Frozen Archive" },
  { archetype: "distressed", label: "Distressed" },
  { archetype: "low-safety-score", label: "Low Safety Score" },
  { archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" },
  { archetype: "decentralized-benchmark", label: "Decentralized Benchmark" },
  { archetype: "institutional-default", label: "Institutional Default" },
];

describe("VerdictPill", () => {
  for (const { archetype, label } of LABELED_ARCHETYPES) {
    it(`renders a label for archetype "${archetype}"`, () => {
      const { container } = render(<VerdictPill verdict={{ archetype, label }} />);
      const pill = container.querySelector(`[data-archetype="${archetype}"]`);
      expect(pill).not.toBeNull();
      expect(pill?.textContent).toBe(label);
    });
  }

  it.each([
    ["distressed", "alert", "text-red"] as const,
    ["low-safety-score", "watch", "text-amber"] as const,
  ])("tones %s as %s", (archetype, _tone, expectedClassFragment) => {
    // Red is reserved for measured distress; a low grade renders amber.
    const { container } = render(
      <VerdictPill verdict={{ archetype, label: archetype }} />,
    );
    const pill = container.querySelector(`[data-archetype="${archetype}"]`);
    expect(pill?.getAttribute("class")).toContain(expectedClassFragment);
  });

  it("renders nothing for the uncategorized archetype", () => {
    const { container } = render(
      <VerdictPill verdict={{ archetype: "uncategorized", label: "Uncategorized" }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("propagates the optional id onto the rendered span", () => {
    const { container } = render(
      <VerdictPill
        id="hero-verdict-test"
        verdict={{ archetype: "institutional-default", label: "Institutional Default" }}
      />,
    );
    expect(container.querySelector("#hero-verdict-test")).not.toBeNull();
  });
});
