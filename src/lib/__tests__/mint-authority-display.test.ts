import { describe, expect, it } from "vitest";
import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import { resolveMintAuthorityStatusKind } from "../mint-authority-display";

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
