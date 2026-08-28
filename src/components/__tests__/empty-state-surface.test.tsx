// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { EmptyStateSurface } from "@/components/empty-state-surface";


describe("EmptyStateSurface", () => {
  it("renders eyebrow, title, and description", () => {
    render(
      <EmptyStateSurface
        eyebrow="Getting started"
        title="No assets tracked yet"
        description="Add stablecoins to start monitoring."
      />,
    );
    expect(screen.getByText("Getting started")).toBeTruthy();
    expect(screen.getByText("No assets tracked yet")).toBeTruthy();
    expect(screen.getByText("Add stablecoins to start monitoring.")).toBeTruthy();
  });

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

  it("renders actions when provided", () => {
    render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="Empty"
        description="Nothing here."
        actions={<button type="button">Get started</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Get started" })).toBeTruthy();
  });

  it("renders footnote when provided", () => {
    render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="Empty"
        description="Nothing here."
        footnote="This is a footnote."
      />,
    );
    expect(screen.getByText("This is a footnote.")).toBeTruthy();
  });

  it("does not render footnote container when footnote is not provided", () => {
    const { container } = render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="Empty"
        description="Nothing here."
      />,
    );
    // Steps are rendered in an <ol>, footnote in a rounded div — verify no ol present
    expect(container.querySelector("ol")).toBeNull();
  });

  it("renders preview content when provided", () => {
    render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="Empty"
        description="Nothing here."
        preview={<div data-testid="preview-content">Chart preview</div>}
      />,
    );
    expect(screen.getByTestId("preview-content")).toBeTruthy();
  });

  it("does not render preview when not provided", () => {
    render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="Empty"
        description="Nothing here."
      />,
    );
    expect(screen.queryByTestId("preview-content")).toBeNull();
  });

  it("applies custom className to the section", () => {
    const { container } = render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="Empty"
        description="Nothing here."
        className="custom-test-class"
      />,
    );
    expect(container.querySelector(".custom-test-class")).not.toBeNull();
  });
});
