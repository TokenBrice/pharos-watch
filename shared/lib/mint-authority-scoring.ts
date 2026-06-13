import type {
  MintAuthorityConfidence,
  MintAuthorityControl,
  MintAuthorityDirectMintAbility,
  MintAuthorityMintPath,
  MintAuthorityPosture,
  MintAuthorityProfile,
  MintAuthorityType,
  StablecoinMeta,
} from "../types/core";

const MINT_AUTHORITY_COMPONENT_WEIGHTS = {
  route: 0.3,
  controller: 0.4,
  bounds: 0.15,
  posture: 0.15,
} as const;

export const MINT_ROUTE_SCORES = {
  "immutable-user-collateralized": 100,
  "user-collateralized-governed": 75,
  "m0-permissioned-minter": 60,
  "facilitator-bucket-mint": 60,
  "permissioned-minter": 50,
  "amo-or-custodian-hybrid": 45,
  "issuer-direct-mint": 40,
  "offchain-attested-minter": 35,
  "bridge-or-oft-synthetic": 30,
} as const satisfies Partial<Record<MintAuthorityMintPath, number>>;

const MINT_POSTURE_SCORES = {
  "none-resolved": 100,
  "bounded-admin": 85,
  "partially-bounded-admin": 60,
  "concentrated-admin": 35,
  "unbounded-or-compromised": 5,
} as const satisfies Partial<Record<MintAuthorityPosture, number>>;

const MINT_CONTROLLER_BASE_SCORES = {
  none: 100,
  timelock: 85,
  "dao-governor": 80,
  contract: 75,
  custodian: 45,
  "issuer-backend": 40,
  bridge: 40,
  eoa: 15,
  unknown: 25,
} as const satisfies Record<Exclude<MintAuthorityType, "safe" | "multisig">, number>;

const MINT_MULTISIG_THRESHOLD_SCORES = {
  unknown: 40,
  singleSigner: 20,
  twoSigner: 40,
  thresholdThreePlus: 60,
} as const;

const MINT_MULTISIG_BONUSES = {
  thresholdFourPlus: 5,
  thresholdAtLeastHalfSignerSet: 5,
  noModulesOrGuardsDetected: 10,
} as const;

const MINT_MULTISIG_MAX_SCORE = 80;

const MINT_CONTROLLER_BONUSES = {
  timelockDelaySec: 86_400,
  timelock: 10,
  capLimited: 10,
  upgradeOnly: 5,
} as const;

const MINT_AUTHORITY_INHERITANCE_BLEND = {
  parentWeight: 0.6,
  wrapperWeight: 0.4,
} as const;

const MINT_BOUNDS_SCORES = {
  noneResolved: 100,
  noMintCapableControls: 50,
  noCappedControls: 30,
  allNonUpgradeControlsCapped: 75,
  partiallyCappedControls: 55,
  immutableCapBonus: 10,
} as const;

export const MINT_AUTHORITY_CAPS = {
  /** Most recent recorded mint incident is under 2 years old. */
  incidentRecent: 10,
  /** Most recent incident is 2-4 years old. */
  incidentAging: 15,
  /** Most recent incident is 4+ years old; still below the no-incident unbounded cap. */
  incidentDated: 20,
  unbounded: 25,
  eoa: 40,
} as const;

/** Incident-age decay tier boundaries (years since the most recent incident). */
const MINT_AUTHORITY_INCIDENT_DECAY_YEARS = { aging: 2, dated: 4 } as const;

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Purely time-based incident-cap decay (methodology v1.1): the cap relaxes with
 * the age of the most recent recorded incident but never reaches the
 * no-incident unbounded cap. Unparseable or missing dates stay at the
 * strictest tier.
 */
function resolveIncidentCap(
  incidents: NonNullable<MintAuthorityProfile["mintIncidents"]>,
  nowMs: number,
): number {
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const incident of incidents) {
    const parsed = Date.parse(`${incident.date}T00:00:00Z`);
    if (Number.isFinite(parsed) && parsed > latestMs) latestMs = parsed;
  }
  if (!Number.isFinite(latestMs)) return MINT_AUTHORITY_CAPS.incidentRecent;
  const ageYears = (nowMs - latestMs) / YEAR_MS;
  if (ageYears >= MINT_AUTHORITY_INCIDENT_DECAY_YEARS.dated) return MINT_AUTHORITY_CAPS.incidentDated;
  if (ageYears >= MINT_AUTHORITY_INCIDENT_DECAY_YEARS.aging) return MINT_AUTHORITY_CAPS.incidentAging;
  return MINT_AUTHORITY_CAPS.incidentRecent;
}

