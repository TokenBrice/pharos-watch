// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoreConstructionPanel } from "@/components/stablecoin-detail/score-construction-panel";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";

describe("ScoreConstructionPanel", () => {
  it("allows unbroken identifiers to wrap in every attribution group", () => {
    const address = "0xa6fa4b5f76172d178d61b04b0ecd31909de037b6e";
    const card = makeV9Card();
    card.scoreTrace.adverseAttribution.items = [{
      source: "structural-signal",
      path: "deployment:polygon",
      message: `Reviewed exposure ${address}`,
      responsibility: "measured-adverse",
    }];
    card.scoreTrace.boundedUncertaintyAttribution.items = [{
      source: "reason",
      code: "missing-reserve-composition",
      path: "backing:reserve-envelope",
      message: `Missing evidence for ${address}`,
      responsibility: "issuer-undisclosed",
    }];

    render(<ScoreConstructionPanel card={card} compact />);

    expect(screen.getByText(`Reviewed exposure ${address}`).className).toContain("[overflow-wrap:anywhere]");
    expect(screen.getByText(`Missing evidence for ${address}`).className).toContain("[overflow-wrap:anywhere]");
  });
});
