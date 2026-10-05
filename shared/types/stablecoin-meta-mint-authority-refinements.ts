import { z } from "zod";
import type { MintAuthorityDirectMintAbility, MintAuthorityProfile } from "./core";
const PRIVILEGED_MINT_PATHS = new Set([
  "user-collateralized-governed", "issuer-direct-mint", "permissioned-minter",
  "offchain-attested-minter", "facilitator-bucket-mint", "amo-or-custodian-hybrid",
  "bridge-or-oft-synthetic", "m0-permissioned-minter",
] satisfies string[]);

const PRIVILEGED_DIRECT_MINT_ABILITIES: ReadonlySet<MintAuthorityDirectMintAbility> = new Set([
  "direct", "cap-limited", "can-authorize", "upgrade-only", "parameter-only", "unknown",
] satisfies MintAuthorityDirectMintAbility[]);

/** Mint-scoped abilities that are themselves a path to new supply. Upgrade and
 * parameter authority disqualify whole-chain, but not mint-scoped, resolution. */
const PRIVILEGED_MINT_PATH_ABILITIES: ReadonlySet<MintAuthorityDirectMintAbility> = new Set([
  "direct", "cap-limited", "can-authorize", "unknown",
] satisfies MintAuthorityDirectMintAbility[]);

/** Floor for a reviewer sentence stating the positive economic-control fact. */
const MIN_ECONOMIC_CONTROL_EVIDENCE_LENGTH = 40;

type MintAuthorityControl = NonNullable<MintAuthorityProfile["controls"]>[number];
interface MintAuthorityRefinementState {
  profile: MintAuthorityProfile;
  ctx: z.RefinementCtx;
  controls: MintAuthorityControl[];
  profileHasSourceLinks: boolean;
}

/** Shared across the meta schemas: any authored link proves the field is sourced. */
export function hasSourceLinks(sources: readonly { url: string }[] | undefined): boolean {
  return (sources?.length ?? 0) > 0;
}

/** Shared across the meta schemas: a review field counts as authored only with real text. */
export function hasText(value: string | null | undefined): boolean {
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
  if (PRIVILEGED_MINT_PATHS.has(profile.mintPath) && profile.confidence !== "unknown" && controls.length === 0 && !profile.executionCertificates?.sharedBookRef) {
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
    if (control.authorityType === "safe" && control.safe == null && !control.executionScope?.paths.some((path) => path.activation === "counterfactual" && path.counterfactual)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorityType safe requires safe details",
        path: ["controls", index, "safe"],
      });
    }
    if (
      (control.authorityType === "safe" || control.authorityType === "multisig") &&
      profile.confidence === "verified" && control.weightedQuorum == null
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
        control.safe.observedBlock == null &&
        !control.executionScope?.paths.some((path) => path.activation === "counterfactual" && path.counterfactual)
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
  // Whole-chain resolution requires a non-privileged path; mint-scoped resolution also admits reviewed no-local issuance.
  if (profile.authorityPosture === "none-resolved" || profile.authorityPosture === "none-resolved-mint") {
    if (
      profile.mintPath !== "immutable-user-collateralized" &&
      profile.mintPath !== "wrapped-or-variant-inherited" &&
      !(profile.authorityPosture === "none-resolved-mint" && profile.review.noLocalIssuance != null)
    ) {
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
  // Positive process disclosures require evidence even when they grant no rung.
  // Absence and unresolved values do not manufacture a positive claim.
  const claimsReconciliation = profile.reconciliation === "continuous" ||
    profile.reconciliation === "periodic" || profile.reconciliation === "internal-ledger";
  const claimsSupervision = profile.supervision === "prudential" || profile.supervision === "attestation-only";
  if (!claimsReconciliation && !claimsSupervision) return;
  const claimed = [
    claimsReconciliation ? `reconciliation ${profile.reconciliation}` : null,
    claimsSupervision ? `supervision ${profile.supervision}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" and ");
  if (!profileHasSourceLinks) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${claimed} is a positive economic-control claim and requires at least one review source`,
      path: ["review", "sources"],
    });
  }
  if ((profile.review.evidence ?? "").trim().length < MIN_ECONOMIC_CONTROL_EVIDENCE_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `${claimed} requires a review evidence sentence of at least ` +
        `${MIN_ECONOMIC_CONTROL_EVIDENCE_LENGTH} characters stating the internal issuance workflow, reconciliation, or supervisory/attestation scope`,
      path: ["review", "evidence"],
    });
  }
}

