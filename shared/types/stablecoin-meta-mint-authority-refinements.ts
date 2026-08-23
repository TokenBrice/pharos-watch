import { z } from "zod";
import type { MintAuthorityDirectMintAbility, MintAuthorityProfile } from "./core";
const PRIVILEGED_MINT_PATHS = new Set([
  "user-collateralized-governed", "issuer-direct-mint", "permissioned-minter",
  "offchain-attested-minter", "facilitator-bucket-mint", "amo-or-custodian-hybrid",
  "bridge-or-oft-synthetic", "m0-permissioned-minter",
] satisfies string[]);

const PRIVILEGED_DIRECT_MINT_ABILITIES: ReadonlySet<MintAuthorityDirectMintAbility> = new Set([
  "direct", "cap-limited", "can-authorize", "upgrade-only", "parameter-only",
] satisfies MintAuthorityDirectMintAbility[]);

/** Mint-scoped abilities that are themselves a path to new supply. Upgrade and
 * parameter authority disqualify whole-chain, but not mint-scoped, resolution. */
const PRIVILEGED_MINT_PATH_ABILITIES: ReadonlySet<MintAuthorityDirectMintAbility> = new Set([
  "direct", "cap-limited", "can-authorize",
] satisfies MintAuthorityDirectMintAbility[]);

/** Floor for a reviewer sentence that states what was reconciled or supervised. */
const MIN_ECONOMIC_CONTROL_EVIDENCE_LENGTH = 40;

type MintAuthorityControl = NonNullable<MintAuthorityProfile["controls"]>[number];
interface MintAuthorityRefinementState {
  profile: MintAuthorityProfile;
  ctx: z.RefinementCtx;
  controls: MintAuthorityControl[];
  profileHasSourceLinks: boolean;
}

function hasSourceLinks(sources: readonly { url: string }[] | undefined): boolean {
  return (sources?.length ?? 0) > 0;
}

function hasText(value: string | null | undefined): boolean {
  return value != null && value.trim().length > 0;
}

function validateScopedControlReferences({ profile, ctx, controls }: MintAuthorityRefinementState): void {
  for (const [index, question] of (profile.review.scopedQuestions ?? []).entries()) {
    const separator = question.controlRef.indexOf(":");
    const refChain = separator === -1 ? null : question.controlRef.slice(0, separator);
    const refAddress = separator === -1 ? null : question.controlRef.slice(separator + 1).toLowerCase();
    const matched = controls.some(
      (control) =>
        (refChain !== null && control.chain === refChain && control.address?.toLowerCase() === refAddress) ||
        control.label.toLowerCase() === question.controlRef.toLowerCase(),
    );
    if (!matched) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scoped question controlRef must name an authored control's chain:address or label",
        path: ["review", "scopedQuestions", index, "controlRef"],
      });
    }
  }
}

function validateUpgradeAndSourceEvidence(state: MintAuthorityRefinementState): void {
  const { profile, ctx, controls, profileHasSourceLinks } = state;
  const controlsHaveSourceLinks = controls.some((control) => hasSourceLinks(control.sources));
  if (profile.review.disposition === "unresolved" && profile.confidence !== "unknown") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unresolved mint-authority disposition requires unknown confidence",
      path: ["confidence"],
    });
  }
  if (profile.upgradeability?.model === "immutable" && profile.upgradeability.canChangeMintLogic !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "immutable upgradeability requires canChangeMintLogic false",
      path: ["upgradeability", "canChangeMintLogic"],
    });
  }
  if (
    profile.upgradeability != null &&
    profile.upgradeability.canChangeMintLogic === true &&
    !controls.some((control) => control.label === profile.upgradeability?.controlRef)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "upgradeable mint logic must reference an existing reviewed control",
      path: ["upgradeability", "controlRef"],
    });
  }
  if (
    (profile.confidence === "verified" || profile.confidence === "probable") &&
    !profileHasSourceLinks &&
    !controlsHaveSourceLinks
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "verified or probable mintAuthority confidence requires at least one source link",
      path: ["review", "sources"],
    });
  }
  if (PRIVILEGED_MINT_PATHS.has(profile.mintPath) && profile.confidence !== "unknown" && controls.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "privileged mintAuthority mintPath requires at least one control when confidence is not unknown",
      path: ["controls"],
    });
  }
}

