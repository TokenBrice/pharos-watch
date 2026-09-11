// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerdictPill } from "../verdict-pill";
import { SEVERITY_TONE_CLASS, type SeverityTone } from "@/lib/severity-tone";
import type { StablecoinVerdictArchetype } from "@shared/lib/stablecoin-verdict";

/**
 * Every categorized archetype and the severity ramp it publishes. Red is
 * reserved for measured distress: a low grade measures our evidence and
 * scoring, so it renders amber.
 */
const TONED_ARCHETYPES: [StablecoinVerdictArchetype, SeverityTone][] = [
  ["pre-launch", "info"],
  ["quarantined-record", "watch"],
  ["delisted-record", "neutral"],
  ["frozen-archive", "neutral"],
  ["distressed", "alert"],
  ["low-safety-score", "watch"],
  ["yield-bearing-hybrid", "ok"],
  ["decentralized-benchmark", "ok"],
  ["institutional-default", "ok"],
];

describe("VerdictPill", () => {
  it.each(TONED_ARCHETYPES)("tones the %s archetype with the %s pill", (archetype, tone) => {
    // An arbitrary label, so this proves authored copy passes through rather
    // than echoing a per-archetype fixture string.
    const { container } = render(<VerdictPill verdict={{ archetype, label: "Verdict Copy" }} />);

    const pill = container.querySelector(`[data-archetype="${archetype}"]`);
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("Verdict Copy");
    expect(pill?.getAttribute("class")).toContain(SEVERITY_TONE_CLASS[tone].pill);
  });

  it("renders nothing for the uncategorized archetype", () => {
    const { container } = render(
      <VerdictPill verdict={{ archetype: "uncategorized", label: "Uncategorized" }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
