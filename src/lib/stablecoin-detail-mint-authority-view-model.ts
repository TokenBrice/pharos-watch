import type { StablecoinMeta } from "@shared/types";
import type {
  MintAuthorityClientControlSummary,
  MintAuthorityClientSummary,
} from "@shared/types/stablecoin-client-meta";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress } from "@shared/lib/format";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { isRecord, stringValue } from "@shared/lib/type-guards";
import {
  mintAuthorityScoreTextClassName,
  resolveMintAuthorityScoreDisplay,
  type MintAuthorityScoreDisplay,
} from "@/lib/mint-authority-display";
import { projectMintAuthorityClientSummary } from "@/lib/stablecoin-detail-mint-authority-client";
import { formatMintAuthorityCustodyAttestation } from "@/lib/stablecoin-detail-mint-authority-format";
import {
  EOA_UNVERIFIED_CUSTODY_LABEL,
  type MintAuthorityCapKind,
  type MintAuthorityCapTrace,
} from "@shared/lib/mint-authority-scoring";

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
  authorityTypeLabel: string;
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

export interface MintAuthorityDetailScoreComponentViewModel {
  key: "route" | "controller" | "bounds" | "posture";
  label: string;
  scoreLabel: string;
  weightLabel: string;
  textClassName: string;
}

export interface MintAuthorityDetailIncidentViewModel {
  date: string;
  summary: string;
  sources: MintAuthorityDetailSourceViewModel[];
}