function validateAuthoredControls({ profile, ctx, controls, profileHasSourceLinks }: MintAuthorityRefinementState): void {
  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index]!;
    const controlHasSourceLinks = hasSourceLinks(control.sources);
    const controlHasEvidence = hasText(control.evidence);
    const directMintAbilityNeedsEvidence = control.directMintAbility !== "none";
    if (
      (control.address != null || directMintAbilityNeedsEvidence) &&
      !controlHasSourceLinks &&
      !controlHasEvidence &&
      !profileHasSourceLinks
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "addressed or mint-capable controls require control-level sources/evidence or profile-level sources",
        path: ["controls", index, "sources"],
      });
    }
    if (
      control.address == null &&
      !controlHasSourceLinks &&
      !controlHasEvidence &&
      !profile.review.sourceFreeRationale &&
      (profile.review.unresolvedQuestions?.length ?? 0) === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "non-addressable controls require evidence, sources, sourceFreeRationale, or unresolvedQuestions",
        path: ["controls", index, "address"],
      });
    }
    if (control.authorityType === "safe" && control.safe == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorityType safe requires safe details",
        path: ["controls", index, "safe"],
      });
    }
    if (
      (control.authorityType === "safe" || control.authorityType === "multisig") &&
      profile.confidence === "verified"
    ) {
      if (control.threshold == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "verified safe or multisig controls require threshold",
          path: ["controls", index, "threshold"],
        });
      }
      if (control.signerCount == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "verified safe or multisig controls require signerCount",
          path: ["controls", index, "signerCount"],
        });
      }
      if (control.modulesOrGuardsStatus == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "verified safe or multisig controls require modulesOrGuardsStatus",
          path: ["controls", index, "modulesOrGuardsStatus"],
        });
      }
      if (
        control.authorityType === "safe" &&
        control.safe != null &&
        control.safe.source !== "manual" &&
        control.safe.observedBlock == null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "verified onchain or safe-api Safe controls require observedBlock",
          path: ["controls", index, "safe", "observedBlock"],
        });
      }
    }
    if (
      (control.authorityType === "safe" || control.authorityType === "multisig") &&
      (profile.confidence === "verified" || profile.confidence === "probable") &&
      control.modulesOrGuardsStatus === "unknown"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unknown Safe modules/guards status caps confidence at manual-review",
        path: ["controls", index, "modulesOrGuardsStatus"],
      });
    }
  }
}

function validateAuthorityPosture({ profile, ctx, controls }: MintAuthorityRefinementState): void {
  // Both none-resolved scopes require a non-privileged mint path.
  if (profile.authorityPosture === "none-resolved" || profile.authorityPosture === "none-resolved-mint") {
    if (profile.mintPath !== "immutable-user-collateralized" && profile.mintPath !== "wrapped-or-variant-inherited") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `authorityPosture ${profile.authorityPosture} requires a non-privileged mintPath`,
        path: ["authorityPosture"],
      });
    }
  }
  if (profile.authorityPosture === "none-resolved") {
    const privilegedControlIndex = controls.findIndex((control) =>
      PRIVILEGED_DIRECT_MINT_ABILITIES.has(control.directMintAbility),
    );
    if (privilegedControlIndex >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorityPosture none-resolved cannot include mint-capable controls",
        path: ["controls", privilegedControlIndex, "directMintAbility"],
      });
    }
  }
  // Only an ability that is itself a mint path disqualifies mint-scoped resolution.
  if (profile.authorityPosture === "none-resolved-mint") {
    const mintCapableControlIndex = controls.findIndex((control) =>
      PRIVILEGED_MINT_PATH_ABILITIES.has(control.directMintAbility),
    );
    if (mintCapableControlIndex >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorityPosture none-resolved-mint cannot include a control that can mint or authorize minting",
        path: ["controls", mintCapableControlIndex, "directMintAbility"],
      });
    }
  }
}

function validateEconomicControlEvidence({ profile, ctx, profileHasSourceLinks }: MintAuthorityRefinementState): void {
  // Evidence binding for the two economic-control facts (M-2). Only the
  // score-bearing values are gated; absence values assert nothing.
  const claimsReconciliation = profile.reconciliation === "continuous" || profile.reconciliation === "periodic";
  const claimsSupervision = profile.supervision === "prudential";
  if (!claimsReconciliation && !claimsSupervision) return;
  const claimed = [
    claimsReconciliation ? `reconciliation ${profile.reconciliation}` : null,
    claimsSupervision ? "supervision prudential" : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" and ");
  if (!profileHasSourceLinks) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${claimed} is a scored economic-control claim and requires at least one review source`,
      path: ["review", "sources"],
    });
  }
  if ((profile.review.evidence ?? "").trim().length < MIN_ECONOMIC_CONTROL_EVIDENCE_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `${claimed} requires a review evidence sentence of at least ` +
        `${MIN_ECONOMIC_CONTROL_EVIDENCE_LENGTH} characters stating what was reconciled or which regime supervises it`,
      path: ["review", "evidence"],
    });
  }
}

function validateMintPathPostureConsistency({ profile, ctx }: MintAuthorityRefinementState): void {
  if (
    profile.mintPath === "unknown" &&
    profile.authorityPosture !== "unknown" &&
    profile.authorityPosture !== "unbounded-or-compromised"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "mintPath unknown should use authorityPosture unknown unless evidence supports unbounded-or-compromised",
      path: ["authorityPosture"],
    });
  }
}

export function validateMintAuthorityProfile(profile: MintAuthorityProfile, ctx: z.RefinementCtx): void {
  const state: MintAuthorityRefinementState = {
    profile,
    ctx,
    controls: profile.controls ?? [],
    profileHasSourceLinks: hasSourceLinks(profile.review.sources),
  };
  validateScopedControlReferences(state);
  validateUpgradeAndSourceEvidence(state);
  validateAuthoredControls(state);
  validateAuthorityPosture(state);
  validateEconomicControlEvidence(state);
  validateMintPathPostureConsistency(state);
}
