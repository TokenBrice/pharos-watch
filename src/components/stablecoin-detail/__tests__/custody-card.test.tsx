// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { CustodyProfile, StablecoinMeta } from "@shared/types";
import { CustodyModule } from "../custody-card";
import {
  isCustodyStructureUndisclosed,
  projectCustodyClientSummary,
  type CustodyClientSummary,
} from "@/lib/stablecoin-detail-custody-client";

const BASE_PROFILE: CustodyProfile = {
  providers: [
    { name: "The Bank of New York Mellon", role: "custodian", jurisdiction: "United States" },
    { name: "Systemically important and other regulated banks (not individually disclosed)", role: "bank" },
  ],
  segregation: "segregated",
  bankruptcyRemoteness: "contractual-only",
  rehypothecation: "prohibited",
  reviewedAt: "2026-07-17",
  reviewer: "Reviewer",
  confidence: "verified",
  sources: [{ label: "Circle 10-K", url: "https://example.com/10k" }],
  uncertainty: "Bank-level split beyond BNY is not individually disclosed.",
};

function summaryFor(overrides: Partial<CustodyProfile> = {}): CustodyClientSummary {
  const summary = projectCustodyClientSummary({
    id: "test-coin",
    custodyProfile: { ...BASE_PROFILE, ...overrides },
  } as unknown as StablecoinMeta);
  expect(summary).not.toBeNull();
  return summary!;
}

function rungStates(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll("[data-rung]")).map((rung) => rung.getAttribute("data-rung-state"));
}

