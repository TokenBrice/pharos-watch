import type { z } from "zod";
import type { MintAuthorityDirectMintAbility, MintAuthorityProfile } from "./core";
import { issue } from "./safety-schema-primitives";
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
      issue(ctx, ["review", "scopedQuestions", index, "controlRef"], "scoped question controlRef must name an authored control's chain:address or label");
    }
  }
}

function validateUpgradeAndSourceEvidence(state: MintAuthorityRefinementState): void {
  const { profile, ctx, controls, profileHasSourceLinks } = state;
  const controlsHaveSourceLinks = controls.some((control) => hasSourceLinks(control.sources));
  if (profile.review.disposition === "unresolved" && profile.confidence !== "unknown") {
    issue(ctx, ["confidence"], "unresolved mint-authority disposition requires unknown confidence");
  }
  if (profile.upgradeability?.model === "immutable" && profile.upgradeability.canChangeMintLogic !== false) {
    issue(ctx, ["upgradeability", "canChangeMintLogic"], "immutable upgradeability requires canChangeMintLogic false");
  }
  if (
    profile.upgradeability != null &&
    profile.upgradeability.canChangeMintLogic === true &&
    !controls.some((control) => control.label === profile.upgradeability?.controlRef)
  ) {
    issue(ctx, ["upgradeability", "controlRef"], "upgradeable mint logic must reference an existing reviewed control");
  }
  if (
    (profile.confidence === "verified" || profile.confidence === "probable") &&
    !profileHasSourceLinks &&
    !controlsHaveSourceLinks
  ) {
    issue(ctx, ["review", "sources"], "verified or probable mintAuthority confidence requires at least one source link");
  }
  if (PRIVILEGED_MINT_PATHS.has(profile.mintPath) && profile.confidence !== "unknown" && controls.length === 0 && !profile.executionCertificates?.sharedBookRef) {
    issue(ctx, ["controls"], "privileged mintAuthority mintPath requires at least one control when confidence is not unknown");
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
      issue(ctx, ["controls", index, "sources"], "addressed or mint-capable controls require control-level sources/evidence or profile-level sources");
    }
    if (
      control.address == null &&
      !controlHasSourceLinks &&
      !controlHasEvidence &&
      !profile.review.sourceFreeRationale &&
      (profile.review.unresolvedQuestions?.length ?? 0) === 0
    ) {
      issue(ctx, ["controls", index, "address"], "non-addressable controls require evidence, sources, sourceFreeRationale, or unresolvedQuestions");
    }
    if (control.authorityType === "safe" && control.safe == null && !control.executionScope?.paths.some((path) => path.activation === "counterfactual" && path.counterfactual)) {
      issue(ctx, ["controls", index, "safe"], "authorityType safe requires safe details");
    }
    if (
      (control.authorityType === "safe" || control.authorityType === "multisig") &&
      profile.confidence === "verified" && control.weightedQuorum == null
    ) {
      if (control.threshold == null) {
        issue(ctx, ["controls", index, "threshold"], "verified safe or multisig controls require threshold");
      }
      if (control.signerCount == null) {
        issue(ctx, ["controls", index, "signerCount"], "verified safe or multisig controls require signerCount");
      }
      if (control.modulesOrGuardsStatus == null) {
        issue(ctx, ["controls", index, "modulesOrGuardsStatus"], "verified safe or multisig controls require modulesOrGuardsStatus");
      }
      if (
        control.authorityType === "safe" &&
        control.safe != null &&
        control.safe.source !== "manual" &&
        control.safe.observedBlock == null &&
        !control.executionScope?.paths.some((path) => path.activation === "counterfactual" && path.counterfactual)
      ) {
        issue(ctx, ["controls", index, "safe", "observedBlock"], "verified onchain or safe-api Safe controls require observedBlock");
      }
    }
    if (
      (control.authorityType === "safe" || control.authorityType === "multisig") &&
      (profile.confidence === "verified" || profile.confidence === "probable") &&
      control.modulesOrGuardsStatus === "unknown"
    ) {
      issue(ctx, ["controls", index, "modulesOrGuardsStatus"], "unknown Safe modules/guards status caps confidence at manual-review");
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
      issue(ctx, ["authorityPosture"], `authorityPosture ${profile.authorityPosture} requires a non-privileged mintPath`);
    }
  }
  if (profile.authorityPosture === "none-resolved") {
    const privilegedControlIndex = controls.findIndex((control) =>
      PRIVILEGED_DIRECT_MINT_ABILITIES.has(control.directMintAbility) || control.canRaiseCap === true,
    );
    if (privilegedControlIndex >= 0) {
      const capOnly = !PRIVILEGED_DIRECT_MINT_ABILITIES.has(controls[privilegedControlIndex]!.directMintAbility);
      issue(ctx, ["controls", privilegedControlIndex, capOnly ? "canRaiseCap" : "directMintAbility"],
        capOnly
          ? "authorityPosture none-resolved cannot include cap-raising controls"
          : "authorityPosture none-resolved cannot include mint-capable controls");
    }
  }
  // Only an ability that is itself a mint path disqualifies mint-scoped resolution.
  if (profile.authorityPosture === "none-resolved-mint") {
    const mintCapableControlIndex = controls.findIndex((control) =>
      PRIVILEGED_MINT_PATH_ABILITIES.has(control.directMintAbility),
    );
    if (mintCapableControlIndex >= 0) {
      issue(ctx, ["controls", mintCapableControlIndex, "directMintAbility"],
        "authorityPosture none-resolved-mint cannot include a control that can mint or authorize minting");
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
    issue(ctx, ["review", "sources"], `${claimed} is a positive economic-control claim and requires at least one review source`);
  }
  if ((profile.review.evidence ?? "").trim().length < MIN_ECONOMIC_CONTROL_EVIDENCE_LENGTH) {
    issue(ctx, ["review", "evidence"],
      `${claimed} requires a review evidence sentence of at least ` +
      `${MIN_ECONOMIC_CONTROL_EVIDENCE_LENGTH} characters stating the internal issuance workflow, reconciliation, or supervisory/attestation scope`);
  }
}