const MINT_AUTHORITY_CONFIDENCE_CAPS = {
  verified: 100,
  probable: 90,
  "manual-review": 85,
} as const satisfies Partial<Record<MintAuthorityConfidence, number>>;

const MINT_AUTHORITY_MINT_CAPABLE_ABILITIES = [
  "direct",
  "can-authorize",
  "cap-limited",
  "upgrade-only",
] as const satisfies readonly MintAuthorityDirectMintAbility[];

const MINT_AUTHORITY_ISSUER_CONTEXT_PATHS = [
  "issuer-direct-mint",
  "offchain-attested-minter",
] as const satisfies readonly MintAuthorityMintPath[];

const MINT_CAPABLE_ABILITIES = new Set<MintAuthorityDirectMintAbility>(MINT_AUTHORITY_MINT_CAPABLE_ABILITIES);
const ISSUER_CONTEXT_PATHS = new Set<MintAuthorityMintPath>(MINT_AUTHORITY_ISSUER_CONTEXT_PATHS);

export type MintAuthorityScoreBand = "hardened" | "governed" | "managed" | "concentrated" | "exposed";

export const MINT_AUTHORITY_SCORE_BANDS: Record<
  MintAuthorityScoreBand,
  { min: number; label: string }
> = {
  hardened: { min: 80, label: "Hardened" },
  governed: { min: 65, label: "Governed" },
  managed: { min: 50, label: "Managed" },
  concentrated: { min: 35, label: "Concentrated" },
  exposed: { min: Number.NEGATIVE_INFINITY, label: "Exposed" },
};

export type MintAuthorityCapKind = "incident-cap" | "unbounded-cap" | "eoa-cap" | "confidence-cap";

export interface MintAuthorityScoringControlInput {
  label?: string;
  authorityType: MintAuthorityType;
  directMintAbility: MintAuthorityDirectMintAbility;
  threshold?: number;
  signerCount?: number;
  timelockDelaySec?: number;
  canRaiseCap?: boolean | "unknown";
  modulesOrGuardsStatus?: MintAuthorityControl["modulesOrGuardsStatus"];
  keyCustodyAttestation?: MintAuthorityControl["keyCustodyAttestation"];
}

export interface MintAuthorityScoringInput {
  id?: string;
  mintPath: MintAuthorityMintPath;
  authorityPosture: MintAuthorityPosture;
  confidence: MintAuthorityConfidence;
  inheritedFrom?: string;
  mintIncidents?: MintAuthorityProfile["mintIncidents"];
  controls?: readonly MintAuthorityScoringControlInput[];
}

export interface MintAuthorityWeakestControlResult {
  index: number;
  label: string | null;
  score: number;
  authorityType: MintAuthorityType;
  directMintAbility: MintAuthorityDirectMintAbility;
  custodyLabel: "Single-key address - custody unverifiable" | "Single-key address - MPC-attested" | "Single-key address - HSM-attested" | null;
}

export interface MintAuthorityScoreComponents {
  route: number | null;
  controller: number | null;
  bounds: number | null;
  posture: number | null;
}

export interface MintAuthorityScoreResult {
  score: number | null;
  band: MintAuthorityScoreBand | null;
  bandLabel: string;
  components: MintAuthorityScoreComponents;
  weakestControl: MintAuthorityWeakestControlResult | null;
  capsApplied: MintAuthorityCapKind[];
  confidenceCap: number | null;
  inheritedFromId: string | null;
  unresolvedReason: string | null;
  rawScore: number | null;
}

export type MintAuthorityParentResolver = (id: string) => MintAuthorityScoringInput | null | undefined;

export function isMintCapableAbility(ability: MintAuthorityDirectMintAbility): boolean {
  return MINT_CAPABLE_ABILITIES.has(ability);
}

export function resolveMintAuthorityScoreBand(score: number | null | undefined): MintAuthorityScoreBand | null {
  if (score == null || !Number.isFinite(score)) return null;
  if (score >= MINT_AUTHORITY_SCORE_BANDS.hardened.min) return "hardened";
  if (score >= MINT_AUTHORITY_SCORE_BANDS.governed.min) return "governed";
  if (score >= MINT_AUTHORITY_SCORE_BANDS.managed.min) return "managed";
  if (score >= MINT_AUTHORITY_SCORE_BANDS.concentrated.min) return "concentrated";
  return "exposed";
}