describe("CustodyModule", () => {
  it("renders nothing without a custody summary", () => {
    expect(render(<CustodyModule summary={null} variant="tile" />).container.innerHTML).toBe("");
    expect(render(<CustodyModule variant="tile" />).container.innerHTML).toBe("");
  });

  it("owns the #custody anchor as an h3 evidence module", () => {
    const { container } = render(<CustodyModule summary={summaryFor()} variant="tile" />);
    const section = container.querySelector("section#custody");
    expect(section?.getAttribute("data-evidence-module")).toBe("tile");
    expect(section?.querySelector("h3")).not.toBeNull();
  });

  it("draws no undisclosed bar for named custodians whose shares are not disclosed", () => {
    const { container } = render(
      <CustodyModule
        summary={summaryFor({
          providers: [
            { name: "Maerki Baumann & Co. AG", role: "custodian", jurisdiction: "Switzerland" },
            { name: "Ankura Trust Company LLC", role: "other", jurisdiction: "United States" },
          ],
          knownUnknownExposurePct: 100,
        })}
        variant="tile"
      />,
    );
    expect(container.querySelector("[data-custody-share-bar]")).toBeNull();
    expect(container.querySelector("[data-legend-kind='undisclosed']")).toBeNull();
    expect(container.querySelectorAll("[data-custody-provider]")).toHaveLength(2);
  });

  it("renders an unnamed holder as its full description, never as a provider chip or roster row", () => {
    const unnamed = BASE_PROFILE.providers[1]!.name;
    const { container } = render(<CustodyModule summary={summaryFor()} variant="tile" />);
    expect(container.querySelectorAll("[data-custody-provider]")).toHaveLength(1);
    const holders = Array.from(container.querySelectorAll("[data-custody-unnamed-holder]"));
    expect(holders).toHaveLength(1);
    expect(holders[0]!.textContent).toContain(unnamed);
    const roster = container.querySelector("ul[aria-label='All custody providers']");
    expect(roster?.children).toHaveLength(1);
    expect(roster?.textContent).not.toContain(unnamed);
  });

  it("draws a stacked share bar when shares are disclosed, with the undisclosed share labelled", () => {
    const { container } = render(
      <CustodyModule
        summary={summaryFor({
          providers: [
            { name: "UMB Bank, N.A.", role: "bank", sharePct: 97.9 },
            { name: "DEKA Bank", role: "bank" },
          ],
          knownUnknownExposurePct: 2.1,
        })}
        variant="tile"
      />,
    );
    const bar = container.querySelector("[data-custody-share-bar]");
    expect(bar?.getAttribute("role")).toBe("img");
    expect(bar?.getAttribute("aria-label")).toContain("UMB Bank, N.A.");
    expect(Array.from(bar!.querySelectorAll("[data-segment-kind]")).map((segment) => segment.getAttribute("data-segment-kind")))
      .toEqual(["provider", "undisclosed"]);
    expect(container.querySelector("[data-legend-kind='undisclosed']")?.textContent).toContain("2.1%");
  });

  it("lights, half-lights, fails and dashes the protection rungs from the reviewed enums", () => {
    expect(rungStates(render(<CustodyModule summary={summaryFor()} variant="tile" />).container)).toEqual([
      "met",
      "partial",
      "met",
    ]);
    // Unknown rehypothecation reads as unknown, never as a failed rung.
    expect(
      rungStates(
        render(<CustodyModule summary={summaryFor({ segregation: "omnibus", rehypothecation: "unknown" })} variant="tile" />)
          .container,
      ),
    ).toEqual(["failed", "partial", "unknown"]);
  });

  it("degrades an all-unknown structure with nobody named to the header and its provenance line", () => {
    const summary = summaryFor({
      providers: [{ name: "Reserve custodians and counterparties (not publicly identified)", role: "other" }],
      segregation: "unknown",
      bankruptcyRemoteness: "unknown",
      rehypothecation: "unknown",
      knownUnknownExposurePct: 100,
    });
    expect(isCustodyStructureUndisclosed(summary)).toBe(true);

    // The caller asks for a tile; the module still degrades to strip form.
    const { container } = render(<CustodyModule summary={summary} variant="tile" />);
    const section = container.querySelector("section#custody");
    expect(section?.getAttribute("data-evidence-module")).toBe("strip");
    expect(container.querySelector("[data-rung]")).toBeNull();
    expect(container.querySelector("[data-custody-share-bar]")).toBeNull();
    // The placeholder holder is neither a chip, a text line, nor a roster row.
    expect(container.querySelector("[data-custody-provider]")).toBeNull();
    expect(container.querySelector("[data-custody-unnamed-holder]")).toBeNull();
    expect(section?.textContent).not.toContain("not publicly identified");
    // The body is the one undisclosed line, with the provenance fold on its row.
    const line = section?.querySelector("[data-custody-undisclosed]");
    expect(line).not.toBeNull();
    const folds = Array.from(container.querySelectorAll("details"));
    expect(folds.map((fold) => fold.id)).toEqual(["custody-review-notes"]);
    expect(line?.parentElement?.contains(folds[0]!)).toBe(true);
    expect(container.textContent).toContain(BASE_PROFILE.reviewedAt);
  });

  it("keeps named custodians, without the meter, when no structure fact is established", () => {
    const { container } = render(
      <CustodyModule
        summary={summaryFor({ segregation: "unknown", bankruptcyRemoteness: "unknown", rehypothecation: "unknown" })}
        variant="tile"
        stripForm
      />,
    );
    expect(container.querySelector("[data-rung]")).toBeNull();
    expect(container.querySelectorAll("[data-custody-provider]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-custody-unnamed-holder]")).toHaveLength(1);
    // A named custodian is something to show: the undisclosed line is for nobody named.
    expect(container.querySelector("[data-custody-undisclosed]")).toBeNull();
  });

  it("folds the named roster, then review notes with sources, both closed", () => {
    const { container } = render(<CustodyModule summary={summaryFor()} variant="tile" />);
    const folds = Array.from(container.querySelectorAll("details"));
    expect(folds).toHaveLength(2);
    expect(folds.every((fold) => !fold.open)).toBe(true);
    const provenance = container.querySelector("details#custody-review-notes");
    expect(provenance).toBe(folds[1]);
    expect(provenance?.querySelector("a[href='https://example.com/10k']")).not.toBeNull();
    expect(provenance?.textContent).toContain(BASE_PROFILE.uncertainty);
    expect(folds[0]!.textContent).toContain(BASE_PROFILE.providers[0]!.name);
    expect(container.textContent).toContain(BASE_PROFILE.reviewedAt);
  });
});
