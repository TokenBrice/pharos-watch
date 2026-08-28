import type {
  MintAuthorityClientControlSummary,
  MintAuthorityClientSummary,
} from "@shared/types/stablecoin-client-meta";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress } from "@shared/lib/format";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  resolveMintAuthorityScoreDisplay,
  type MintAuthorityScoreDisplay,
  type PublishedMintComponent,
} from "@/lib/mint-authority-display";
import { formatMintAuthorityCustodyAttestation } from "@/lib/stablecoin-detail-mint-authority-format";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-client-coin";
/**
 * A single externally-owned key is presented as unverifiable custody unless the
 * review carries an MPC or HSM attestation. Safety 9.1 keeps the label local:
 * it is a description of the curated control row, not a score input.
 */
const EOA_UNVERIFIED_CUSTODY_LABEL = "Single-key address - custody unverifiable";

export type MintAuthorityDetailStatus = "reviewed" | "not-reviewed";

export type MintAuthorityPostureTone = "minimized" | "neutral" | "elevated";

export interface MintAuthorityDetailSourceViewModel {
  label: string;
  url: string;
}

export interface MintAuthorityDetailControlViewModel {
  key: string;
  label: string;
  roleLabel: string;
  /** Raw bounded key ("multisig", "safe", "eoa", …) for glyph dispatch. */
  authorityTypeKey: string;
  authorityTypeLabel: string;
  /** Numeric threshold/signers when published, for signer-dot rendering. */
  threshold: number | null;
  signerCount: number | null;
  directMintAbilityLabel: string;
  locationLabel: string;
  fullLocationLabel: string;
  addressUrl: string | null;
  securitySetupLabel: string;
  thresholdLabel: string | null;
  timelockLabel: string | null;
  capDescription: string | null;
  modulesOrGuardsLabel: string | null;
  custodyLabel: string | null;
}

export interface MintAuthorityDetailScoreCapViewModel {
  kind: string;
  label: string;
  limitLabel: string;
  reason: string;
}

export interface MintAuthorityDetailIncidentViewModel {
  date: string;
  status: "active" | "resolved";
  resolvedAt: string | null;
  summary: string;
  sources: MintAuthorityDetailSourceViewModel[];
}

/**
 * Safety 9.1: the detail card renders the published V9 mint component. The
 * retired standalone engine's route/controller/bounds/posture decomposition,
 * confidence cap and weakest-control trace have no counterpart in the control
 * pillar, so the card shows what the pillar actually publishes: the graded
 * component, its posture band, and the structural caps the posture raised.
 */
export interface MintAuthorityDetailScoreViewModel {
  score: number | null;
  scoreLabel: string;
  compactLabel: string;
  /** Published posture band key ("hardened" … "exposed" | "nr") for the band ladder. */
  bandKey: string;
  bandLabel: string;
  postureLabel: string;
  badgeClassName: string;
  textClassName: string;
  detail: string;
  caps: MintAuthorityDetailScoreCapViewModel[];
}

export interface MintAuthorityDetailViewModel {
  status: MintAuthorityDetailStatus;
  reviewLabel: string;
  mintPathLabel: string;
  /** Passport-short projection of the mint path (hero strip width budget). */
  mintPathShortLabel: string;
  authorityPostureLabel: string;
  authorityPostureTone: MintAuthorityPostureTone;
  confidenceLabel: string;
  confidenceVerified: boolean;
  summary: string;
  inheritedFrom: string | null;
  controls: MintAuthorityDetailControlViewModel[];
  sources: MintAuthorityDetailSourceViewModel[];
  score: MintAuthorityDetailScoreViewModel | null;
  reviewedAt: string | null;
  mintIncidents: MintAuthorityDetailIncidentViewModel[];
  sourceFreeRationale: string | null;
  unresolvedQuestions: string[];
}

const NOT_REVIEWED_MINT_AUTHORITY: MintAuthorityDetailViewModel = {
  status: "not-reviewed",
  reviewLabel: "Not reviewed by Pharos",
  mintPathLabel: "Unknown",
  mintPathShortLabel: "Unknown",
  authorityPostureLabel: "Unknown",
  authorityPostureTone: "neutral",
  confidenceLabel: "Not reviewed",
  confidenceVerified: false,
  summary:
    "Pharos has not published a mint authority review for this stablecoin yet. Unknown does not mean no privileged mint authority.",
  inheritedFrom: null,
  controls: [],
  sources: [],
  score: null,
  reviewedAt: null,
  mintIncidents: [],
  sourceFreeRationale: null,
  unresolvedQuestions: [],
};

