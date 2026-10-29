import { describe, expect, it } from "vitest";
import type { MintAuthorityCoverageSummary } from "../../../types/stablecoin-client-meta";
import { resolveMintAuthorityStatusKind } from "../mint-authority";

function summary(overrides: Partial<MintAuthorityCoverageSummary> = {}): MintAuthorityCoverageSummary {
  return {
    mintPath: "permissioned-minter",
    authorityPosture: "bounded-admin",
    confidence: "verified",
    ...overrides,
  };
}

describe("resolveMintAuthorityStatusKind", () => {
  it.each(["manual-review", "unknown", "verified"] as const)(
    "keeps unresolved native issuance Unknown at %s confidence despite competing controls",
    (confidence) => {
      expect(resolveMintAuthorityStatusKind(summary({
        mintPath: "unknown", authorityPosture: "unknown", confidence,
        controls: [{ authorityType: "safe", directMintAbility: "direct" }],
      }))).toBe("unknown");
    },
  );

  it("pins every status branch and precedence edge", () => {
    expect(resolveMintAuthorityStatusKind(null)).toBe("unknown");
    expect(resolveMintAuthorityStatusKind(undefined)).toBe("unknown");
    expect(resolveMintAuthorityStatusKind(summary({
      mintPath: "wrapped-or-variant-inherited", authorityPosture: "none-resolved",
      controls: [{ authorityType: "safe", directMintAbility: "direct" }],
    }))).toBe("inherited-authority");
    for (const authorityPosture of ["none-resolved", "none-resolved-mint"] as const) {
      expect(resolveMintAuthorityStatusKind(summary({
        mintPath: "immutable-user-collateralized", authorityPosture,
      }))).toBe("no-privileged-mint");
    }
    expect(resolveMintAuthorityStatusKind(summary({
      mintPath: "bridge-or-oft-synthetic",
      controls: [{ authorityType: "safe", directMintAbility: "direct" }],
    }))).toBe("bridge-mint");
    for (const authorityType of ["safe", "multisig"] as const) {
      expect(resolveMintAuthorityStatusKind(summary({
        mintPath: "issuer-direct-mint",
        controls: [{ authorityType, directMintAbility: "can-authorize" }],
      }))).toBe("multisig-mint");
      expect(resolveMintAuthorityStatusKind(summary({
        controls: [{ authorityType, directMintAbility: "none" }],
      }))).toBe("governed-mint");
      expect(resolveMintAuthorityStatusKind(summary({
        mintPath: "user-collateralized-governed",
        controls: [{ authorityType, directMintAbility: "parameter-only" }],
      }))).toBe("governed-mint");
      expect(resolveMintAuthorityStatusKind(summary({
        mintPath: "user-collateralized-governed",
        controls: [{ authorityType, directMintAbility: "parameter-only", canRaiseCap: true }],
      }))).toBe("multisig-mint");
    }
    for (const mintPath of ["issuer-direct-mint", "offchain-attested-minter"] as const) {
      expect(resolveMintAuthorityStatusKind(summary({ mintPath }))).toBe("issuer-or-backend-mint");
    }
    expect(resolveMintAuthorityStatusKind(summary({
      controls: [{ authorityType: "eoa", directMintAbility: "direct" }],
    }))).toBe("issuer-or-backend-mint");
    expect(resolveMintAuthorityStatusKind(summary())).toBe("governed-mint");
  });
});