export interface MintAuthorityDetailScoreViewModel {
  score: number | null;
  scoreLabel: string;
  compactLabel: string;
  bandLabel: string;
  badgeClassName: string;
  textClassName: string;
  detail: string;
  components: MintAuthorityDetailScoreComponentViewModel[];
  rawScoreLabel: string | null;
  confidenceCapLabel: string | null;
  weakestControlLabel: string | null;
  weakestControlScoreLabel: string | null;
  weakestControlCustodyLabel: string | null;
  capsApplied: string[];
  unresolvedReasonLabel: string | null;
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

export type StablecoinDetailCoinMeta = Omit<StablecoinMeta, "mintAuthority"> & {
  mintAuthoritySummary?: MintAuthorityClientSummary | null;
};

export function buildStablecoinDetailClientCoin(coin: StablecoinMeta): StablecoinDetailCoinMeta {
  const { mintAuthority: _serverOnlyMintAuthority, ...clientCoin } = coin;
  const mintAuthoritySummary = projectMintAuthorityClientSummary(coin);
  return mintAuthoritySummary ? { ...clientCoin, mintAuthoritySummary } : clientCoin;
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
  "bounded-admin": "Bounded admin",
  "partially-bounded-admin": "Partially bounded admin",
  "concentrated-admin": "Concentrated admin",
  "unbounded-or-compromised": "Unbounded or compromised",
  unknown: "Unknown",
};

const AUTHORITY_POSTURE_TONES: Record<string, MintAuthorityPostureTone> = {
  "none-resolved": "minimized",
  "bounded-admin": "minimized",
  "partially-bounded-admin": "neutral",
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

const MINT_AUTHORITY_SCORE_COMPONENT_KEYS = ["route", "controller", "bounds", "posture"] as const;

const MINT_AUTHORITY_SCORE_COMPONENT_LABELS: Record<MintAuthorityDetailScoreComponentViewModel["key"], string> = {
  route: "Route",
  controller: "Controller",
  bounds: "Bounds",
  posture: "Posture",
};

const MINT_AUTHORITY_SCORE_COMPONENT_WEIGHTS: Record<MintAuthorityDetailScoreComponentViewModel["key"], string> = {
  route: "30%",
  controller: "40%",
  bounds: "15%",
  posture: "15%",
};

const MINT_AUTHORITY_CAP_LABELS: Record<MintAuthorityCapKind, string> = {
  "incident-cap": "Incident cap",
  "unbounded-cap": "Unbounded cap",
  "eoa-cap": "EOA cap",
  "confidence-cap": "Confidence cap",
};

const MINT_AUTHORITY_UNRESOLVED_REASON_LABELS: Record<string, string> = {
  "not-reviewed": "Not reviewed",
  "unknown-mint-path": "Unknown mint path",
  "unknown-posture": "Unknown posture",
  "unknown-confidence": "Unknown confidence",
  "missing-parent": "Missing inherited parent",
  "parent-resolver-missing": "Parent resolver unavailable",
  "inheritance-depth-limit": "Inheritance depth limit",
  "inheritance-cycle": "Inheritance cycle",
  "parent-not-found": "Parent not found",
  "parent-not-scoreable": "Parent not scoreable",
  "unscored-route": "Unscored mint route",
  "unscored-posture": "Unscored posture",
};

function labelFromMap(value: unknown, labels: Readonly<Record<string, string>>): string {
  const key = stringValue(value);
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

function readSources(value: unknown): MintAuthorityDetailSourceViewModel[] {
  if (!Array.isArray(value)) return [];
  const sources: MintAuthorityDetailSourceViewModel[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!isRecord(item)) continue;
    const label = stringValue(item.label);
    const url = stringValue(item.url);
    if (!label || !url) continue;
    const key = `${label}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ label, url });
  }

  return sources;
}

function readMintAuthorityCandidate(coin: StablecoinDetailCoinMeta): MintAuthorityClientSummary | null {
  // Single untrusted boundary: the summary is produced in-repo with the
  // MintAuthorityClientSummary shape, but the isRecord guard keeps callers that
  // pass arbitrary input (e.g. tests) safe before narrowing to the producer type.
  return isRecord(coin.mintAuthoritySummary) ? (coin.mintAuthoritySummary as MintAuthorityClientSummary) : null;
}

function postureToneFrom(value: unknown): MintAuthorityPostureTone {
  const key = stringValue(value);
  return (key ? AUTHORITY_POSTURE_TONES[key] : undefined) ?? "neutral";
}

function formatModulesOrGuardsLabel(authorityType: unknown, modulesOrGuardsStatus: unknown): string | null {
  const authorityTypeKey = stringValue(authorityType);
  const modulesOrGuardsStatusKey = stringValue(modulesOrGuardsStatus);
  if (!authorityTypeKey || !modulesOrGuardsStatusKey || modulesOrGuardsStatusKey === "not-applicable") return null;
  if (!MODULES_OR_GUARDS_AUTHORITY_TYPES.has(authorityTypeKey)) return null;
  return labelFromMap(modulesOrGuardsStatusKey, MODULES_OR_GUARDS_LABELS);
}

function formatMintAuthorityScoreValue(score: number | null): string {
  return score != null ? `${score}/100` : "NR";
}

function formatMintAuthorityCap(cap: MintAuthorityCapKind): string {
  return MINT_AUTHORITY_CAP_LABELS[cap] ?? cap.replaceAll("-", " ");
}

function formatMintAuthorityCapTrace(trace: MintAuthorityCapTrace): string {
  return `${formatMintAuthorityCap(trace.kind)} <= ${trace.limit}`;
}

function formatMintAuthorityUnresolvedReason(reason: string | null): string | null {
  if (!reason) return null;
  return MINT_AUTHORITY_UNRESOLVED_REASON_LABELS[reason] ?? reason.replaceAll("-", " ");
}

function readMintIncidents(value: unknown): MintAuthorityDetailIncidentViewModel[] {
  if (!Array.isArray(value)) return [];
  const incidents: MintAuthorityDetailIncidentViewModel[] = [];
  for (const incident of value) {
    if (!isRecord(incident)) continue;
    const date = stringValue(incident.date);
    const summary = stringValue(incident.summary);
    if (date && summary) incidents.push({ date, summary, sources: readSources(incident.sources) });
  }
  // Newest first: the callout leads with the most recent incident.
  return incidents.sort((a, b) => b.date.localeCompare(a.date));
}

function buildMintAuthorityScoreViewModel(display: MintAuthorityScoreDisplay): MintAuthorityDetailScoreViewModel {
  const result = display.result;
  const components = MINT_AUTHORITY_SCORE_COMPONENT_KEYS.map((key) => {
    const score = result.components[key];
    return {
      key,
      label: MINT_AUTHORITY_SCORE_COMPONENT_LABELS[key],
      scoreLabel: formatMintAuthorityScoreValue(score),
      weightLabel: MINT_AUTHORITY_SCORE_COMPONENT_WEIGHTS[key],
      textClassName: mintAuthorityScoreTextClassName(score),
    };
  });

  return {
    score: result.score,
    scoreLabel: display.scoreLabel,
    compactLabel: display.compactLabel,
    bandLabel: display.bandLabel,
    badgeClassName: display.badgeClassName,
    textClassName: display.textClassName,
    detail: display.detail,
    components,
    rawScoreLabel: result.rawScore != null ? formatMintAuthorityScoreValue(result.rawScore) : null,
    confidenceCapLabel: result.confidenceCap != null ? `<= ${result.confidenceCap}` : null,
    weakestControlLabel: result.weakestControl?.label ?? null,
    weakestControlScoreLabel: result.weakestControl ? formatMintAuthorityScoreValue(result.weakestControl.score) : null,
    weakestControlCustodyLabel: result.weakestControl?.custodyLabel ?? null,
    capsApplied:
      result.capTraces.length > 0
        ? result.capTraces.map(formatMintAuthorityCapTrace)
        : result.capsApplied.map(formatMintAuthorityCap),
    unresolvedReasonLabel: formatMintAuthorityUnresolvedReason(result.unresolvedReason),
  };
}

function buildMintAuthorityControlViewModel(
  control: MintAuthorityClientControlSummary,
  index: number,
): MintAuthorityDetailControlViewModel | null {
  const label = control.label;
  if (!label) return null;
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
    authorityTypeLabel,
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

export function buildMintAuthorityDetailViewModel(coin: StablecoinDetailCoinMeta): MintAuthorityDetailViewModel {
  const candidate = readMintAuthorityCandidate(coin);
  if (!candidate) return NOT_REVIEWED_MINT_AUTHORITY;

  const summary = candidate.summary;
  if (!summary) return NOT_REVIEWED_MINT_AUTHORITY;

  // The producer flattens review.sources / review.reviewedAt and per-control /
  // per-incident sources onto the top-level summary, so there is no nested review
  // object to read here.
  const sources = readSources(candidate.sources);
  const seenSources = new Set<string>();
  const dedupedSources = sources.filter((source) => {
    const key = `${source.label}:${source.url}`;
    if (seenSources.has(key)) return false;
    seenSources.add(key);
    return true;
  });
  const controls = (candidate.controls ?? [])
    .map(buildMintAuthorityControlViewModel)
    .filter((control): control is MintAuthorityDetailControlViewModel => control !== null);
  const score = buildMintAuthorityScoreViewModel(resolveMintAuthorityScoreDisplay(coin.id, coin.mintAuthoritySummary));

  return {
    status: "reviewed",
    reviewLabel: "Reviewed by Pharos",
    mintPathLabel: labelFromMap(candidate.mintPath, MINT_PATH_LABELS),
    mintPathShortLabel: labelFromMap(candidate.mintPath, MINT_PATH_PASSPORT_LABELS),
    authorityPostureLabel: labelFromMap(candidate.authorityPosture, AUTHORITY_POSTURE_LABELS),
    authorityPostureTone: postureToneFrom(candidate.authorityPosture),
    confidenceLabel: labelFromMap(candidate.confidence, CONFIDENCE_LABELS),
    confidenceVerified: candidate.confidence === "verified",
    summary,
    inheritedFrom: candidate.inheritedFrom ?? null,
    controls,
    sources: dedupedSources,
    score,
    reviewedAt: candidate.reviewedAt ?? null,
    mintIncidents: readMintIncidents(candidate.mintIncidents),
    sourceFreeRationale: candidate.sourceFreeRationale ?? null,
    unresolvedQuestions: candidate.unresolvedQuestions ?? [],
  };
}