const MINT_PATH_LABELS: Record<string, string> = {
  "immutable-user-collateralized": "Immutable user-collateralized",
  "user-collateralized-governed": "User-collateralized, governed",
  "issuer-direct-mint": "Issuer direct mint",
  "permissioned-minter": "Permissioned minter",
  "offchain-attested-minter": "Off-chain attested minter",
  "facilitator-bucket-mint": "Facilitator bucket mint",
  "amo-or-custodian-hybrid": "AMO or custodian hybrid",
  "bridge-or-oft-synthetic": "Bridge or OFT synthetic",
  "m0-permissioned-minter": "M0 permissioned minter",
  "wrapped-or-variant-inherited": "Wrapped or inherited",
  unknown: "Unknown",
};

// Hero passport-strip projection of MINT_PATH_LABELS — authored-short for the
// strip's one-line width budget. The MintAuthoritySection card and the
// passport aria-label keep the full labels.
const MINT_PATH_PASSPORT_LABELS: Record<string, string> = {
  "immutable-user-collateralized": "Immutable CDP",
  "user-collateralized-governed": "Governed CDP",
  "issuer-direct-mint": "Issuer direct",
  "permissioned-minter": "Permissioned",
  "offchain-attested-minter": "Attested minter",
  "facilitator-bucket-mint": "Facilitator",
  "amo-or-custodian-hybrid": "AMO hybrid",
  "bridge-or-oft-synthetic": "Bridge synthetic",
  "m0-permissioned-minter": "M0 minter",
  "wrapped-or-variant-inherited": "Wrapped / inherited",
  unknown: "Unknown",
};

const AUTHORITY_POSTURE_LABELS: Record<string, string> = {
  "none-resolved": "No privileged mint resolved",
  "none-resolved-mint": "No privileged mint path",
  "bounded-admin": "Bounded admin",
  "partially-bounded-admin": "Partially bounded admin",
  "unbounded-reconciled": "Unbounded, supervised & reconciled",
  "concentrated-admin": "Concentrated admin",
  "unbounded-or-compromised": "Unbounded or compromised",
  unknown: "Unknown",
};

const AUTHORITY_POSTURE_TONES: Record<string, MintAuthorityPostureTone> = {
  "none-resolved": "minimized",
  // Same tone as `none-resolved`: the finding about the mint path is identical,
  // only its scope is narrower. Other control domains carry their own signals.
  "none-resolved-mint": "minimized",
  "bounded-admin": "minimized",
  "partially-bounded-admin": "neutral",
  // Same elevated tone as the rest of the unbounded/concentrated tier: the
  // supervision is real, but the minting is still economically unbounded.
  "unbounded-reconciled": "elevated",
  "concentrated-admin": "elevated",
  "unbounded-or-compromised": "elevated",
  unknown: "neutral",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  verified: "Verified",
  probable: "Probable",
  "manual-review": "Manual review",
  unknown: "Unknown",
};

const CONTROL_ROLE_LABELS: Record<string, string> = {
  "direct-minter": "Direct minter",
  "minter-admin": "Minter admin",
  facilitator: "Facilitator",
  "bucket-admin": "Bucket admin",
  "cap-admin": "Cap admin",
  "proxy-admin": "Proxy admin",
  "bridge-admin": "Bridge admin",
  timelock: "Timelock",
  governor: "Governor",
  "backend-signer": "Backend signer",
  custodian: "Custodian",
  wrapper: "Wrapper",
  other: "Other",
  unknown: "Unknown",
};

const AUTHORITY_TYPE_LABELS: Record<string, string> = {
  safe: "Safe",
  multisig: "Multisig",
  eoa: "Externally owned account",
  timelock: "Timelock",
  "dao-governor": "DAO governor",
  contract: "Contract",
  "issuer-backend": "Issuer backend",
  bridge: "Bridge",
  custodian: "Custodian",
  none: "None",
  unknown: "Unknown",
};