function toMintAuthorityScoringInput(
  id: string,
  profile?: MintAuthorityProfile | null,
): MintAuthorityScoringInput | null {
  if (!profile) return null;
  return {
    id,
    mintPath: profile.mintPath,
    authorityPosture: profile.authorityPosture,
    confidence: profile.confidence,
    inheritedFrom: profile.inheritedFrom,
    mintIncidents: profile.mintIncidents,
    controls: profile.controls,
  };
}

export function stablecoinToMintAuthorityScoringInput(
  coin?: Pick<StablecoinMeta, "id" | "mintAuthority"> | null,
): MintAuthorityScoringInput | null {
  return coin ? toMintAuthorityScoringInput(coin.id, coin.mintAuthority) : null;
}

function nullResult(reason: string, inheritedFromId: string | null = null): MintAuthorityScoreResult {
  return {
    score: null,
    band: null,
    bandLabel: "NR",
    components: { route: null, controller: null, bounds: null, posture: null },
    weakestControl: null,
    capsApplied: [],
    confidenceCap: null,
    inheritedFromId,
    unresolvedReason: reason,
    rawScore: null,
  };
}

function finalizeResult(args: {
  score: number;
  rawScore: number;
  components: MintAuthorityScoreComponents;
  weakestControl: MintAuthorityWeakestControlResult | null;
  capsApplied: MintAuthorityCapKind[];
  confidenceCap: number;
  inheritedFromId?: string | null;
}): MintAuthorityScoreResult {
  const score = Math.max(0, Math.min(100, Math.round(args.score)));
  const band = resolveMintAuthorityScoreBand(score);
  return {
    score,
    band,
    bandLabel: band ? MINT_AUTHORITY_SCORE_BANDS[band].label : "NR",
    components: args.components,
    weakestControl: args.weakestControl,
    // Inherited results carry the parent's trace; a wrapper re-applying the
    // same cap (e.g. unbounded-cap on both) must not list it twice.
    capsApplied: [...new Set(args.capsApplied)],
    confidenceCap: args.confidenceCap,
    inheritedFromId: args.inheritedFromId ?? null,
    unresolvedReason: null,
    rawScore: args.rawScore,
  };
}

function hasKeyCustodyAttestation(control: MintAuthorityScoringControlInput): boolean {
  return control.keyCustodyAttestation?.kind === "mpc" || control.keyCustodyAttestation?.kind === "hsm";
}

function resolveConfidenceCap(confidence: MintAuthorityConfidence): number | null {
  const caps: Partial<Record<MintAuthorityConfidence, number>> = MINT_AUTHORITY_CONFIDENCE_CAPS;
  return caps[confidence] ?? null;
}

function isIssuerContextPath(path: MintAuthorityMintPath): boolean {
  return ISSUER_CONTEXT_PATHS.has(path);
}

function scoreMultisigControl(control: MintAuthorityScoringControlInput): number {
  const threshold = control.threshold;
  let score: number;

  if (threshold == null) {
    // Unknown Safe topology keeps the historical 2-of-N-equivalent score.
    score = MINT_MULTISIG_THRESHOLD_SCORES.unknown;
  } else if (threshold <= 1) {
    score = MINT_MULTISIG_THRESHOLD_SCORES.singleSigner;
  } else if (threshold === 2) {
    score = MINT_MULTISIG_THRESHOLD_SCORES.twoSigner;
  } else {
    score =
      MINT_MULTISIG_THRESHOLD_SCORES.thresholdThreePlus +
      (threshold >= 4 ? MINT_MULTISIG_BONUSES.thresholdFourPlus : 0);
  }

  if (threshold != null && control.signerCount != null && control.signerCount > 0 && threshold / control.signerCount >= 0.5) {
    score += MINT_MULTISIG_BONUSES.thresholdAtLeastHalfSignerSet;
  }
  if (control.modulesOrGuardsStatus === "none-detected") {
    score += MINT_MULTISIG_BONUSES.noModulesOrGuardsDetected;
  }

  return Math.min(score, MINT_MULTISIG_MAX_SCORE);
}

function getEoaCustodyLabel(
  control: MintAuthorityScoringControlInput,
): MintAuthorityWeakestControlResult["custodyLabel"] {
  if (control.authorityType !== "eoa") return null;
  if (control.keyCustodyAttestation?.kind === "mpc") return "Single-key address - MPC-attested";
  if (control.keyCustodyAttestation?.kind === "hsm") return "Single-key address - HSM-attested";
  return "Single-key address - custody unverifiable";
}

