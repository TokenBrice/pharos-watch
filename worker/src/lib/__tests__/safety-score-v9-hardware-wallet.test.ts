import { describe, expect, it } from "vitest";
import { MintAuthorityProfileSchema } from "@shared/types/stablecoin-meta-control-schemas";
import type { MintAuthorityKeyCustodyAttestation } from "@shared/types/core";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { gradeVerifiedControlAuthority } from "@shared/lib/safety-score-v9/control-mint-grade";
import { makeDeploymentControl } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import { reviewedKeyCustody } from "../safety-score-v9/extension-shared";

const attestation: MintAuthorityKeyCustodyAttestation = {
  kind: "hardware-wallet", reviewedAt: "2026-10-10T23:47:08Z", reviewer: "Test reviewer", confidence: "issuer-described",
  rationale: "The issuer explicitly binds its exact native account signing keys to hardware-wallet storage, without proving independent signing policy.",
  sources: [{ label: "Issuer exact-account whitepaper", url: "https://example.org/whitepaper" }],
};
const profile = {
  mintPath: "issuer-direct-mint", authorityPosture: "unbounded-adverse", confidence: "verified", summary: "Issuer-controlled exact native signing account.",
  controls: [{ label: "Native mint key", authorityType: "eoa", role: "direct-minter", directMintAbility: "direct", chain: "ethereum", address: "0x1111111111111111111111111111111111111111", keyCustodyAttestation: attestation }],
  review: { reviewedAt: "2026-10-10", reviewer: "Test reviewer", evidence: "Exact native issuer account and hardware-wallet storage reviewed independently.", sources: attestation.sources },
};

describe("conservative hardware-wallet custody", () => {
  it("requires a dated substantive source-bound review", () => {
    expect(MintAuthorityProfileSchema.safeParse(profile).success).toBe(true);
    for (const key of ["reviewedAt", "reviewer", "confidence", "rationale", "sources"] as const) {
      const missing = { ...attestation, [key]: undefined };
      expect(MintAuthorityProfileSchema.safeParse({ ...profile, controls: [{ ...profile.controls[0], keyCustodyAttestation: missing }] }).success).toBe(false);
    }
  });
  it("does not read future or expired storage reviews as known", () => {
    const clock = Date.parse("2026-10-11T00:00:00Z") / 1000;
    expect(reviewedKeyCustody(attestation, clock)).toBe("hardware-wallet");
    expect(reviewedKeyCustody(attestation, Date.parse("2026-10-10T22:47:01Z") / 1000)).toBe("unknown");
    expect(reviewedKeyCustody({ ...attestation, reviewedAt: "2024-10-10" }, clock)).toBe("unknown");
    expect(reviewedKeyCustody({ ...attestation, reviewedAt: "2026-10-10" }, Date.parse("2026-10-10T23:59:59Z") / 1000)).toBe("unknown");
  });
  it("does not grant MPC/HSM scoring or independent-human credit", () => {
    const control = makeDeploymentControl("storage", "mint", { authority: { authorityKey: "issuer-key", model: "eoa", threshold: null }, keyCustody: "hardware-wallet" });
    const semantic = V9_CANDIDATE_POLICY_V1.policy.semantic;
    expect(gradeVerifiedControlAuthority(control, semantic)).toBe(gradeVerifiedControlAuthority({ ...control, keyCustody: "unknown" }, semantic));
    expect(gradeVerifiedControlAuthority(control, semantic)).toBeLessThan(gradeVerifiedControlAuthority({ ...control, keyCustody: "hsm" }, semantic));
  });
});