const DIRECT_MINT_ABILITY_LABELS: Record<string, string> = {
  direct: "Direct",
  "cap-limited": "Cap-limited",
  "can-authorize": "Can authorize",
  "upgrade-only": "Upgrade-only",
  "parameter-only": "Parameter-only",
  none: "None",
  unknown: "Unknown",
};

const MODULES_OR_GUARDS_LABELS: Record<string, string> = {
  "none-detected": "No modules or guards detected",
  present: "Modules or guards present",
  unknown: "Modules or guards unknown",
  "not-applicable": "Not applicable",
};

const MODULES_OR_GUARDS_AUTHORITY_TYPES = new Set(["safe", "multisig", "unknown"]);

function labelFromMap(value: string | null | undefined, labels: Readonly<Record<string, string>>): string {
  const key = value;
  if (!key) return "Unknown";
  return (
    labels[key] ??
    key
      .split("-")
      .map((part) => {
        const upper = part.toUpperCase();
        if (["AMO", "DAO", "EOA", "M0", "OFT"].includes(upper)) return upper;
        return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
      })
      .join(" ")
  );
}

function formatThreshold(threshold: number | null, signerCount: number | null): string | null {
  if (threshold == null && signerCount == null) return null;
  if (threshold != null && signerCount != null) return `${threshold}/${signerCount} threshold`;
  if (threshold != null) return `${threshold} threshold`;
  return `${signerCount} signers`;
}

