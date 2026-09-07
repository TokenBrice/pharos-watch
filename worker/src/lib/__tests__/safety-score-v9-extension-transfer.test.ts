import { describe, expect, it } from "vitest";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import {
  resolveSafetyScoreV9ReviewedTransferFact,
  safetyScoreV9TransferDeploymentKey,
  type SafetyScoreV9ReviewedTransferFact,
  type SafetyScoreV9TransferMaterialScope,
} from "../safety-score-v9/extension-transfer";

const CLOCK_SEC = Date.parse("2026-08-10T00:00:00.000Z") / 1_000;

function review(
  deployments: { chainId: string; contractOrTokenId: string; posture: "permissionless" | "restrictable" }[],
  reviewedAt = "2026-08-08",
): SafetyScoreV9ReviewedTransferFact {
  return {
    assetId: "alpha",
    reviewedAt,
    reviewer: "test",
    deployments: deployments.map((deployment) => ({
      ...deployment,
      scope: "canonical" as const,
      evidence: "Reviewed against the chain's primary asset documentation.",
      sources: [{ label: "Docs", url: "https://example.test/asset" }],
    })),
  };
}

function scope(overrides: Partial<SafetyScoreV9TransferMaterialScope> = {}): SafetyScoreV9TransferMaterialScope {
  return {
    authoritativeDeploymentKeys: [],
    materialDeploymentKeys: [],
    materialDeploymentScopeComplete: false,
    deploymentModel: "non-contract-native",
    ...overrides,
  };
}

describe("resolveSafetyScoreV9ReviewedTransferFact — non-contract-native applicability", () => {
  // Owner ruling 2026-08-10. The scope test proves a review covers every
  // material *contract* deployment, so a chain-native asset that can never have
  // `contracts[]` rows stayed bounded-unknown forever and published as
  // `missing-access-review` — "we never looked" — with a complete current
  // primary-sourced review on file.
  it("publishes the curated posture with an explicit applicability basis", () => {
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([{ chainId: "zano", contractOrTokenId: "86143388bd05", posture: "permissionless" }]),
      CLOCK_SEC,
      scope(),
    );
    expect(resolved).toEqual({
      observationState: "known",
      posture: "permissionless",
      structuralDisposition: "non-contract-native",
    });
  });

  it("still reduces to the most restrictive reviewed deployment", () => {
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([
        { chainId: "zephyr", contractOrTokenId: "ZEPHUSD", posture: "permissionless" },
        { chainId: "zephyr", contractOrTokenId: "ZEPHRSV", posture: "restrictable" },
      ]),
      CLOCK_SEC,
      scope(),
    );
    expect(resolved.posture).toBe("restrictable");
  });

  it("refuses a review that touches a contract-addressable chain", () => {
    // A supported-chain deployment is measurable by the scope machinery, so an
    // incomplete scope there is a curation gap, never a structural fact.
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([{ chainId: "gnosis", contractOrTokenId: "0xabc", posture: "permissionless" }]),
      CLOCK_SEC,
      scope(),
    );
    expect(resolved).toEqual({ observationState: "bounded-unknown", posture: null });
  });

  it("refuses an asset whose supply or contracts remain contract-addressable", () => {
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([{ chainId: "zano", contractOrTokenId: "86143388bd05", posture: "permissionless" }]),
      CLOCK_SEC,
      scope({ deploymentModel: "contract-addressable" }),
    );
    expect(resolved).toEqual({ observationState: "bounded-unknown", posture: null });
  });

  it("keeps a stale review stale", () => {
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([{ chainId: "zano", contractOrTokenId: "86143388bd05", posture: "permissionless" }], "2024-01-01"),
      CLOCK_SEC,
      scope(),
    );
    expect(CLOCK_SEC - Date.parse("2024-01-01T00:00:00.000Z") / 1_000).toBeGreaterThan(
      V9_ACCESS_EVIDENCE_MAX_AGE_SEC,
    );
    expect(resolved).toEqual({ observationState: "stale", posture: null });
  });

  it("leaves the complete contract-addressable path unchanged", () => {
    const deploymentKey = safetyScoreV9TransferDeploymentKey("ethereum", "0xABC");
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([{ chainId: "ethereum", contractOrTokenId: "0xABC", posture: "restrictable" }]),
      CLOCK_SEC,
      scope({
        authoritativeDeploymentKeys: [deploymentKey],
        materialDeploymentKeys: [deploymentKey],
        materialDeploymentScopeComplete: true,
        deploymentModel: "contract-addressable",
      }),
    );
    expect(resolved).toEqual({ observationState: "known", posture: "restrictable" });
  });
});
