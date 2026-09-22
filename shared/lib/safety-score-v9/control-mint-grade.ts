import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";
import { isKnownRequired, type V9ControlPolicy } from "./control-primitives";

/**
 * A control row whose authority identity is fully reviewed: it is required-known,
 * its authority model is resolved, and its cap / claim / loss semantics are
 * enumerated. Such a row can carry a residual gap (unknown exposure share, an
 * unresolved mechanism-review) while its *authority* posture is verified.
 */
export function isStaticallyVerifiedControl(control: V9DeploymentControlFactV2): boolean {
  return (
    isKnownRequired(control.status) &&
    control.authority !== null &&
    control.authority.model !== "unknown" &&
    control.capSemantics.kind !== "unknown" &&
    control.claimImpairment !== "unknown" &&
    control.economicLossScope !== "unknown"
  );
}

/**
 * Ascending, de-duplicated ladder of every mint-component quality value the
 * policy can produce. Bounded credits use it so a credit can lift a score
 * towards the next rung but never make a lower posture class read as the class
 * above it (the discipline the seasoned credit already follows).
 */
function mintQualityLadder(controlPolicy: V9ControlPolicy): readonly number[] {
  return [
    ...new Set([
      ...Object.values(controlPolicy.mintPostureQuality),
      controlPolicy.mintPostureGrading.prudentialReconciled,
      controlPolicy.mintPostureGrading.attestationOnlyReconciled,
      controlPolicy.boundedUnknownQuality,
      controlPolicy.mintMergedSignals.attestedKeyCustodyQuality,
    ]),
  ].sort((left, right) => left - right);
}

/**
 * Safety 9.1 — fine multisig quorum ladder. Replaces the binary
 * "threshold >= 2 and strictly more than half, plus a timelock" test with a
 * bounded adjustment over the reviewed threshold, signer set, delay and Safe
 * module surface. Derived strictly from the passed row; a control whose
 * topology was never reviewed takes the conservative unknown rung.
 */
function multisigQuorumRawAdjustment(control: V9DeploymentControlFactV2, controlPolicy: V9ControlPolicy): number {
  const knobs = controlPolicy.mintMergedSignals.multisigQuorumAdjustment;
  const quorum = control.authority?.threshold ?? null;
  if (quorum === null) return knobs.unknownTopology;
  let adjustment =
    quorum.required <= 1
      ? knobs.singleSigner
      : quorum.required === 2
        ? knobs.twoSigner
        : knobs.thresholdThreePlus;
  if (quorum.required >= 4) adjustment += knobs.thresholdFourPlusCredit;
  if (quorum.required * 2 > quorum.total) adjustment += knobs.majorityThresholdCredit;
  if (control.delaySec !== null && control.delaySec > 0) adjustment += knobs.timelockCredit;
  return Math.max(knobs.minAdjustment, adjustment);
}

/**
 * Safety 9.1 — reviewed Safe module/guard surface as a small quality modifier.
 * "none-detected" is positive evidence that no side-door module bypasses the
 * authority path; "present" is a reviewed extension surface. Unknown and
 * not-applicable are inert.
 */
function modulesOrGuardsAdjustment(control: V9DeploymentControlFactV2, controlPolicy: V9ControlPolicy): number {
  const knobs = controlPolicy.mintMergedSignals.modulesOrGuardsAdjustment;
  if (control.modulesOrGuards === "none-detected") return knobs.noneDetectedCredit;
  if (control.modulesOrGuards === "present") return -knobs.presentPenalty;
  return 0;
}

/**
 * Safety 9.1 — resolved-incident age decay. V9 previously penalized only
 * `incidentState: "active"`, so a resolved mint exploit cost nothing at all.
 * The retired Mint Authority engine carried the opposite bias (a permanent cap
 * by incident age). The merged rule keeps the age decay and re-expresses it on
 * V9's ladder: a resolved incident caps the mint component, and the cap relaxes
 * as the incident recedes without ever reaching the clean-record ladder. An
 * unmeasured age fails conservative onto the strictest rung.
 */
function resolvedIncidentQualityCap(
  resolvedIncidentAgeMonths: number | undefined,
  controlPolicy: V9ControlPolicy,
): number {
  const { resolvedIncidentQualityCaps: caps, resolvedIncidentDecayMinMonths: tiers } =
    controlPolicy.mintMergedSignals;
  if (resolvedIncidentAgeMonths === undefined) return caps.recent;
  if (resolvedIncidentAgeMonths >= tiers.dated) return caps.dated;
  if (resolvedIncidentAgeMonths >= tiers.aging) return caps.aging;
  return caps.recent;
}

/**
 * Safety 9.1 — apply the merged mint signals to an already-graded mint
 * component score. Credits are ceiling-bounded below the next ladder rung so a
 * quorum or module credit can never relabel a posture class; penalties floor at
 * the adverse rung so a granularity signal can never invent a worse-than-worst
 * posture. The resolved-incident cap is applied last: it is a ceiling on the
 * merged result, not another additive term.
 */