function validateGovernedIssuance({ profile, ctx, controls }: MintAuthorityRefinementState): void {
  const governed = profile.governedIssuance;
  const operational = profile.operationalIssuance;
  const declaredOperational = profile.authorityPosture === "unbounded-operationally-governed";
  const sharedBook = profile.executionCertificates?.sharedBookRef;
  if (governed || operational || declaredOperational) {
    for (const field of ["executionCertificates", "authorityGraph"] as const) {
      if (!profile[field] && !(field === "authorityGraph" && sharedBook)) ctx.addIssue({ code: "custom", path: [field], message: "Issuance process requires execution certificates and typed authority graph" });
    }
  }
  if (operational || declaredOperational) {
    if (governed?.decisionRule !== "affirmative-vote" && !(sharedBook && !governed)) ctx.addIssue({ code: "custom", path: governed ? ["governedIssuance", "decisionRule"] : ["governedIssuance"], message: "Operational issuance requires affirmative token governance" });
    if (!operational && !sharedBook) ctx.addIssue({ code: "custom", path: ["operationalIssuance"], message: "Operational posture requires its operational evidence block" });
    if (profile.economicCapSemantics !== "unbounded") ctx.addIssue({ code: "custom", path: ["economicCapSemantics"], message: "Operational issuance remains economically unbounded" });
    if (profile.inheritedFrom != null || profile.mintPath === "wrapped-or-variant-inherited") ctx.addIssue({ code: "custom", path: ["operationalIssuance"], message: "Operational issuance requires native non-wrapper evidence" });
  }
  if (governed) {
    if ((governed.decisionRule === "minority-veto") !== (governed.veto !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "governedIssuance.veto must be present if and only if decisionRule is minority-veto",
        path: ["governedIssuance", "veto"],
      });
    }
    if (governed.decisionRule === "affirmative-vote" && governed.monetaryPolicyPaths !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "monetaryPolicyPaths is forbidden for affirmative-vote issuance",
        path: ["governedIssuance", "monetaryPolicyPaths"],
      });
    }
    for (const [index, monetaryPath] of (governed.monetaryPolicyPaths ?? []).entries()) {
      const matching = controls.filter((control) => control.chain != null && control.address != null &&
        `${control.chain}:${control.address.toLowerCase()}` === monetaryPath.controlRef);
      if (matching.length !== 1 || !(matching[0]!.executionScope?.paths ??
          profile.executionCertificates?.classes.find((entry) => entry.id === matching[0]!.executionClassRef?.classId)?.paths ?? []).some((path) => path.id === monetaryPath.pathId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "monetaryPolicyPaths must resolve to an execution-scope path on exactly one authored control",
          path: ["governedIssuance", "monetaryPolicyPaths", index],
        });
      }
    }
    if (profile.economicCapSemantics !== "unbounded") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "governedIssuance requires economicCapSemantics unbounded",
        path: ["economicCapSemantics"],
      });
    }
    if (profile.inheritedFrom != null || profile.mintPath === "wrapped-or-variant-inherited") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "governedIssuance is not allowed on inherited or wrapped mint profiles",
        path: ["governedIssuance"],
      });
    }
    if (!controls.some((control) => (control.executionScope?.paths ??
      profile.executionCertificates?.classes.find((entry) => entry.id === control.executionClassRef?.classId)?.paths ?? []).some(
      (path) => path.capSemantics.kind === "unbounded" || path.capSemantics.kind === "unknown" ||
        path.claimImpairment === "unbounded" || path.claimImpairment === "unknown",
    ))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "governedIssuance requires an unbounded or unknown execution-scope path",
        path: ["governedIssuance"],
      });
    }
    const matchingControls = controls.filter(
      (control) => control.chain != null && control.address != null &&
        `${control.chain}:${control.address.toLowerCase()}` === governed.governorControlRef,
    );
    if (matchingControls.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "governedIssuance.governorControlRef must resolve to exactly one authored EVM control",
        path: ["governedIssuance", "governorControlRef"],
      });
    } else {
      const governor = matchingControls[0]!;
      if (governor.authorityType !== "dao-governor") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "governedIssuance.governorControlRef must name a dao-governor control",
          path: ["governedIssuance", "governorControlRef"],
        });
      }
      if ((governed.votingPower === "holding-period-weighted" || governed.votingPower === "lock-escrowed" ||
          governed.votingPower === "past-block-checkpoint") &&
          (governor.weightedQuorum != null || governor.threshold != null || governor.signerCount != null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "governedIssuance token-voting governor must not carry weightedQuorum, threshold or signerCount",
          path: ["governedIssuance", "governorControlRef"],
        });
      }
      if (!governor.executionScope && !governor.executionClassRef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "governedIssuance governor control requires executionScope",
          path: ["controls", controls.indexOf(governor), "executionScope"],
        });
      }
    }
  }
  const requiredDecisionRule = profile.authorityPosture === "unbounded-veto-guarded"
    ? "minority-veto"
    : profile.authorityPosture === "unbounded-governed" || declaredOperational ? "affirmative-vote" : null;
  if (requiredDecisionRule !== null && governed?.decisionRule !== requiredDecisionRule && !(sharedBook && !governed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `authorityPosture ${profile.authorityPosture} requires governedIssuance.decisionRule ${requiredDecisionRule}`,
      path: governed ? ["governedIssuance", "decisionRule"] : ["governedIssuance"],
    });
  }
}