export function scoreMintAuthorityControl(
  control: MintAuthorityScoringControlInput,
  mintPath: MintAuthorityMintPath,
): number {
  let base: number;

  if (control.authorityType === "safe" || control.authorityType === "multisig") {
    base = scoreMultisigControl(control);
  } else if (control.authorityType === "eoa" && (hasKeyCustodyAttestation(control) || isIssuerContextPath(mintPath))) {
    base = MINT_CONTROLLER_BASE_SCORES["issuer-backend"];
  } else {
    base = MINT_CONTROLLER_BASE_SCORES[control.authorityType] ?? MINT_CONTROLLER_BASE_SCORES.unknown;
  }

  if ((control.timelockDelaySec ?? 0) >= MINT_CONTROLLER_BONUSES.timelockDelaySec) {
    base += MINT_CONTROLLER_BONUSES.timelock;
  }
  if (control.directMintAbility === "cap-limited") {
    base += MINT_CONTROLLER_BONUSES.capLimited;
  }
  if (control.directMintAbility === "upgrade-only") {
    base += MINT_CONTROLLER_BONUSES.upgradeOnly;
  }

  return Math.max(0, Math.min(100, base));
}

function buildWeakestControl(
  controls: readonly MintAuthorityScoringControlInput[],
  mintPath: MintAuthorityMintPath,
): MintAuthorityWeakestControlResult | null {
  let weakest: MintAuthorityWeakestControlResult | null = null;

  controls.forEach((control, index) => {
    if (!isMintCapableAbility(control.directMintAbility)) return;
    const score = scoreMintAuthorityControl(control, mintPath);
    if (weakest === null || score < weakest.score) {
      weakest = {
        index,
        label: control.label ?? null,
        score,
        authorityType: control.authorityType,
        directMintAbility: control.directMintAbility,
        custodyLabel: getEoaCustodyLabel(control),
      };
    }
  });

  return weakest;
}

export function scoreMintAuthorityBounds(
  controls: readonly MintAuthorityScoringControlInput[],
  posture: MintAuthorityPosture,
): number {
  if (posture === "none-resolved") return MINT_BOUNDS_SCORES.noneResolved;

  const mintCapable = controls.filter((control) => isMintCapableAbility(control.directMintAbility));
  if (mintCapable.length === 0) return MINT_BOUNDS_SCORES.noMintCapableControls;

  const capped = mintCapable.filter((control) => control.directMintAbility === "cap-limited");
  if (capped.length === 0) return MINT_BOUNDS_SCORES.noCappedControls;

  // Upgrade-only controls do not mint directly, so they stay out of the
  // "every active minter is capped" denominator.
  const nonUpgradeMintCapable = mintCapable.filter((control) => control.directMintAbility !== "upgrade-only");
  const allNonUpgradeControlsAreCapped = capped.length === nonUpgradeMintCapable.length;
  const capCanBeRaised = capped.some((control) => control.canRaiseCap === true);

  return (
    (allNonUpgradeControlsAreCapped
      ? MINT_BOUNDS_SCORES.allNonUpgradeControlsCapped
      : MINT_BOUNDS_SCORES.partiallyCappedControls) +
    (capCanBeRaised ? 0 : MINT_BOUNDS_SCORES.immutableCapBonus)
  );
}

function hasEoaCapTrigger(input: MintAuthorityScoringInput): boolean {
  if (isIssuerContextPath(input.mintPath)) return false;
  return (input.controls ?? []).some(
    (control) =>
      control.authorityType === "eoa" &&
      !hasKeyCustodyAttestation(control) &&
      (control.directMintAbility === "direct" || control.directMintAbility === "can-authorize"),
  );
}

function applyCaps(
  score: number,
  input: MintAuthorityScoringInput,
  confidenceCap: number,
  capsApplied: MintAuthorityCapKind[],
  nowMs: number,
): number {
  let cappedScore = score;

  if (input.authorityPosture === "unbounded-or-compromised") {
    if (input.mintIncidents && input.mintIncidents.length > 0) {
      cappedScore = Math.min(cappedScore, resolveIncidentCap(input.mintIncidents, nowMs));
      capsApplied.push("incident-cap");
    } else {
      cappedScore = Math.min(cappedScore, MINT_AUTHORITY_CAPS.unbounded);
      capsApplied.push("unbounded-cap");
    }
  }

  if (hasEoaCapTrigger(input)) {
    cappedScore = Math.min(cappedScore, MINT_AUTHORITY_CAPS.eoa);
    capsApplied.push("eoa-cap");
  }

  if (cappedScore > confidenceCap) {
    cappedScore = confidenceCap;
    capsApplied.push("confidence-cap");
  }

  return cappedScore;
}

