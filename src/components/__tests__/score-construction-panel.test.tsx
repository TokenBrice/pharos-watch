// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoreConstructionPanel } from "@/components/stablecoin-detail/score-construction-panel";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";

describe("ScoreConstructionPanel", () => {
  it("names the excluded pillar without manufacturing score stages", () => {
    const card = makeReportCardsV9PipelineGapCard("control", "B");
    const { container } = render(<ScoreConstructionPanel card={card} />);
    expect(container.textContent).toContain("The backing pillar, the exit pillar are left out of the score");
    expect(container.textContent).not.toContain("NR");
  });
  it("renders distinct adverse and uncertainty attribution messages", () => {
    const address = "0xa6fa4b5f76172d178d61b04b0ecd31909de037b6e";
    const card = makeV9Card();
    card.localCauseGaps = ["reserve-envelope"];
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
      cause: "C", causeGapRefs: [0],
    }];

    render(<ScoreConstructionPanel card={card} />);

    expect(screen.getByText(`Reviewed exposure ${address}`)).toBeTruthy();
    expect(screen.getByText(`Missing evidence for ${address}`)).toBeTruthy();
  });
});
