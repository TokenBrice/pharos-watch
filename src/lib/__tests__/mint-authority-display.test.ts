import { describe, expect, it } from "vitest";
import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import { resolveMintAuthorityStatusKind, resolveMintAuthorityScoreDisplay } from "../mint-authority-display";

function summary(overrides: Partial<MintAuthorityCoverageSummary> = {}): MintAuthorityCoverageSummary {
  return {
    mintPath: "permissioned-minter",
    authorityPosture: "bounded-admin",
    confidence: "verified",
    ...overrides,
  };
}

describe("resolveMintAuthorityStatusKind", () => {
  it("pins every status branch and precedence edge", () => {
    expect(resolveMintAuthorityStatusKind(null)).toBe("unknown");
    expect(
      resolveMintAuthorityStatusKind(
        summary({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "none-resolved",
        }),
      ),
    ).toBe("inherited-authority");
    expect(
      resolveMintAuthorityStatusKind(
        summary({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
        }),
      ),
    ).toBe("no-privileged-mint");
    expect(
      resolveMintAuthorityStatusKind(
        summary({
          mintPath: "bridge-or-oft-synthetic",
          controls: [{ authorityType: "safe", directMintAbility: "direct" }],
        }),
      ),
    ).toBe("bridge-mint");
    expect(
      resolveMintAuthorityStatusKind(
        summary({
          mintPath: "issuer-direct-mint",
          controls: [{ authorityType: "safe", directMintAbility: "can-authorize" }],
        }),
      ),
    ).toBe("multisig-mint");
    expect(resolveMintAuthorityStatusKind(summary({ mintPath: "offchain-attested-minter" }))).toBe(
      "issuer-or-backend-mint",
    );
    expect(
      resolveMintAuthorityStatusKind(
        summary({
          controls: [{ authorityType: "eoa", directMintAbility: "direct" }],
        }),
      ),
    ).toBe("issuer-or-backend-mint");
    expect(resolveMintAuthorityStatusKind(summary())).toBe("governed-mint");
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
