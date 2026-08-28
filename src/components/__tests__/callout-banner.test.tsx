// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CalloutBanner } from "@/components/callout-banner";


describe("CalloutBanner", () => {
  it("renders children text", () => {
    render(<CalloutBanner>Important notice here.</CalloutBanner>);
    expect(screen.getByText("Important notice here.")).toBeTruthy();
  });

  it("has role=note for accessibility", () => {
    render(<CalloutBanner>Some message.</CalloutBanner>);
    expect(screen.getByRole("note")).toBeTruthy();
  });

  it("renders icon when provided", () => {
    render(
      <CalloutBanner icon={<span data-testid="icon-el">!</span>}>
        With icon.
      </CalloutBanner>,
    );
    expect(screen.getByTestId("icon-el")).toBeTruthy();
    expect(screen.getByText("With icon.")).toBeTruthy();
  });

  it("renders without icon wrapper when no icon provided", () => {
    const { container } = render(<CalloutBanner>No icon.</CalloutBanner>);
    // The icon wrapper span with mt-0.5 class only appears when icon is truthy
    const iconWrappers = container.querySelectorAll("span.mt-0\\.5");
    expect(iconWrappers.length).toBe(0);
  });

  it("applies custom className", () => {
    const { container } = render(
      <CalloutBanner className="custom-banner-class">Text.</CalloutBanner>,
    );
    expect(container.querySelector(".custom-banner-class")).not.toBeNull();
  });
});
