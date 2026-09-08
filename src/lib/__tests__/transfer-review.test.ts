import { describe, expect, it, vi } from "vitest";
import { buildTransferReviewView } from "../transfer-review";

vi.mock("@shared/data/safety-score-v9/transfer-review-overlays-v1.json", () => {
  const deployment = (chainId: string, scope: string, posture = "permissionless", evidence = "  Reviewed finding  ") => ({
    chainId, contractOrTokenId: `${chainId}-${scope}`, scope, posture, evidence,
    sources: [
      { label: "Contract", url: "https://example.com/contract" },
      { label: " ", url: "https://example.com/blank-label" },
      { label: "Blank URL", url: "\t" },
    ],
  });
  return { default: { reviews: {
    mixed: { assetId: "mixed", reviewedAt: "2026-05-01", deployments: [
      deployment("ethereum", "material-bridge", "restrictable"),
      deployment("ethereum", "canonical"),
      deployment("arbitrum", "material-bridge"),
      deployment("arbitrum", "canonical"),
    ] },
    sanitized: { assetId: "sanitized", reviewedAt: "2026-05-02", deployments: [
      deployment("new-chain", "new-scope", "new-posture"),
      deployment("ethereum", "canonical", "restrictable", " \n "),
    ] },
    blank: { assetId: "blank", reviewedAt: "2026-05-03", deployments: [
      deployment("ethereum", "canonical", "permissionless", "\t "),
    ] },
    empty: { assetId: "empty", reviewedAt: "2026-05-03" },
  } } };
});

describe("buildTransferReviewView", () => {
  it("orders canonical deployments first and chain names alphabetically within scope", () => {
    const view = buildTransferReviewView("mixed");
    expect(view?.deployments.map(({ key, scopeLabel, postureLabel, chainName }) =>
      [key, scopeLabel, postureLabel, chainName])).toEqual([
      ["arbitrum:arbitrum-canonical", "Canonical", "Permissionless", "Arbitrum"],
      ["ethereum:ethereum-canonical", "Canonical", "Permissionless", "Ethereum"],
      ["arbitrum:arbitrum-material-bridge", "Bridged", "Permissionless", "Arbitrum"],
      ["ethereum:ethereum-material-bridge", "Bridged", "Restrictable", "Ethereum"],
    ]);
    expect(view?.mixedPosture).toBe(true);
  });

  it("filters blank evidence and sources before computing posture, and labels unknown slugs", () => {
    expect(buildTransferReviewView("sanitized")).toEqual({
      reviewedAt: "2026-05-02",
      mixedPosture: false,
      deployments: [{
        key: "new-chain:new-chain-new-scope", chainId: "new-chain", chainName: "New Chain",
        scope: "new-scope", scopeLabel: "New Scope",
        posture: "new-posture", postureLabel: "New Posture", evidence: "Reviewed finding",
        sources: [{ label: "Contract", url: "https://example.com/contract" }],
      }],
    });
  });

  it.each(["blank", "empty", "unknown"])("returns null without usable review evidence: %s", (id) => {
    expect(buildTransferReviewView(id)).toBeNull();
  });
});
