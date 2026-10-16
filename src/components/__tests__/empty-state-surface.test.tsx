// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { EmptyStateSurface } from "@/components/empty-state-surface";


describe("EmptyStateSurface", () => {
  it("renders steps when provided", () => {
    const steps = [
      { title: "Step one", description: "Do the first thing." },
      { title: "Step two", description: "Do the second thing." },
    ];
    render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="How it works"
        description="Follow these steps."
        steps={steps}
      />,
    );
    expect(screen.getByText("Step one")).toBeTruthy();
    expect(screen.getByText("Do the first thing.")).toBeTruthy();
    expect(screen.getByText("Step two")).toBeTruthy();
  });

  it("does not render steps list when no steps provided", () => {
    render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="Empty"
        description="Nothing here."
      />,
    );
    expect(screen.queryByRole("list")).toBeNull();
  });
});
