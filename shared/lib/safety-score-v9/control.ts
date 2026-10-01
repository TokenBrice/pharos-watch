import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";
import type {
  V9ReasonCode,
  V9Severity,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { V9_NEUTRAL_CONTROL_SCORE } from "../../types/safety-score-v9-public-facts";
import {
  assertV9ReasonCodesRegistered,
  assertV9ValidatedPolicyEnvelope,
  resolveV9ReasonPolicy,
} from "./policy";
import { v9StructuralSignalSharePct } from "./backing-primitives";
import { canonicalDomains, compareText, domainKey, uniqueSorted } from "./primitives";
import {
  controlFallbackKind,
  evaluateV9SubthresholdUnresolvedBridgeJoins,
  materialBridgeSeverity,
  provenNullShareDeploymentBound,
  unresolvedDeploymentCohort,
} from "./control-bridge-join";
import {
  applyMergedMintSignals,
  gradeVerifiedControlAuthority,
  isStaticallyVerifiedControl,
} from "./control-mint-grade";
import {
  bindingByMateriality,
  controlCanRepresent,
  deriveV9MintPosture,
  hasFreshScopedQuestion,
  isControlEconomicallyRelevant,
  isKnownRequired,
  mappedControlStatusReason,
  type EvaluateV9EconomicControlArgs,
  type V9CompactControlReason,
  type V9ControlComponent,
  type V9ControlStructuralFailure,
  type V9EconomicControlAssetSource,
  type V9EconomicControlResult,
  type V9EconomicControlReviewExtension,
  type V9OracleBranchKind,
  type V9OracleBranchReview,
} from "./control-primitives";

const ORACLE_BRANCHES = [
  "feed",
  "collateral-parameter",
  "liquidation",
  "backstop",
  "shutdown-bad-debt",
] as const satisfies readonly V9OracleBranchKind[];
/**
 * Canonically joins normalized asset facts to the explicit review extension.
 * The extension is mandatory: callers must not infer reconciliation or tiers.
 */
export function projectV9EconomicControlEvaluation(
  asset: V9EconomicControlAssetSource,
  review: V9EconomicControlReviewExtension,
  policy: V9ValidatedPolicyEnvelope,
): EvaluateV9EconomicControlArgs {
  assertV9ValidatedPolicyEnvelope(policy);
  if (review.assetId !== asset.assetId) {
    throw new Error(`Safety Score v9 control review ${review.assetId} does not match asset ${asset.assetId}`);
  }

  return {
    policy,
    facts: {
      assetId: asset.assetId,
      archetype: asset.archetype,
      controlStatus: asset.controlStatus,
      controls: [...asset.controls].sort((left, right) => compareText(left.controlKey, right.controlKey)),
      supply: {
        status: asset.supply.status,
        selectedBridgeRoutes: [...asset.supply.selectedBridgeRoutes].sort((left, right) =>
          compareText(left.deploymentRouteKey, right.deploymentRouteKey),
        ),
        selectedRouteSupplyShare: asset.supply.selectedRouteSupplyShare,
        unknownRouteSupplyShare: asset.supply.unknownRouteSupplyShare,
        unreviewedRouteSupplyShare: asset.supply.unreviewedRouteSupplyShare,
      },
    },
    mint: {
      ...review.mint,
      upgrade: { ...review.mint.upgrade },
    },
    ...(review.trackRecordMonths !== undefined ? { trackRecordMonths: review.trackRecordMonths } : {}),
    ...(review.resolvedIncidentAgeMonths !== undefined
      ? { resolvedIncidentAgeMonths: review.resolvedIncidentAgeMonths }
      : {}),
    oracle: {
      ...review.oracle,
      branches: [...review.oracle.branches].sort(
        (left, right) =>
          compareText(left.branch, right.branch) ||
          compareText(left.controlKey ?? "", right.controlKey ?? "") ||
          compareText(left.mechanismKey ?? "", right.mechanismKey ?? ""),
      ),
    },
    bridge: {
      ...review.bridge,
      routes: [...review.bridge.routes].sort((left, right) => compareText(left.controlKey, right.controlKey)),
    },
  };
}

export function evaluateV9EconomicControl(args: EvaluateV9EconomicControlArgs): V9EconomicControlResult {
  assertV9ValidatedPolicyEnvelope(args.policy);
  const policy = args.policy.policy.semantic;
  const materialShareThreshold = policy.materiality.deploymentMaterialSharePct / 100;
  const unresolvedFullCeilingShareThreshold = policy.materiality.unresolvedDeploymentFullCeilingSharePct / 100;
  const unresolvedCohort = unresolvedDeploymentCohort(args.facts, args.facts.controls);
  const controlBinding = (control: V9DeploymentControlFactV2, bound: number | null = null) =>
    bindingByMateriality(
      control,
      unresolvedCohort.share !== null && unresolvedCohort.share < unresolvedFullCeilingShareThreshold &&
        unresolvedCohort.controlKeys.has(control.controlKey) &&
        args.facts.supply.selectedBridgeRoutes.some(
          (row) => row.deploymentRouteKey === control.deploymentKey && row.reviewState !== "unmatched",
        )
        ? unresolvedFullCeilingShareThreshold
        : materialShareThreshold,
      bound,
    );
  const controls = [...args.facts.controls].sort((left, right) => compareText(left.controlKey, right.controlKey));
  const controlsByKey = new Map(controls.map((control) => [control.controlKey, control]));
  const components: V9ControlComponent[] = [];
  const reasons = new Map<string, V9CompactControlReason>();
  const structuralFailures = new Map<string, V9ControlStructuralFailure>();

  const addReason = (
    code: V9ReasonCode,
    pathKind: V9CompactControlReason["pathKind"],
    path: string,
    controlKey: string | null = null,
  ) => {
    const resolved = resolveV9ReasonPolicy(args.policy, code);
    if (!resolved.reason.pathKinds.includes(pathKind)) {
      throw new Error(`Safety Score v9 reason ${code} cannot describe ${pathKind}`);
    }
    const key = `${code}:${pathKind}:${path}:${controlKey ?? ""}`;
    reasons.set(key, {
      code,
      label: resolved.reason.publicLabel,
      critical: resolved.critical,
      pathKind,
      path,
      controlKey,
    });
  };

  const addStructuralFailure = (failure: V9ControlStructuralFailure) => {
    const domains = canonicalDomains(failure.failureDomains);
    const controlKeys = uniqueSorted(failure.controlKeys);
    const key = `${failure.kind}:${failure.binding}:${controlKeys.join("+")}:${domains
      .map(domainKey)
      .join("+")}`;
    structuralFailures.set(key, { ...failure, controlKeys, failureDomains: domains });
  };

  if (args.facts.controlStatus.applicability.state === "unresolved") {
    addReason("unresolved-control-identity", "local-component", "controls");
  } else if (
    args.facts.controlStatus.applicability.state === "required" &&
    args.facts.controlStatus.observationState !== "known"
  ) {
    // An inventory demoted only by reviewer-scoped open questions inherits the
    // scoped ceiling; any unresolved control without one keeps the hard reason.
    const unresolvedControls = controls.filter(
      (control) =>
        isControlEconomicallyRelevant(control) &&
        control.status.applicability.state !== "not-applicable" &&
        !isKnownRequired(control.status),
    );
    const allScoped = unresolvedControls.length > 0 && unresolvedControls.every(hasFreshScopedQuestion);
    addReason(allScoped ? "scoped-control-question" : "unresolved-control-identity", "local-component", "controls");
  }

  for (const control of controls) {
    if (!isControlEconomicallyRelevant(control)) continue;
    if (control.status.applicability.state === "not-applicable") continue;
    const nullShareBound = provenNullShareDeploymentBound(args.facts, control);
    const provenImmaterial = nullShareBound !== null && nullShareBound < materialShareThreshold;
    const binding = controlBinding(control, nullShareBound);
    const pathKind = control.controlKind === "bridge" ? "deployment-control" : "local-component";
    const path = `control:${control.controlKey}`;
    if (control.status.applicability.state === "unresolved" || control.status.observationState !== "known") {
      if (binding) addReason(mappedControlStatusReason(control), pathKind, path, control.controlKey);
      continue;
    }
    if (binding && (control.authority === null || control.authority.model === "unknown")) {
      addReason("unresolved-control-identity", "local-component", path, control.controlKey);
    }
    if (
      binding &&
      (control.capSemantics.kind === "unknown" ||
        control.claimImpairment === "unknown" ||
        control.economicLossScope === "unknown")
    ) {
      addReason("unresolved-control-identity", "local-component", `${path}:economic-semantics`, control.controlKey);
    }
    if (binding && control.incidentState === "unknown") {
      addReason("unresolved-control-identity", "local-component", `${path}:incident`, control.controlKey);
    } else if (control.incidentState === "active") {
      addStructuralFailure({
        kind: "active-control-incident",
        severity: "critical",
        binding,
        reason: "A reviewed economic control has an active compromise incident.",
        materialSharePct:
          control.materialSupplyShare === null
            ? null
            : v9StructuralSignalSharePct(
                args.facts.assetId,
                "structuralSignals[*].materialSharePct",
                control.materialSupplyShare,
              ),
        controlKeys: [control.controlKey],
        failureDomains: control.failureDomains,
      });
    }
    if (
      control.economicLossScope === "deployment" &&
      control.materialSupplyShare === null &&
      control.scope !== "global" &&
      !provenImmaterial
    ) {
      addReason(
        control.controlKind === "bridge" ? "runtime-bridge-materiality-unavailable" : "unresolved-control-identity",
        pathKind,
        `${path}:materiality`,
        control.controlKey,
      );
    }
  }

  const mint = args.mint;
  const retainedAdverseMintControls =
    mint.status.applicability.state !== "not-applicable" &&
    !isKnownRequired(mint.status)
      ? controls.filter((control) => {
          if (
            control.controlKind === "bridge" ||
            control.status.applicability.state === "not-applicable" ||
            !isControlEconomicallyRelevant(control) ||
            (!control.capabilities.includes("mint") && control.controlKey !== mint.controlKey)
          ) return false;
          const posture = deriveV9MintPosture(control, mint, false);
          return posture === "unknown" ||
            (control.status.evidenceRefIds.length > 0 &&
              (posture === "unbounded-or-compromised" || posture === "unbounded-reconciliation-unknown"));
        })
      : [];
  if (mint.status.applicability.state === "not-applicable") {
    const noneResolvedScore = policy.control.mintPostureQuality["none-resolved"];
    components.push({
      componentKey: "mint",
      kind: "mint",
      posture: "none-resolved",
      score: applyMergedMintSignals(
        noneResolvedScore,
        null,
        args.resolvedIncidentAgeMonths,
        policy.control,
      ),
      binding: true,
      controlKeys: [],
      failureDomains: [],
    });
  } else if (mint.status.applicability.state === "unresolved") {
    addReason("mint-control-question", "local-component", "mint");
  } else if (mint.status.observationState !== "known") {
    addReason(
      mint.status.observationState === "missing" ? "missing-mint-authority" : "unresolved-mint-authority",
      "local-component",
      "mint",
      mint.controlKey,
    );
  }
  if (isKnownRequired(mint.status) || retainedAdverseMintControls.length > 0) {
    const mintControl = mint.controlKey === null ? null : (controlsByKey.get(mint.controlKey) ?? null);
    const immutableMechanism =
      mint.controlKey === null && mint.upgrade.state === "immutable" && mint.reconciliation === "not-applicable";
    if (mint.controlKey === null && !immutableMechanism) {
      addReason("missing-mint-authority", "local-component", "mint");
    } else if (mint.controlKey !== null && (!mintControl || !controlCanRepresent(mintControl, "mint"))) {
      addReason("unresolved-control-identity", "local-component", "mint", mint.controlKey);
    }
    let upgradeControl: V9DeploymentControlFactV2 | null = null;
    let upgradeUnreviewed = false;
    if (mint.upgrade.state === "unknown") {
      upgradeUnreviewed = true;
      addReason("unknown-upgrade-authority", "local-component", "mint:upgrade", mint.upgrade.controlKey);
    } else if (mint.upgrade.state === "reviewed") {
      upgradeControl = mint.upgrade.controlKey === null ? null : (controlsByKey.get(mint.upgrade.controlKey) ?? null);
      if (!upgradeControl || !controlCanRepresent(upgradeControl, "upgrade")) {
        upgradeUnreviewed = true;
        addReason("missing-upgrade-control", "local-component", "mint:upgrade", mint.upgrade.controlKey);
      } else if (!isKnownRequired(upgradeControl.status)) {
        upgradeUnreviewed = true;
        addReason("missing-upgradeability-review", "local-component", "mint:upgrade", mint.upgrade.controlKey);
      }
    }

    // The review key anchors admission; it is not an exhaustive mint inventory.
    // Every non-bridge durable-mint path must compete, including separate
    // deployment observations of the same authority.
    const mintControls = isKnownRequired(mint.status)
      ? controls.filter(
          (control) =>
            control.controlKind !== "bridge" &&
            control.status.applicability.state !== "not-applicable" &&
            (control.capabilities.includes("mint") || control === mintControl),
        )
      : retainedAdverseMintControls;
    for (const mintControl of mintControls.length > 0 ? mintControls : [null]) {
      if (mintControl?.capSemantics.kind === "unknown") {
        addReason("unknown-control-cap-authority", "local-component", "mint:cap", mintControl.controlKey);
      }
      if (mintControl?.claimImpairment === "unknown") {
        addReason("unknown-control-mint-ability", "local-component", "mint:claim-impairment", mintControl.controlKey);
      }
      if (
        mintControl &&
        mintControl.claimImpairment !== "none" &&
        mintControl.authority?.model === "issuer-backend" &&
        (mint.reconciliation === "not-applicable" || mint.reconciliation === "unknown")
      ) {
        addReason("mint-control-question", "local-component", "mint:reconciliation", mintControl.controlKey);
      }

      const compromised = mintControl?.incidentState === "active";
      const posture = deriveV9MintPosture(mintControl, mint, immutableMechanism);
      const componentControlKeys = uniqueSorted(
        [mintControl?.controlKey, upgradeControl?.controlKey].filter((value): value is string => value !== undefined),
      );
      const componentFailureDomains = canonicalDomains([
        ...(mintControl?.failureDomains ?? []),
        ...(upgradeControl?.failureDomains ?? []),
      ]);
      const mintControlKeys = mintControl === null ? [] : [mintControl.controlKey];
      const mintFailureDomains = canonicalDomains(mintControl?.failureDomains ?? []);
      const upgradeControlKeys = upgradeControl === null ? [] : [upgradeControl.controlKey];
      const upgradeFailureDomains = canonicalDomains(upgradeControl?.failureDomains ?? []);
      const mintBinding = mintControl === null ? true : controlBinding(mintControl);
      const mintReconciled = mint.reconciliation === "continuous" || mint.reconciliation === "periodic";
      const gradedPostureScore =
        (posture === "concentrated-admin" || posture === "unbounded-reconciled") && mintReconciled
          ? mint.supervision === "prudential"
            ? policy.control.mintPostureGrading.prudentialReconciled
            : mint.supervision === "attestation-only"
              ? policy.control.mintPostureGrading.attestationOnlyReconciled
              : policy.control.mintPostureQuality[posture]
          : policy.control.mintPostureQuality[posture];
      // T5 seasoned-issuer credit (owner ruling 2026-07-22, R2): a reconciled,
      // non-adverse measured posture with >= seasonedCreditMinMonths of track
      // record earns seasonedCreditPoints, capped at the next rung of the merged
      // posture/grading ladder — longevity can close the gap to the next rung
      // but never leapfrog it. MINT-LADDER 9.32 (2026-08-21) also permits the
      // two unreconciled adverse rungs to earn credit when no active compromise
      // remains; the compromised rung uses its dedicated adverse ceiling.
      const mintPostureScore = (() => {
        const grading = policy.control.mintPostureGrading;
        const adverseSeasonedEligible =
          (posture === "unbounded-or-compromised" && mintControl?.incidentState !== "active") ||
          posture === "unbounded-reconciliation-unknown";
        if (
          grading.seasonedCreditPoints <= 0 ||
          args.trackRecordMonths === undefined ||
          args.trackRecordMonths < grading.seasonedCreditMinMonths ||
          (!mintReconciled && !adverseSeasonedEligible) ||
          posture === "unknown" ||
          (posture === "unbounded-or-compromised" && mintControl?.incidentState === "active")
        ) {
          return gradedPostureScore;
        }
        const ladder = [
          ...Object.values(policy.control.mintPostureQuality),
          grading.prudentialReconciled,
          grading.attestationOnlyReconciled,
        ].sort((left, right) => left - right);
        const nextRung = ladder.find((value) => value > gradedPostureScore);
        // Strictly below the next rung: a seasoned credit rewards longevity but can
        // never make a lower posture class read identical to the class above it
        // (adversarial-review finding on the credit widening to 10).
        const ceiling =
          posture === "unbounded-or-compromised"
            ? grading.adverseSeasonedCreditCeiling
            : nextRung === undefined
              ? gradedPostureScore
              : nextRung - 1;
        return Math.min(gradedPostureScore + grading.seasonedCreditPoints, ceiling);
      })();
      // Safety 9.1 merged mint grader: quorum granularity, Safe module evidence,
      // and resolved-incident age decay refine the posture-derived score. The
      // active-incident path above is untouched — a live compromise still pins the
      // posture at unbounded-or-compromised and raises the critical signal.
      const mergedMintScore = applyMergedMintSignals(
        mintPostureScore,
        mintControl,
        args.resolvedIncidentAgeMonths,
        policy.control,
      );
      components.push({
        componentKey: "mint",
        kind: "mint",
        posture,
        score: mergedMintScore,
        binding: mintBinding,
        controlKeys: componentControlKeys,
        failureDomains: componentFailureDomains,
      });
      if (
        posture === "unbounded-reconciled" ||
        posture === "unbounded-reconciliation-unknown" ||
        posture === "unbounded-or-compromised"
      ) {
        // R3 keeps reconciled mint risk inside the control pillar for prudential
        // issuers, emits a diagnostic low signal for attestation-only issuers,
        // and fails closed for absent/unknown supervision. Only an active mint
        // compromise stays critical; an unbounded/unreconciled mint with no active
        // incident takes the high rung so its composite reflects its pillar blend
        // rather than being hard-capped at the critical floor (the 9.32 unknown-
        // reconciliation rung is scored separately above the confirmed floor).
        const prudentiallySupervised = posture === "unbounded-reconciled" && mint.supervision === "prudential";
        const severity: V9Severity | null =
          posture === "unbounded-reconciliation-unknown"
            ? "high"
            : posture === "unbounded-or-compromised"
              ? compromised
                ? "critical"
                : "high"
              : prudentiallySupervised
                ? null
                : mint.supervision === "attestation-only"
                  ? "low"
                  : "high";
        if (severity !== null) {
          addStructuralFailure({
            kind: "centralized-mint",
            severity,
            binding: mintBinding,
            reason:
              posture === "unbounded-reconciliation-unknown"
                ? "Minting is economically unbounded and its reconciliation is unverified."
                : posture === "unbounded-or-compromised"
                  ? "Economically effective minting is unbounded or compromised."
                  : "Minting is economically unbounded but supply is reconciled against reserves.",
            materialSharePct:
              mintControl?.materialSupplyShare == null
                ? null
                : v9StructuralSignalSharePct(
                    args.facts.assetId,
                    "structuralSignals[*].materialSharePct",
                    mintControl.materialSupplyShare,
                  ),
            controlKeys: mintControlKeys,
            failureDomains: mintFailureDomains,
          });
        }
      } else if (posture === "concentrated-admin" || posture === "collateral-gated") {
        addStructuralFailure({
          kind: "centralized-mint",
          severity: "moderate",
          binding: mintBinding,
          reason:
            posture === "collateral-gated"
              ? "Minting is collateral-gated behind a privileged administrator surface."
              : "Minting depends on one concentrated administrator path.",
          materialSharePct:
            mintControl?.materialSupplyShare == null
              ? null
              : v9StructuralSignalSharePct(
                  args.facts.assetId,
                  "structuralSignals[*].materialSharePct",
                  mintControl.materialSupplyShare,
                ),
          controlKeys: mintControlKeys,
          failureDomains: mintFailureDomains,
        });
      }
      if (upgradeUnreviewed) {
        const upgradeBinding =
          upgradeControl === null ? mintBinding : controlBinding(upgradeControl);
        addStructuralFailure({
          kind: "unreviewed-upgrade",
          severity: "high",
          binding: upgradeBinding,
          reason: "Mint-critical upgrade authority is not fully reviewed.",
          materialSharePct:
            upgradeControl?.materialSupplyShare == null
              ? null
              : v9StructuralSignalSharePct(
                  args.facts.assetId,
                  "structuralSignals[*].materialSharePct",
                  upgradeControl.materialSupplyShare,
                ),
          controlKeys: upgradeControlKeys,
          failureDomains: upgradeFailureDomains,
        });
      }
    }
  }

  const oracle = args.oracle;
  if (oracle.status.applicability.state === "not-applicable") {
    // No price-sensitive oracle or internal valuation path exists to score.
    // Not-applicable is neutral rather than evidence of a strong control.
  } else if (oracle.status.applicability.state === "unresolved") {
    addReason("unresolved-oracle-branch-applicability", "local-component", "oracle");
  } else if (oracle.status.observationState !== "known") {
    const code =
      oracle.status.observationState === "missing"
        ? "missing-oracle-profile"
        : oracle.status.observationState === "stale"
          ? "unreviewed-oracle-profile"
          : "incomplete-oracle-liquidation-branch";
    addReason(code, "local-component", "oracle");
  } else {
    const branchesByKind = new Map<V9OracleBranchKind, V9OracleBranchReview>();
    for (const branch of oracle.branches) {
      if (branchesByKind.has(branch.branch)) throw new Error(`Duplicate v9 oracle branch ${branch.branch}`);
      branchesByKind.set(branch.branch, branch);
    }
    const oracleControls = new Map<string, V9DeploymentControlFactV2>();
    const missingBranches =
      oracle.liquidationBranchesApplicable === false
        ? []
        : ORACLE_BRANCHES.filter((branch) => !branchesByKind.has(branch));
    if (missingBranches.length > 0) {
      addReason("missing-required-oracle-branches", "local-component", "oracle:branches");
    }
    for (const branchKind of ORACLE_BRANCHES) {
      const branch = branchesByKind.get(branchKind);
      if (!branch || branch.status.applicability.state === "not-applicable") continue;
      if (branch.status.applicability.state === "unresolved") {
        addReason("unresolved-oracle-branch-applicability", "local-component", `oracle:${branchKind}`);
        continue;
      }
      if (branch.status.observationState !== "known") {
        addReason("incomplete-oracle-liquidation-branch", "local-component", `oracle:${branchKind}`);
        continue;
      }
      if (branch.inheritedFromAssetId !== null && branch.mechanismKey === null) {
        addReason("incomplete-oracle-liquidation-branch", "local-component", `oracle:${branchKind}:inheritance`);
      }
      if (branch.controlKey === null && branch.mechanismKey === null) {
        addReason("incomplete-oracle-liquidation-branch", "local-component", `oracle:${branchKind}`);
        continue;
      }
      if (branch.controlKey !== null) {
        const control = controlsByKey.get(branch.controlKey);
        if (!control || !controlCanRepresent(control, "oracle")) {
          addReason(
            "incomplete-oracle-liquidation-branch",
            "local-component",
            `oracle:${branchKind}`,
            branch.controlKey,
          );
        } else if (!isKnownRequired(control.status)) {
          addReason("unreviewed-oracle-profile", "local-component", `oracle:${branchKind}`, branch.controlKey);
        } else {
          oracleControls.set(control.controlKey, control);
        }
      }
    }
    if (oracle.tier === null) {
      addReason("missing-oracle-profile", "local-component", "oracle:tier");
    } else {
      const linkedControls = [...oracleControls.values()];
      const failureDomains = canonicalDomains(linkedControls.flatMap((control) => control.failureDomains));
      components.push({
        componentKey: "oracle",
        kind: "oracle",
        posture: oracle.tier,
        score: policy.control.oracleTierQuality[oracle.tier],
        binding: true,
        controlKeys: linkedControls.map((control) => control.controlKey).sort(compareText),
        failureDomains,
      });
      if (
        oracle.tier === "single-source-or-laggy" ||
        oracle.tier === "opaque-or-unknown"
      ) {
        addStructuralFailure({
          kind: "weak-oracle-branch",
          severity: oracle.tier === "opaque-or-unknown" ? "critical" : "high",
          binding: true,
          reason: `Oracle control topology is ${oracle.tier}.`,
          materialSharePct: null,
          controlKeys: linkedControls.map((control) => control.controlKey),
          failureDomains,
        });
      }
      // Weak market branches below the deployment-materiality threshold do not
      // drive the material-only tier above, but stay visible as one non-binding
      // diagnostic (5-10% -> moderate@74 ceiling, <5% -> low). It carries a
      // single synthetic failure domain so it never trips the common-mode
      // multi-branch oracle cap, and its ceiling sits above a healthy composite.
      if (oracle.subMaterialWeakBand !== undefined) {
        addStructuralFailure({
          kind: "weak-oracle-branch",
          severity: oracle.subMaterialWeakBand,
          binding: true,
          reason: `Weak oracle branches below the materiality threshold contribute a ${oracle.subMaterialWeakBand} diagnostic.`,
          materialSharePct: null,
          controlKeys: [],
          failureDomains: [{ kind: "oracle-feed", key: `oracle:${args.facts.assetId}:sub-material-weak` }],
        });
      }
    }
  }

  // A bounded bridge review keeps the rows it did review only when the supply it
  // could not attribute is itself immaterial. An unavailable share fails closed:
  // an unknown residual cannot license scoring the known part.
  // An absent share is never read as a measured zero. A null share means no supply
  // partition was produced for this asset at all, not that the partition ran and
  // found no bridge route: on the 2026-08-18 catalogue every one of the 225
  // partitioned assets returned at least one bridge route row, and all 112 assets
  // with an empty partition had null shares. "Partitioned but empty" is not a
  // reachable state, so treating null as zero would only ever license scoring an
  // inventory whose residual was never measured.
  const unknownRouteSupplyShare = args.facts.supply.unknownRouteSupplyShare;
  const unreviewedRouteSupplyShare = args.facts.supply.unreviewedRouteSupplyShare;
  const unattributedBridgeShare =
    unknownRouteSupplyShare === null || unreviewedRouteSupplyShare === null
      ? null
      : Math.min(1, unknownRouteSupplyShare + unreviewedRouteSupplyShare);
  const boundedBridgeGapIsImmaterial =
    unattributedBridgeShare !== null && unattributedBridgeShare < unresolvedFullCeilingShareThreshold;

  const bridge = args.bridge;
  if (bridge.status.applicability.state === "not-applicable") {
    components.push({
      componentKey: "bridge:native",
      kind: "bridge",
      posture: "single-chain-or-native",
      score: policy.control.bridgeTierQuality["single-chain-or-native"],
      binding: true,
      controlKeys: [],
      failureDomains: [],
    });
  } else if (bridge.status.applicability.state === "unresolved") {
    addReason("runtime-bridge-materiality-unavailable", "deployment-control", "bridge");
  } else if (bridge.status.observationState === "missing") {
    addReason("missing-bridge-routes", "deployment-control", "bridge");
  } else if (bridge.status.observationState !== "known" && !boundedBridgeGapIsImmaterial) {
    // Ownership is shape-specific: missing/invalid profiles and ambiguous joins
    // are integration-missing; stale chain input and rejected runtime capture
    // are producer-failed. The fact compiler persists that causal supply gap,
    // so this evaluator emits only the common reason code.
    addReason("runtime-bridge-materiality-unavailable", "deployment-control", "bridge");
  } else {
    // Retain reviewed rows under a bounded residual. An unresolved route
    // contributes no component, but needs no whole-coin fallback when the
    // full cohort is bounded and every selected supply row has a proved join.
    // A reconciled partition may prove a null-share deployment immaterial;
    // that join relief is not admission of an exact share for pricing.
    const completeSubthresholdUnresolvedJoins = evaluateV9SubthresholdUnresolvedBridgeJoins(
      args.facts,
      controls,
      bridge.routes,
      materialShareThreshold,
      policy.materiality.commonModeShareThreshold,
      unresolvedFullCeilingShareThreshold,
    ).complete;
    if (
      bridge.status.observationState !== "known" &&
      !(bridge.status.observationState === "bounded-unknown" && completeSubthresholdUnresolvedJoins)
    ) {
      addReason("runtime-bridge-materiality-unavailable", "deployment-control", "bridge");
    }
    const unresolvedBridgeResidueBinds =
      unattributedBridgeShare === null ||
      (unattributedBridgeShare > 0 && !completeSubthresholdUnresolvedJoins);
    const hasUnresolvedSupplyRows = args.facts.supply.selectedBridgeRoutes.some(
      (route) => route.reviewState !== "selected-reviewed",
    );
    if (bridge.routes.length === 0 && (unresolvedBridgeResidueBinds || !hasUnresolvedSupplyRows)) {
      addReason("missing-bridge-route-rows", "deployment-control", "bridge:routes");
    }
    const seenBridgeControls = new Set<string>();
    for (const route of [...bridge.routes].sort((left, right) => compareText(left.controlKey, right.controlKey))) {
      if (seenBridgeControls.has(route.controlKey)) throw new Error(`Duplicate v9 bridge control ${route.controlKey}`);
      seenBridgeControls.add(route.controlKey);
      const control = controlsByKey.get(route.controlKey);
      if (!control || !controlCanRepresent(control, "bridge")) {
        addReason("selected-bridge-route-missing", "deployment-control", "bridge:route", route.controlKey);
        continue;
      }
      if (!isControlEconomicallyRelevant(control)) continue;
      const nullShareBound = provenNullShareDeploymentBound(args.facts, control);
      const provenImmaterial = nullShareBound !== null && nullShareBound < materialShareThreshold;
      const binding = controlBinding(control, nullShareBound);
      if (!isKnownRequired(control.status)) {
        if (binding) {
          addReason("selected-bridge-route-unresolved", "deployment-control", "bridge:route", route.controlKey);
        }
        continue;
      }
      if (control.economicLossScope === "deployment" && control.materialSupplyShare === null && !provenImmaterial) {
        addReason(
          "runtime-bridge-materiality-unavailable",
          "deployment-control",
          "bridge:route:materiality",
          route.controlKey,
        );
      }
      const selectedSupplyRoute = args.facts.supply.selectedBridgeRoutes.find(
        (supplyRoute) => supplyRoute.deploymentRouteKey === control.deploymentKey,
      );
      if (args.facts.supply.selectedBridgeRoutes.length > 0 && !selectedSupplyRoute && binding) {
        addReason("selected-bridge-route-missing", "deployment-control", "bridge:route:supply", route.controlKey);
      }
      if (selectedSupplyRoute?.reviewState === "selected-unresolved" && binding) {
        addReason("selected-bridge-route-unresolved", "deployment-control", "bridge:route:supply", route.controlKey);
      }
      if (
        selectedSupplyRoute?.reviewState === "unmatched" &&
        selectedSupplyRoute.supplyShare >= materialShareThreshold
      ) {
        addReason("material-bridge-supply-unmatched", "deployment-control", "bridge:supply", route.controlKey);
      }
      components.push({
        componentKey: `bridge:${control.deploymentKey}:${control.controlKey}`,
        kind: "bridge",
        posture: route.tier,
        score: policy.control.bridgeTierQuality[route.tier],
        binding,
        controlKeys: [control.controlKey],
        failureDomains: canonicalDomains(control.failureDomains),
      });
      if (route.tier === "external-lock-mint" || route.tier === "opaque-or-unknown") {
        addStructuralFailure({
          kind: binding ? "material-bridge" : "peripheral-bridge",
          severity: materialBridgeSeverity(
            route.tier,
            control.materialSupplyShare,
            args.policy.policy.semantic.control.materialBridgeHighShareThreshold,
          ),
          binding,
          reason: `Bridge control topology is ${route.tier}.`,
          materialSharePct:
            control.materialSupplyShare === null
              ? null
              : v9StructuralSignalSharePct(
                  args.facts.assetId,
                  "structuralSignals[*].materialSharePct",
                  control.materialSupplyShare,
                ),
          controlKeys: [control.controlKey],
          failureDomains: control.failureDomains,
        });
      }
    }
    // Deliberately null-as-zero, unlike the null-as-unknown residual above: a
    // missing partition never fires the aggregate-residue reasons itself — the
    // non-known observation branches above already carry the fail-closed
    // runtime reason for that case.
    const unknownBridgeShare = Math.min(
      1,
      (unknownRouteSupplyShare ?? 0) + (unreviewedRouteSupplyShare ?? 0),
    );
    // Unknown route supply keeps the deployment-material floor (including the
    // RULED D-J pool). Joined unresolved routes instead use the full-cohort
    // band, so they cannot regain the old 10% ceiling through this residue path.
    if (
      (unknownRouteSupplyShare ?? 0) >= materialShareThreshold ||
      (unknownBridgeShare >= materialShareThreshold && !completeSubthresholdUnresolvedJoins)
    ) {
      addReason("material-bridge-supply-unmatched", "deployment-control", "bridge:supply");
    } else if (unknownBridgeShare > 0 && !completeSubthresholdUnresolvedJoins) {
      addReason("nonmaterial-bridge-supply-unmatched", "deployment-control", "bridge:supply");
    }
  }

  // An unverified review leaves its section with reasons but no component.
  // When the policy treats those reasons as bounded (non-critical), the
  // section scores at the bounded-unknown control quality instead of nulling
  // the pillar; the reason-coded ceiling still bounds the final score. Under
  // critical reasons the pillar stays null regardless of these components.
  const boundedFallbacks = [
    { kind: "mint", componentKey: "mint", posture: "unknown" },
    { kind: "oracle", componentKey: "oracle", posture: "opaque-or-unknown" },
    { kind: "bridge", componentKey: "bridge:unverified", posture: "opaque-or-unknown" },
  ] as const;
  for (const fallback of boundedFallbacks) {
    if (components.some((component) => component.kind === fallback.kind)) continue;
    // Aggregate inventory reasons are section-neutral. A control-specific
    // reason may authorize only the section that control can represent.
    const verifiedGapControlKeys = new Set<string>();
    let hasBindingGap = false;
    let hasUnverifiedGap = false;
    for (const reason of reasons.values()) {
      if (resolveV9ReasonPolicy(args.policy, reason.code).reason.defaultTreatment === "diagnostic") continue;
      const sectionMatch = reason.path === fallback.kind || reason.path.startsWith(`${fallback.kind}:`);
      const reasonControl = reason.controlKey === null ? undefined : controlsByKey.get(reason.controlKey);
      const controlMatch = reasonControl !== undefined && controlFallbackKind(reasonControl) === fallback.kind;
      if (!sectionMatch && !controlMatch) continue;
      hasBindingGap = true;
      // LEVER 5 (2026-07-21): a gap raised by a statically-verified control row
      // (its authority is reviewed; only an adjacent fact such as exposure share
      // or the mechanism review is missing) can be graded on that same row. A
      // section-level gap, or one behind an unverified row, is a genuine unknown
      // and holds the neutral default — this keeps assets whose control facts are
      // NOT verified pinned at the bounded-unknown quality.
      if (reasonControl !== undefined && isStaticallyVerifiedControl(reasonControl)) {
        verifiedGapControlKeys.add(reasonControl.controlKey);
      } else {
        hasUnverifiedGap = true;
      }
    }
    if (!hasBindingGap) continue;
    // Grade on the verified rows' own authority only when every authorizing gap
    // was raised by such a row (condition i: same-row, not asset-generic). The
    // grade may land above OR below the 45 default (condition ii).
    const gradeable = !hasUnverifiedGap && verifiedGapControlKeys.size > 0;
    const gradedControlKeys = uniqueSorted([...verifiedGapControlKeys]);
    const score = gradeable
      ? Math.min(
          ...gradedControlKeys.map((controlKey) =>
            gradeVerifiedControlAuthority(controlsByKey.get(controlKey)!, policy.control),
          ),
        )
      : policy.control.boundedUnknownQuality;
    components.push({
      componentKey: fallback.componentKey,
      kind: fallback.kind,
      posture: fallback.posture,
      score,
      binding: true,
      controlKeys: gradeable ? gradedControlKeys : [],
      failureDomains: [],
    });
  }

  const normalizedReasons = [...reasons.values()].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path, right.path) ||
      compareText(left.controlKey ?? "", right.controlKey ?? ""),
  );
  assertV9ReasonCodesRegistered(
    args.policy,
    normalizedReasons.map((reason) => reason.code),
  );
  const normalizedStructuralFailures = [...structuralFailures.values()].sort(
    (left, right) =>
      compareText(left.kind, right.kind) || compareText(left.controlKeys.join("+"), right.controlKeys.join("+")),
  );
  // Deployment-local adverse loss is owned by proportional deployment risk;
  // retain its component for publication even when it cannot bind the pillar.
  const pricedDeploymentControlKeys = new Set(
    normalizedStructuralFailures
      .filter((failure) => failure.binding && failure.materialSharePct !== null)
      .flatMap((failure) =>
        failure.controlKeys.filter((controlKey) => {
          const control = controlsByKey.get(controlKey);
          return control?.economicLossScope === "deployment" && control.materialSupplyShare !== null;
        }),
      ),
  );
  const scopedDeploymentControlKeys = new Set([
    ...pricedDeploymentControlKeys,
    ...controls
      .filter(
        (control) =>
          control.economicLossScope === "deployment" &&
          !controlBinding(control),
      )
      .map((control) => control.controlKey),
  ]);
  const normalizedComponents: V9ControlComponent[] = [];
  let worstMint: V9ControlComponent | null = null;
  let worstBindingMint: V9ControlComponent | null = null;
  const scopedMintComponents: V9ControlComponent[] = [];
  for (const component of components) {
    const normalized =
      component.binding &&
      component.controlKeys.length > 0 &&
      component.controlKeys.every((controlKey) => scopedDeploymentControlKeys.has(controlKey))
        ? { ...component, binding: false }
        : component;
    if (normalized.kind !== "mint") {
      normalizedComponents.push(normalized);
      continue;
    }
    if (!normalized.binding) scopedMintComponents.push(normalized);
    if (normalized.binding && (worstBindingMint === null || normalized.score < worstBindingMint.score)) {
      worstBindingMint = normalized;
    }
    if (
      worstMint === null ||
      normalized.score < worstMint.score ||
      (normalized.score === worstMint.score && normalized.binding && !worstMint.binding)
    ) {
      worstMint = normalized;
    }
  }
  if (worstMint !== null) normalizedComponents.push(worstMint);
  for (const component of scopedMintComponents) {
    if (component !== worstMint) normalizedComponents.push({
      ...component,
      componentKey: `mint:deployment:${component.controlKeys.join("+")}`,
    });
  }
  if (worstBindingMint !== null && worstBindingMint !== worstMint) {
    normalizedComponents.push({ ...worstBindingMint, componentKey: "mint:binding" });
  }
  normalizedComponents.sort((left, right) => compareText(left.componentKey, right.componentKey));
  const bindingControlFailureDomains = controls
    .filter(isControlEconomicallyRelevant)
    .filter((control) => isKnownRequired(control.status))
    .filter((control) => controlBinding(control))
    .flatMap((control) => control.failureDomains);
  const failureDomains = canonicalDomains([
    ...bindingControlFailureDomains,
    ...normalizedComponents.filter((component) => component.binding).flatMap((component) => component.failureDomains),
    ...normalizedStructuralFailures.filter((failure) => failure.binding).flatMap((failure) => failure.failureDomains),
  ]);
  const critical = normalizedReasons.some((reason) => reason.critical);
  const bindingScores = normalizedComponents
    .filter((component) => component.binding)
    .map((component) => component.score);
  const neutralWithoutBindingControls =
    bindingScores.length === 0 && oracle.status.applicability.state === "not-applicable";
  const score = critical
    ? null
    : bindingScores.length > 0
      ? Math.min(...bindingScores)
      : neutralWithoutBindingControls
        ? V9_NEUTRAL_CONTROL_SCORE
        : null;

  return {
    score,
    state: score === null ? "not-rated" : "rated",
    oracleApplicability: oracle.status.applicability.state,
    components: normalizedComponents,
    reasons: normalizedReasons,
    structuralFailures: normalizedStructuralFailures,
    failureDomains,
  };
}

export function evaluateV9EconomicControlAssetFacts(
  asset: V9EconomicControlAssetSource,
  review: V9EconomicControlReviewExtension,
  policy: V9ValidatedPolicyEnvelope,
): V9EconomicControlResult {
  return evaluateV9EconomicControl(projectV9EconomicControlEvaluation(asset, review, policy));
}
