// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { RailCopyFold } from "../rail-copy-fold";

function setHash(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  });
}

describe("RailCopyFold", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  it("folds the body by default while keeping title, chip, and content in the DOM", () => {
    const { container } = render(
      <RailCopyFold title="Bridging" chip={{ label: "Tier 2", toneClass: "text-amber-400" }}>
        <p>Route review prose.</p>
      </RailCopyFold>,
    );

    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(screen.getByText("Bridging")).toBeTruthy();
    expect(screen.getByText("Tier 2")).toBeTruthy();
    // Crawlable: folded, not unmounted.
    expect(screen.getByText("Route review prose.")).toBeTruthy();
  });

  it("carries no id or scroll margin when the band is not an anchor target", () => {
    const { container } = render(
      <RailCopyFold title="Bridging">
        <p>Route review prose.</p>
      </RailCopyFold>,
    );

    const details = container.querySelector("details");
    expect(details?.getAttribute("id")).toBeNull();
    expect(details?.className).not.toContain("scroll-mt");
  });

  it("opens on mount when the location hash already matches its id", () => {
    window.location.hash = "#mechanism-review";
    const { container } = render(
      <RailCopyFold title="Mechanism review" id="mechanism-review">
        <p>Reviewed evidence.</p>
      </RailCopyFold>,
    );

    const details = container.querySelector("details");
    expect(details?.getAttribute("id")).toBe("mechanism-review");
    expect(details?.className).toContain("scroll-mt");
    expect(details?.open).toBe(true);
  });

  it("opens on a later hashchange to its id and ignores other targets", () => {
    const { container } = render(
      <RailCopyFold title="Mechanism review" id="mechanism-review">
        <p>Reviewed evidence.</p>
      </RailCopyFold>,
    );
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);

    setHash("#reserve-quality");
    expect(details?.open).toBe(false);

    setHash("#mechanism-review");
    expect(details?.open).toBe(true);
  });
});
