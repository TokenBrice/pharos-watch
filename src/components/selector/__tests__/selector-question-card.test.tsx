// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SelectorQuestionCard } from "@/components/selector/selector-question-card";


describe("SelectorQuestionCard", () => {
  it("hides the action row when showActions is false", () => {
    render(
      <SelectorQuestionCard
        questionId="q2"
        step={2}
        totalSteps={5}
        legend="How long do you plan to hold this position?"
        options={[{ value: "lt24h", label: "Under 24h" }]}
        value="lt24h"
        onChange={vi.fn()}
        showActions={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByRole("button", { name: "See my shortlist" })).toBeNull();
  });
});
