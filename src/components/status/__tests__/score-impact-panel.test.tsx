// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoreImpactPanel } from "../score-impact-panel";
import { makeReserveComposition } from "@shared/types/__tests__/status.test-support";


describe("ScoreImpactPanel", () => {
  it("keeps missing reserve evidence unknown rather than clean or zero", () => {
    const { container } = render(
      <ScoreImpactPanel
        reserveComposition={makeReserveComposition({ status: "unavailable" })}
      />,
    );
    expect(screen.getByText("unavailable")).toBeTruthy();
    expect(screen.queryByText("clean")).toBeNull();
    expect(container.textContent).not.toContain("0.0%");
    expect(screen.getAllByText("Unknown")).toHaveLength(4);
  });
});