function formatTimelock(seconds: number | null): string | null {
  if (seconds == null || seconds < 0) return null;
  if (seconds === 0) return "No timelock";
  const days = seconds / DAY_SECONDS;
  if (Number.isInteger(days) && days >= 1) return `${days}d timelock`;
  const hours = seconds / 3600;
  if (Number.isInteger(hours) && hours >= 1) return `${hours}h timelock`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m timelock`;
}

function postureToneFrom(value: string): MintAuthorityPostureTone {
  return AUTHORITY_POSTURE_TONES[value] ?? "neutral";
}

function formatModulesOrGuardsLabel(
  authorityType: MintAuthorityClientControlSummary["authorityType"],
  modulesOrGuardsStatus: MintAuthorityClientControlSummary["modulesOrGuardsStatus"],
): string | null {
  if (!modulesOrGuardsStatus || modulesOrGuardsStatus === "not-applicable") return null;
  if (!MODULES_OR_GUARDS_AUTHORITY_TYPES.has(authorityType)) return null;
  return labelFromMap(modulesOrGuardsStatus, MODULES_OR_GUARDS_LABELS);
}

function buildMintIncidentViewModels(
  incidents: MintAuthorityClientSummary["mintIncidents"],
): MintAuthorityDetailIncidentViewModel[] {
  // Newest first: the callout leads with the most recent incident.
  return (incidents ?? [])
    .map((incident) => ({
      date: incident.date,
      status: incident.status,
      resolvedAt: incident.resolvedAt ?? null,
      summary: incident.summary,
      sources: incident.sources,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Mint-relevant structural caps published on the V9 card. */
const MINT_CAP_KIND_LABELS: Record<string, string> = {
  "signal:centralized-mint:critical": "Centralized mint (critical)",
  "signal:centralized-mint:high": "Centralized mint (high)",
  "signal:centralized-mint:moderate": "Centralized mint (moderate)",
  "signal:centralized-mint:low": "Centralized mint (low)",
  "signal:active-control-incident:critical": "Active control incident",
  "signal:unreviewed-upgrade:high": "Unreviewed upgrade authority",
};

export interface PublishedMintCap {
  kind: string;
  limit: number;
  reason: string;
}

function buildMintAuthorityScoreViewModel(
  display: MintAuthorityScoreDisplay,
  caps: readonly PublishedMintCap[],
): MintAuthorityDetailScoreViewModel {
  return {
    score: display.score,
    scoreLabel: display.scoreLabel,
    compactLabel: display.compactLabel,
    bandKey: display.bandKey,
    bandLabel: display.bandLabel,
    postureLabel: labelFromMap(display.posture, AUTHORITY_POSTURE_LABELS),
    badgeClassName: display.badgeClassName,
    textClassName: display.textClassName,
    detail: display.detail,
    caps: caps
      .filter((cap) => Object.hasOwn(MINT_CAP_KIND_LABELS, cap.kind))
      .map((cap) => ({
        kind: cap.kind,
        label: MINT_CAP_KIND_LABELS[cap.kind]!,
        limitLabel: `<= ${cap.limit}`,
        reason: cap.reason,
      })),
  };
}

function buildMintAuthorityControlViewModel(
  control: MintAuthorityClientControlSummary,
  index: number,
): MintAuthorityDetailControlViewModel {
  const label = control.label;
  const chain = control.chain ?? null;
  const address = control.address ?? null;
  const thresholdLabel = formatThreshold(control.threshold ?? null, control.signerCount ?? null);
  const authorityTypeLabel = labelFromMap(control.authorityType, AUTHORITY_TYPE_LABELS);
  const custodyAttestationLabel = formatMintAuthorityCustodyAttestation(control.keyCustodyAttestation);
  const locationLabel =
    [chain, address ? formatAddress(address, 8, 6) : null].filter(Boolean).join(" / ") || "No address published";
  const fullLocationLabel = [chain, address].filter(Boolean).join(" / ") || "No address published";
  const addressUrl = address
    ? buildExplorerUrl({ chainKey: chain ?? undefined, entityType: "address", value: address })
    : null;

  return {
    key: `${label}:${chain ?? "no-chain"}:${address ?? index}`,
    label,
    roleLabel: labelFromMap(control.role, CONTROL_ROLE_LABELS),
    authorityTypeKey: control.authorityType,
    authorityTypeLabel,
    threshold: control.threshold ?? null,
    signerCount: control.signerCount ?? null,
    directMintAbilityLabel: labelFromMap(control.directMintAbility, DIRECT_MINT_ABILITY_LABELS),
    locationLabel,
    fullLocationLabel,
    addressUrl,
    securitySetupLabel: thresholdLabel ? `${authorityTypeLabel}, ${thresholdLabel}` : authorityTypeLabel,
    thresholdLabel,
    timelockLabel: formatTimelock(control.timelockDelaySec ?? null),
    capDescription: control.capDescription ?? null,
    modulesOrGuardsLabel: formatModulesOrGuardsLabel(control.authorityType, control.modulesOrGuardsStatus),
    custodyLabel: custodyAttestationLabel
      ? custodyAttestationLabel
      : control.authorityType === "eoa"
        ? EOA_UNVERIFIED_CUSTODY_LABEL
        : null,
  };
}

/** The published V9 mint projection the detail card renders. */
export interface PublishedMintProjection {
  mint: PublishedMintComponent | null;
  caps: readonly PublishedMintCap[];
}

export function buildMintAuthorityDetailViewModel(
  coin: StablecoinDetailCoinMeta,
  published?: PublishedMintProjection | null,
): MintAuthorityDetailViewModel {
  const candidate = coin.mintAuthoritySummary;
  if (!candidate) return NOT_REVIEWED_MINT_AUTHORITY;

  // The producer flattens review.sources / review.reviewedAt and per-control /
  // per-incident sources onto the top-level summary, so there is no nested review
  // object to read here.
  const sources = candidate.sources ?? [];
  const mintIncidents = buildMintIncidentViewModels(candidate.mintIncidents);
  const controlViewModels = (candidate.controls ?? []).map(buildMintAuthorityControlViewModel);
  const score = buildMintAuthorityScoreViewModel(
    resolveMintAuthorityScoreDisplay(published?.mint),
    published?.caps ?? [],
  );

  return {
    status: "reviewed",
    reviewLabel: "Reviewed by Pharos",
    mintPathLabel: labelFromMap(candidate.mintPath, MINT_PATH_LABELS),
    mintPathShortLabel: labelFromMap(candidate.mintPath, MINT_PATH_PASSPORT_LABELS),
    authorityPostureLabel: labelFromMap(candidate.authorityPosture, AUTHORITY_POSTURE_LABELS),
    authorityPostureTone: postureToneFrom(candidate.authorityPosture),
    confidenceLabel: labelFromMap(candidate.confidence, CONFIDENCE_LABELS),
    confidenceVerified: candidate.confidence === "verified",
    summary: candidate.summary,
    inheritedFrom: candidate.inheritedFrom ?? null,
    controls: controlViewModels,
    sources,
    score,
    reviewedAt: candidate.reviewedAt ?? null,
    mintIncidents,
    sourceFreeRationale: candidate.sourceFreeRationale ?? null,
    unresolvedQuestions: candidate.unresolvedQuestions ?? [],
  };
}