function validateGovernedIssuance({ profile, ctx, controls }: MintAuthorityRefinementState): void {
  const governed = profile.governedIssuance;
  const operational = profile.operationalIssuance;
  const declaredOperational = profile.authorityPosture === "unbounded-operationally-governed";
  const sharedBook = profile.executionCertificates?.sharedBookRef;
  if (governed || operational || declaredOperational) {
    for (const field of ["executionCertificates", "authorityGraph"] as const) {
      if (!profile[field] && !(field === "authorityGraph" && sharedBook)) issue(ctx, [field], "Issuance process requires execution certificates and typed authority graph");
    }
  }
  if (operational || declaredOperational) {
    if (governed?.decisionRule !== "affirmative-vote" && !(sharedBook && !governed)) issue(ctx, governed ? ["governedIssuance", "decisionRule"] : ["governedIssuance"], "Operational issuance requires affirmative token governance");
    if (!operational && !sharedBook) issue(ctx, ["operationalIssuance"], "Operational posture requires its operational evidence block");
    if (profile.economicCapSemantics !== "unbounded") issue(ctx, ["economicCapSemantics"], "Operational issuance remains economically unbounded");
    if (profile.inheritedFrom != null || profile.mintPath === "wrapped-or-variant-inherited") issue(ctx, ["operationalIssuance"], "Operational issuance requires native non-wrapper evidence");
  }
  if (governed) {
    if ((governed.decisionRule === "minority-veto") !== (governed.veto !== undefined)) {
      issue(ctx, ["governedIssuance", "veto"], "governedIssuance.veto must be present if and only if decisionRule is minority-veto");
    }
    if (governed.decisionRule === "affirmative-vote" && governed.monetaryPolicyPaths !== undefined) {
      issue(ctx, ["governedIssuance", "monetaryPolicyPaths"], "monetaryPolicyPaths is forbidden for affirmative-vote issuance");
    }
    for (const [index, monetaryPath] of (governed.monetaryPolicyPaths ?? []).entries()) {
      const matching = controls.filter((control) => control.chain != null && control.address != null &&
        `${control.chain}:${control.address.toLowerCase()}` === monetaryPath.controlRef);
      if (matching.length !== 1 || !(matching[0]!.executionScope?.paths ??
          profile.executionCertificates?.classes.find((entry) => entry.id === matching[0]!.executionClassRef?.classId)?.paths ?? []).some((path) => path.id === monetaryPath.pathId)) {
        issue(ctx, ["governedIssuance", "monetaryPolicyPaths", index], "monetaryPolicyPaths must resolve to an execution-scope path on exactly one authored control");
      }
    }
    if (profile.economicCapSemantics !== "unbounded") {
      issue(ctx, ["economicCapSemantics"], "governedIssuance requires economicCapSemantics unbounded");
    }
    if (profile.inheritedFrom != null || profile.mintPath === "wrapped-or-variant-inherited") {
      issue(ctx, ["governedIssuance"], "governedIssuance is not allowed on inherited or wrapped mint profiles");
    }
    if (!controls.some((control) => (control.executionScope?.paths ??
      profile.executionCertificates?.classes.find((entry) => entry.id === control.executionClassRef?.classId)?.paths ?? []).some(
      (path) => path.capSemantics.kind === "unbounded" || path.capSemantics.kind === "unknown" ||
        path.claimImpairment === "unbounded" || path.claimImpairment === "unknown",
    ))) {
      issue(ctx, ["governedIssuance"], "governedIssuance requires an unbounded or unknown execution-scope path");
    }
    const matchingControls = controls.filter(
      (control) => control.chain != null && control.address != null &&
        `${control.chain}:${control.address.toLowerCase()}` === governed.governorControlRef,
    );
    if (matchingControls.length !== 1) {
      issue(ctx, ["governedIssuance", "governorControlRef"], "governedIssuance.governorControlRef must resolve to exactly one authored EVM control");
    } else {
      const governor = matchingControls[0]!;
      if (governor.authorityType !== "dao-governor") {
        issue(ctx, ["governedIssuance", "governorControlRef"], "governedIssuance.governorControlRef must name a dao-governor control");
      }
      if ((governed.votingPower === "holding-period-weighted" || governed.votingPower === "lock-escrowed" ||
          governed.votingPower === "past-block-checkpoint") &&
          (governor.weightedQuorum != null || governor.threshold != null || governor.signerCount != null)) {
        issue(ctx, ["governedIssuance", "governorControlRef"], "governedIssuance token-voting governor must not carry weightedQuorum, threshold or signerCount");
      }
      if (!governor.executionScope && !governor.executionClassRef) {
        issue(ctx, ["controls", controls.indexOf(governor), "executionScope"], "governedIssuance governor control requires executionScope");
      }
    }
  }
  const requiredDecisionRule = profile.authorityPosture === "unbounded-veto-guarded"
    ? "minority-veto"
    : profile.authorityPosture === "unbounded-governed" || declaredOperational ? "affirmative-vote" : null;
  if (requiredDecisionRule !== null && governed?.decisionRule !== requiredDecisionRule && !(sharedBook && !governed)) {
    issue(ctx, governed ? ["governedIssuance", "decisionRule"] : ["governedIssuance"], `authorityPosture ${profile.authorityPosture} requires governedIssuance.decisionRule ${requiredDecisionRule}`);
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
      issue(ctx, ["capSemanticsReview"], `economicCapSemantics ${cap} with issuance authority requires capSemanticsReview`);
    } else if (capReview.verdict !== requiredVerdict) {
      issue(ctx, ["capSemanticsReview", "verdict"], `economicCapSemantics ${cap} requires capSemanticsReview verdict ${requiredVerdict}`);
    }
  }
  if (capReview && (cap === "unbounded" || cap === "unknown")) {
    issue(ctx, ["capSemanticsReview"], `capSemanticsReview is not allowed with economicCapSemantics ${cap}`);
  }
}

function validateActiveIncidentPosture({ profile, ctx }: MintAuthorityRefinementState): void {
  const activeIncident = profile.mintIncidents?.some((incident) => incident.status === "active") ?? false;
  if ((profile.authorityPosture === "compromised") !== activeIncident) {
    issue(ctx, ["authorityPosture"], activeIncident
      ? "active mint incidents require authorityPosture compromised"
      : "authorityPosture compromised requires an active mint incident");
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
    issue(ctx, ["authorityPosture"],
      "mintPath unknown should use authorityPosture unknown unless known unbounded authority supports unbounded-adverse or reviewed noLocalIssuance supports none-resolved-mint");
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
