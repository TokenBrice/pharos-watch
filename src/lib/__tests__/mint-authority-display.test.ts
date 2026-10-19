import { describe, expect, it } from "vitest";
import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import { resolveMintAuthorityStatus, resolveMintAuthorityScoreDisplay } from "../mint-authority-display";

function summary(overrides: Partial<MintAuthorityCoverageSummary> = {}): MintAuthorityCoverageSummary {
  return {
    mintPath: "permissioned-minter",
    authorityPosture: "bounded-admin",
    confidence: "verified",
    ...overrides,
  };
}

describe("resolveMintAuthorityStatus", () => {
  it.each(["manual-review", "unknown"] as const)("keeps unresolved native issuance Unknown at %s confidence", (confidence) => {
    const unresolved = summary({ mintPath: "unknown", authorityPosture: "unknown", confidence, controls: [] });
    expect(resolveMintAuthorityStatus(unresolved)).toMatchObject({ label: "Unknown", available: false });
    expect(resolveMintAuthorityStatus(unresolved).detail).not.toContain("Minting is user or protocol based");
  });

});

describe("operationally governed mint display", () => {
  it("shows the published55/59 Governed rung without describing immediate operation as delayed", () => {
    for (const score of [55, 59]) {
      const display = resolveMintAuthorityScoreDisplay({ score, posture: "unbounded-operationally-governed" });
      expect(display).toMatchObject({ score, bandKey: "governed", bandLabel: "Governed" });
      expect(display.detail).toContain("formula interest and activity-bound compensation can execute immediately");
      expect(display.detail).toContain("Economically unbounded.");
    }
    expect(resolveMintAuthorityScoreDisplay({ score: null, posture: "unbounded-operationally-governed" }).scoreLabel).toBe("NR");
  });
});