export function applyMergedMintSignals(
  base: number,
  mintControl: V9DeploymentControlFactV2 | null,
  resolvedIncidentAgeMonths: number | undefined,
  controlPolicy: V9ControlPolicy,
): number {
  // A native/immutable supply mechanism can have a measured historical
  // integrity incident without exposing a live privileged mint controller.
  // The dated review is enough to reuse the existing resolved-incident ladder;
  // it must not require manufacturing a synthetic authority row.
  if (mintControl === null) {
    return resolvedIncidentAgeMonths === undefined
      ? base
      : Math.min(base, resolvedIncidentQualityCap(resolvedIncidentAgeMonths, controlPolicy));
  }
  const signals = controlPolicy.mintMergedSignals;
  let adjustment = 0;
  if (mintControl.authority?.model === "multisig") {
    // `maxAdjustment` is the published component's credit ceiling: on a rated
    // card the quorum ladder's relief may cancel its own penalty but must not
    // manufacture a lift out of an unchanged posture.
    adjustment += Math.min(
      signals.multisigQuorumAdjustment.maxAdjustment,
      multisigQuorumRawAdjustment(mintControl, controlPolicy),
    );
  }
  // A bare externally-owned mint key is a single-point custody failure that the
  // cap/claim-derived posture cannot see. Reviewed MPC or HSM custody
  // reclassifies it as an issuer-operated backend and waives the penalty — the
  // treatment the retired Mint Authority engine applied to the same fact.
  if (
    mintControl.authority?.model === "eoa" &&
    mintControl.keyCustody !== "mpc" &&
    mintControl.keyCustody !== "hsm"
  ) {
    adjustment -= signals.unattestedEoaPenalty;
  }
  adjustment += modulesOrGuardsAdjustment(mintControl, controlPolicy);
  let score = base;
  if (adjustment > 0) {
    const nextRung = mintQualityLadder(controlPolicy).find((value) => value > base);
    const ceiling = nextRung === undefined ? base : nextRung - 1;
    score = Math.min(base + adjustment, Math.max(base, ceiling));
  } else if (adjustment < 0) {
    score = Math.max(base + adjustment, controlPolicy.mintPostureQuality["unbounded-or-compromised"]);
  }
  if (mintControl.incidentState === "resolved") {
    score = Math.min(score, resolvedIncidentQualityCap(resolvedIncidentAgeMonths, controlPolicy));
  }
  return score;
}

/**
 * LEVER 5 (2026-07-21): grade a verified control row on its own authority facts
 * instead of the bounded-unknown default. Derives strictly from the passed row
 * (wards / Safe threshold / timelock / authority.model), never from asset-generic
 * facts, and grades UP or DOWN relative to the 45 default: a live compromise or an
 * economically unbounded control grades below it, a hardened governed/multisig
 * path above it. issuer-backend and unknown authority stay at the neutral default.
 *
 * AUTHORITY-LADDER 9.46: `validator-quorum` — an external message-validation
 * quorum (LayerZero DVN set, CCIP DON/RMN, Bantu AMTP group, IBC light-client
 * validator set) — is known-but-weak and also holds at the neutral default. The
 * adopted ruling is that it grades at or below `issuer-backend` and never above a
 * named multisig; the multisig branch below starts from `concentrated-admin`,
 * which is strictly above this rung, so naming a validation domain can never lift
 * a control into the multisig class.
 */
export function gradeVerifiedControlAuthority(control: V9DeploymentControlFactV2, controlPolicy: V9ControlPolicy): number {
  const quality = controlPolicy.mintPostureQuality;
  const authority = control.authority;
  if (authority === null || authority.model === "unknown") return controlPolicy.boundedUnknownQuality;

  // A live compromise or an economically unbounded control is weak regardless of
  // who holds the key: grade it below the neutral default, never above.
  if (
    control.incidentState === "active" ||
    control.capSemantics.kind === "unbounded" ||
    control.claimImpairment === "unbounded"
  ) {
    return quality["unbounded-or-compromised"];
  }

  const timelocked = control.delaySec !== null && control.delaySec > 0;
  switch (authority.model) {
    case "none":
      // No live authority path (renounced / immutable) is the strongest posture.
      return quality["none-resolved"];
    case "contract":
      return quality["bounded-admin"];
    case "governance":
      return timelocked ? quality["bounded-admin"] : quality["partially-bounded-admin"];
    case "multisig": {
      // Safety 9.1: the fine quorum ladder replaces the binary strong-quorum
      // test. It grades from the concentrated rung and is bounded by the
      // partially-bounded rung above and the adverse rung below, so quorum
      // granularity refines this row's grade without relabelling its class.
      // This path starts from the concentrated rung by construction rather than
      // from the asset's own posture, so it grades on the raw ladder and takes
      // its ceiling from the partially-bounded rung below.
      const graded =
        quality["concentrated-admin"] +
        multisigQuorumRawAdjustment(control, controlPolicy) +
        modulesOrGuardsAdjustment(control, controlPolicy);
      return Math.max(
        quality["unbounded-or-compromised"],
        Math.min(graded, quality["partially-bounded-admin"]),
      );
    }
    case "issuer-backend":
      // A centralized backend key with a bounded claim is neither a lift nor a
      // clear danger on static facts alone: hold at the neutral default.
      return controlPolicy.boundedUnknownQuality;
    case "validator-quorum":
      // An external validation quorum is a named, public failure domain — it is
      // no longer unknown — but its membership rotates and no individual signer
      // is accountable, so it earns no lift over the centralized-backend rung.
      return controlPolicy.boundedUnknownQuality;
    case "eoa":
      // Safety 9.1: an externally-owned key under reviewed MPC or HSM custody is
      // an issuer-operated backend, not a bare single key — the reclassification
      // the retired Mint Authority engine already made. Unattested single keys
      // keep the weak posture.
      if (control.keyCustody === "mpc" || control.keyCustody === "hsm") {
        return controlPolicy.mintMergedSignals.attestedKeyCustodyQuality;
      }
      // A single externally-owned key is a weak control posture: grade below 45.
      return quality["unbounded-or-compromised"];
    default:
      return controlPolicy.boundedUnknownQuality;
  }
}
