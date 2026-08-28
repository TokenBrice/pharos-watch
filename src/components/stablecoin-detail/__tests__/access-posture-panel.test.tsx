// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AccessPosturePanel } from "../access-posture-panel";
import type { StablecoinSafetyScoreV9AccessRow } from "@/lib/stablecoin-safety-score-v9-presentation";
import type { TransferReviewView } from "@/lib/transfer-review";

const rows: StablecoinSafetyScoreV9AccessRow[] = [
  { key: "transferRestriction", label: "Transfer restriction", value: "Restrictable" },
  { key: "freezeAuthority", label: "Freeze authority", value: "Issuer" },
];

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


describe("AccessPosturePanel", () => {
  it("renders the scored rows and nothing else when no transfer review exists", () => {
    render(<AccessPosturePanel rows={rows} compact />);

    expect(screen.getByText("Transfer restriction")).toBeTruthy();
    expect(screen.getByText("Restrictable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /How this was verified/ })).toBeNull();
  });

  it("renders nothing without scored rows", () => {
    const { container } = render(<AccessPosturePanel rows={[]} review={review} compact />);
    expect(container.firstChild).toBeNull();
  });

  it("folds the per-deployment citations behind the standard Sources disclosure", () => {
    render(<AccessPosturePanel rows={rows} review={review} compact />);

    fireEvent.click(screen.getByRole("button", { name: /How this was verified · 2 deployments/ }));
    expect(screen.getByText(/blocklist guarded by the issuer multisig/)).toBeTruthy();
    // Reviewed date now lives in the shared evidence footer, not a hand-rolled
    // mono micro-line (WS8.13).
    expect(screen.getByText("Reviewed 2026-07-15")).toBeTruthy();

    const sourcesToggle = screen.getByRole("button", { name: /Sources/ });
    expect(sourcesToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(sourcesToggle);

    // Chain attribution is preserved in the label because `EvidenceFooter` has
    // no per-item form.
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Ethereum · Contract source",
      "Base · Contract source",
    ]);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/etherscan");
  });
});
