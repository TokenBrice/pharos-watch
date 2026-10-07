// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AccessPosturePanel } from "../access-posture-panel";
import type { StablecoinSafetyScoreV9AccessRow } from "@/lib/stablecoin-safety-score-v9-presentation";
import type { TransferReviewView } from "@/lib/transfer-review";

const rows: StablecoinSafetyScoreV9AccessRow[] = [
  { key: "transferRestriction", label: "Transfer restriction", value: "Restrictable" },
  { key: "freezeAuthority", label: "Freeze authority", value: "Issuer" },
];

/** The four scored enums plus one reserve-access look-through diagnostic. */
const scoredRows: StablecoinSafetyScoreV9AccessRow[] = [
  { key: "transfer", label: "Transfer", value: "Restrictable" },
  { key: "freezeExposure", label: "Freeze exposure", value: "Direct" },
  { key: "primaryExit", label: "Primary exit", value: "Issuer redemption" },
  { key: "governance", label: "Governance", value: "Multisig" },
];
const diagnosticRow: StablecoinSafetyScoreV9AccessRow = {
  key: "reserve-access-unknown",
  label: "Unknown reserve-access remainder",
  value: "12.5%",
};

const review: TransferReviewView = {
  reviewedAt: "2026-07-15",
  mixedPosture: false,
  deployments: [
    {
      key: "ethereum:0xabc",
      chainId: "ethereum",
      chainName: "Ethereum",
      scope: "canonical",
      scopeLabel: "Canonical",
      posture: "restrictable",
      postureLabel: "Restrictable",
      evidence: "The token contract exposes a blocklist guarded by the issuer multisig.",
      sources: [{ label: "Contract source", url: "https://example.com/etherscan" }],
    },
    {
      key: "base:0xdef",
      chainId: "base",
      chainName: "Base",
      scope: "material-bridge",
      scopeLabel: "Bridged",
      posture: "restrictable",
      postureLabel: "Restrictable",
      evidence: "Bridged copy mirrors the canonical blocklist.",
      // Deliberately the same URL and label as Ethereum's: a shared registry
      // page cited by two deployments must not collapse into one row.
      sources: [{ label: "Contract source", url: "https://example.com/etherscan" }],
    },
  ],
};

function openSourcesFold(): HTMLDetailsElement {
  const summary = screen.getByText(/Sources/).closest("summary");
  const fold = summary?.parentElement;
  if (!summary || !(fold instanceof HTMLDetailsElement)) throw new Error("no Sources fold");
  expect(fold.open).toBe(false);
  fireEvent.click(summary);
  return fold;
}

describe("AccessPosturePanel", () => {
  it("renders the scored rows and nothing else when no transfer review exists", () => {
    render(<AccessPosturePanel rows={rows} compact />);

    expect(screen.getByText("Transfer restriction")).toBeTruthy();
    expect(screen.getByText("Restrictable")).toBeTruthy();
    expect(document.querySelector("details")).toBeNull();
  });

  it("renders nothing without scored rows, in either variant", () => {
    expect(render(<AccessPosturePanel rows={[]} review={review} compact />).container.firstChild).toBeNull();
    expect(render(<AccessPosturePanel rows={[]} review={review} variant="strip" />).container.firstChild).toBeNull();
  });

  it("folds the rail's per-deployment citations behind a Sources fold that opens", () => {
    render(<AccessPosturePanel rows={rows} review={review} variant="rail" />);

    const verification = screen.getByText(/2 deployments/).closest("details");
    expect(verification?.open).toBe(false);
    expect(verification?.contains(screen.getByText(/blocklist guarded by the issuer multisig/))).toBe(true);
    expect(screen.getByText(/2026-07-15/)).toBeTruthy();

    const fold = openSourcesFold();
    expect(fold.open).toBe(true);

    // Chain attribution is preserved in the label because `EvidenceFooter` has
    // no per-item form, so two deployments citing one page stay two rows.
    const links = within(fold).getAllByRole("link", { hidden: true });
    expect(links).toHaveLength(2);
    expect(links[0]?.textContent).toContain("Ethereum");
    expect(links[1]?.textContent).toContain("Base");
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/etherscan");
  });

  it("keeps the legacy compact flag on the rail form", () => {
    const { container } = render(<AccessPosturePanel rows={rows} compact />);

    expect(container.querySelector("[data-evidence-module]")).toBeNull();
  });

  it("draws the strip as one evidence module with all four scored enums as labelled cells", () => {
    const { container } = render(
      <AccessPosturePanel rows={[...scoredRows, diagnosticRow]} review={review} variant="strip" />,
    );

    const strip = container.querySelector("section[data-evidence-module='strip']");
    expect(strip).not.toBeNull();
    expect(strip?.querySelector("h3")).not.toBeNull();

    const cells = screen.getByRole("group", { name: /access/i });
    for (const row of scoredRows) {
      expect(within(cells).getByText(row.label)).toBeTruthy();
      expect(within(cells).getByText(row.value)).toBeTruthy();
    }

    // Look-through diagnostics are not scored enums: they fold, off the row.
    const diagnostic = screen.getByText(diagnosticRow.label);
    expect(cells.contains(diagnostic)).toBe(false);
    expect(diagnostic.closest("details")?.open).toBe(false);
  });

  it("orders the strip's folds diagnostics → verification → sources, with the review date outside them", () => {
    render(<AccessPosturePanel rows={[...scoredRows, diagnosticRow]} review={review} variant="strip" />);

    const summaries = Array.from(document.querySelectorAll("summary")).map((summary) => summary.textContent ?? "");
    expect(summaries).toHaveLength(3);
    expect(summaries[0]).toMatch(/diagnostic/i);
    expect(summaries[1]).toMatch(/2 deployments/);
    expect(summaries[2]).toMatch(/Sources/);

    expect(screen.getByText(/2026-07-15/).closest("details")).toBeNull();
  });

  it("opens the strip's Sources fold onto the deduplicated per-chain citations", () => {
    render(<AccessPosturePanel rows={scoredRows} review={review} variant="strip" />);

    const fold = openSourcesFold();
    expect(fold.open).toBe(true);
    expect(within(fold).getAllByRole("link", { hidden: true })).toHaveLength(2);
  });

  it("flags mixed per-chain posture on the strip", () => {
    const { rerender } = render(<AccessPosturePanel rows={scoredRows} review={review} variant="strip" />);
    const chipsWithout = document.querySelectorAll("section [data-slot='badge']").length;

    rerender(<AccessPosturePanel rows={scoredRows} review={{ ...review, mixedPosture: true }} variant="strip" />);
    expect(document.querySelectorAll("section [data-slot='badge']").length).toBe(chipsWithout + 1);
  });
});