function validateCapSemanticsReview({ profile, ctx, controls }: MintAuthorityRefinementState): void {
  const cap = profile.economicCapSemantics;
  const capReview = profile.capSemanticsReview;
  const hasIssuanceAuthority = controls.some(
    (control) => control.directMintAbility === "direct" ||
      control.directMintAbility === "can-authorize" ||
      control.canRaiseCap === true,
  );
  if ((cap === "raiseable" || cap === "bounded" || cap === "collateral-gated") && hasIssuanceAuthority) {
    const requiredVerdict = cap === "raiseable" ? "raiseable-collateral-only" : "bounded-by-construction";
    if (!capReview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `economicCapSemantics ${cap} with issuance authority requires capSemanticsReview`,
        path: ["capSemanticsReview"],
      });
    } else if (capReview.verdict !== requiredVerdict) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `economicCapSemantics ${cap} requires capSemanticsReview verdict ${requiredVerdict}`,
        path: ["capSemanticsReview", "verdict"],
      });
    }
  }
  if (capReview && (cap === "unbounded" || cap === "unknown")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `capSemanticsReview is not allowed with economicCapSemantics ${cap}`,
      path: ["capSemanticsReview"],
    });
  }
}

function validateActiveIncidentPosture({ profile, ctx }: MintAuthorityRefinementState): void {
  const activeIncident = profile.mintIncidents?.some((incident) => incident.status === "active") ?? false;
  if ((profile.authorityPosture === "compromised") !== activeIncident) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: activeIncident
        ? "active mint incidents require authorityPosture compromised"
        : "authorityPosture compromised requires an active mint incident",
      path: ["authorityPosture"],
    });
  }
}

function validateMintPathPostureConsistency({ profile, ctx, controls }: MintAuthorityRefinementState): void {
  const knownUnboundedAuthority = profile.mintPath === "unknown" &&
    profile.authorityPosture === "unbounded-adverse" &&
    (profile.economicCapSemantics === "unbounded" ||
      controls.some((control) => (control.executionScope?.paths ??
        profile.executionCertificates?.classes.find((entry) => entry.id === control.executionClassRef?.classId)?.paths ?? []).some(
        (path) => path.capSemantics.kind === "unbounded" || path.claimImpairment === "unbounded",
      )));
  if (
    profile.mintPath === "unknown" &&
    profile.authorityPosture !== "unknown" &&
    !(profile.authorityPosture === "unbounded-adverse" && knownUnboundedAuthority) &&
    !(profile.authorityPosture === "none-resolved-mint" && profile.review.noLocalIssuance != null)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "mintPath unknown should use authorityPosture unknown unless known unbounded authority supports unbounded-adverse or reviewed noLocalIssuance supports none-resolved-mint",
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
  validateGovernedIssuance(state);
  validateCapSemanticsReview(state);
  validateActiveIncidentPosture(state);
  validateMintPathPostureConsistency(state);
}