function computeInheritedScore(
  input: MintAuthorityScoringInput,
  resolveParent: MintAuthorityParentResolver | undefined,
  depth: number,
  seenIds: ReadonlySet<string>,
  nowMs: number,
): MintAuthorityScoreResult {
  const inheritedFromId = input.inheritedFrom ?? null;
  if (!inheritedFromId) return nullResult("missing-parent", inheritedFromId);
  if (!resolveParent) return nullResult("parent-resolver-missing", inheritedFromId);
  if (depth >= 3) return nullResult("inheritance-depth-limit", inheritedFromId);
  if (seenIds.has(inheritedFromId)) return nullResult("inheritance-cycle", inheritedFromId);

  const parent = resolveParent(inheritedFromId);
  if (!parent) return nullResult("parent-not-found", inheritedFromId);

  const nextSeen = new Set(seenIds);
  if (input.id) nextSeen.add(input.id);
  const parentResult = computeMintAuthorityScore(
    { ...parent, id: parent.id ?? inheritedFromId },
    resolveParent,
    depth + 1,
    nextSeen,
    nowMs,
  );
  if (parentResult.score == null) {
    return nullResult(
      parentResult.unresolvedReason === "inheritance-cycle" ? "inheritance-cycle" : "parent-not-scoreable",
      inheritedFromId,
    );
  }

  const confidenceCap = resolveConfidenceCap(input.confidence);
  if (confidenceCap == null) return nullResult("unknown-confidence", inheritedFromId);

  const weakestWrapperControl = buildWeakestControl(input.controls ?? [], input.mintPath);
  const rawScore =
    weakestWrapperControl == null
      ? parentResult.score
      : Math.min(
          parentResult.score,
          Math.round(
            parentResult.score * MINT_AUTHORITY_INHERITANCE_BLEND.parentWeight +
              weakestWrapperControl.score * MINT_AUTHORITY_INHERITANCE_BLEND.wrapperWeight,
          ),
        );
  const capsApplied = [...parentResult.capsApplied];
  const cappedScore = applyCaps(rawScore, input, confidenceCap, capsApplied, nowMs);

  return finalizeResult({
    score: cappedScore,
    rawScore,
    components: {
      ...parentResult.components,
      controller: weakestWrapperControl?.score ?? parentResult.components.controller,
    },
    weakestControl: weakestWrapperControl ?? parentResult.weakestControl,
    capsApplied,
    confidenceCap,
    inheritedFromId,
  });
}

export function computeMintAuthorityScore(
  input?: MintAuthorityScoringInput | null,
  resolveParent?: MintAuthorityParentResolver,
  depth = 0,
  seenIds: ReadonlySet<string> = new Set(),
  // Incident-cap decay reference time; injectable for deterministic tests.
  nowMs: number = Date.now(),
): MintAuthorityScoreResult {
  if (!input) return nullResult("not-reviewed");
  if (input.id && seenIds.has(input.id)) return nullResult("inheritance-cycle");
  if (input.mintPath === "unknown") return nullResult("unknown-mint-path");
  if (input.authorityPosture === "unknown") return nullResult("unknown-posture");
  if (input.confidence === "unknown") return nullResult("unknown-confidence");

  if (input.mintPath === "wrapped-or-variant-inherited") {
    return computeInheritedScore(input, resolveParent, depth, seenIds, nowMs);
  }

  const route = MINT_ROUTE_SCORES[input.mintPath];
  const posture = MINT_POSTURE_SCORES[input.authorityPosture];
  const confidenceCap = resolveConfidenceCap(input.confidence);
  if (route == null) return nullResult("unscored-route");
  if (posture == null) return nullResult("unscored-posture");
  if (confidenceCap == null) return nullResult("unknown-confidence");

  const controls = input.controls ?? [];
  const weakestControl = buildWeakestControl(controls, input.mintPath);
  const controller = weakestControl?.score ?? posture;
  const bounds = scoreMintAuthorityBounds(controls, input.authorityPosture);
  const components = { route, controller, bounds, posture };
  const rawScore = Math.round(
    route * MINT_AUTHORITY_COMPONENT_WEIGHTS.route +
      controller * MINT_AUTHORITY_COMPONENT_WEIGHTS.controller +
      bounds * MINT_AUTHORITY_COMPONENT_WEIGHTS.bounds +
      posture * MINT_AUTHORITY_COMPONENT_WEIGHTS.posture,
  );
  const capsApplied: MintAuthorityCapKind[] = [];
  const cappedScore = applyCaps(rawScore, input, confidenceCap, capsApplied, nowMs);

  return finalizeResult({
    score: cappedScore,
    rawScore,
    components,
    weakestControl,
    capsApplied,
    confidenceCap,
    inheritedFromId: null,
  });
}
