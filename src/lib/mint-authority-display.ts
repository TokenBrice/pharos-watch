import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import {
  V9_MINT_POSTURE_BANDS,
  resolveV9MintPostureBand,
  type V9MintPostureBand,
} from "@shared/lib/safety-score-v9/mint-posture";

export type MintAuthorityStatusKind =
  | "no-privileged-mint"
  | "governed-mint"
  | "multisig-mint"
  | "issuer-or-backend-mint"
  | "bridge-mint"
  | "inherited-authority"
  | "unknown";

type MintAuthorityTone = "emerald" | "sky" | "amber" | "violet" | "slate";
/** Published V9 mint posture band, plus the not-rated bucket. */
export type MintAuthorityScoreFilterValue = V9MintPostureBand | "nr";

interface MintAuthorityStatusConfig {
  kind: MintAuthorityStatusKind;
  label: string;
  spokenLabel: string;
  tone: MintAuthorityTone;
  available: boolean;
  sortRank: number;
  detail: string;
  badgeClassName: string;
}

export const MINT_AUTHORITY_STATUS_VALUES = [
  "no-privileged-mint",
  "governed-mint",
  "multisig-mint",
  "issuer-or-backend-mint",
  "bridge-mint",
  "inherited-authority",
  "unknown",
] as const satisfies readonly MintAuthorityStatusKind[];

// Screener filters use the same vocabulary as the cross-coin status classifier.
export const MINT_AUTHORITY_FILTER_VALUES = MINT_AUTHORITY_STATUS_VALUES;

export const MINT_AUTHORITY_SCORE_FILTER_VALUES = [
  "hardened",
  "governed",
  "managed",
  "concentrated",
  "exposed",
  "nr",
] as const satisfies readonly MintAuthorityScoreFilterValue[];

export const MINT_AUTHORITY_STATUS_CONFIG: Record<MintAuthorityStatusKind, MintAuthorityStatusConfig> = {
  "no-privileged-mint": {
    kind: "no-privileged-mint",
    label: "No priv.",
    spokenLabel: "No privileged mint",
    tone: "emerald",
    available: true,
    sortRank: 1,
    detail:
      "A curated review says durable minting is limited to protocol or user mechanics, with no privileged mint, cap, or upgrade path resolved.",
    badgeClassName:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  "governed-mint": {
    kind: "governed-mint",
    label: "Governed",
    spokenLabel: "Governed mint",
    tone: "sky",
    available: true,
    sortRank: 1,
    detail:
      "Minting is user or protocol based, but governance, facilitators, caps, or parameter authorities can affect minting.",
    badgeClassName:
      "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  "multisig-mint": {
    kind: "multisig-mint",
    label: "Multisig",
    spokenLabel: "Multisig mint",
    tone: "violet",
    available: true,
    sortRank: 1,
    detail:
      "A Safe or multisig can directly mint, authorize minters, raise mint caps, or upgrade mint logic.",
    badgeClassName:
      "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  "issuer-or-backend-mint": {
    kind: "issuer-or-backend-mint",
    label: "Issuer",
    spokenLabel: "Issuer or backend mint",
    tone: "amber",
    available: true,
    sortRank: 1,
    detail:
      "An issuer role, EOA, backend signer, custodian, or service role controls minting.",
    badgeClassName:
      "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  "bridge-mint": {
    kind: "bridge-mint",
    label: "Bridge",
    spokenLabel: "Bridge mint",
    tone: "sky",
    available: true,
    sortRank: 1,
    detail:
      "Mint authority is primarily bridge, OFT, lockbox, messenger, or attestation-route based.",
    badgeClassName:
      "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  "inherited-authority": {
    kind: "inherited-authority",
    label: "Inherited",
    spokenLabel: "Inherited authority",
    tone: "slate",
    available: true,
    sortRank: 1,
    detail:
      "A wrapper, savings, staked, or variant asset inherits mint-authority context from a reviewed parent plus wrapper mechanics.",
    badgeClassName:
      "border-slate-400/40 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  },
  unknown: {
    kind: "unknown",
    label: "Unknown",
    spokenLabel: "Unknown mint authority",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No curated mint-authority review is available for this asset.",
    badgeClassName: "border-border/60 bg-muted/20 text-muted-foreground",
  },
};

export const MINT_AUTHORITY_SCORE_FILTER_CONFIG: Record<
  MintAuthorityScoreFilterValue,
  { label: string; detail: string }
> = {
  hardened: V9_MINT_POSTURE_BANDS.hardened,
  governed: V9_MINT_POSTURE_BANDS.governed,
  managed: V9_MINT_POSTURE_BANDS.managed,
  concentrated: V9_MINT_POSTURE_BANDS.concentrated,
  exposed: V9_MINT_POSTURE_BANDS.exposed,
  nr: {
    label: "NR",
    detail: "The mint control posture is not rated because the review is missing, unknown, or unresolved.",
  },
};

const MINT_AUTHORITY_SCORE_BADGE_CLASS: Record<MintAuthorityScoreFilterValue, string> = {
  hardened: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  governed: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  managed: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  concentrated: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  exposed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  nr: "border-border/60 bg-muted/30 text-muted-foreground",
};

const MINT_AUTHORITY_SCORE_TEXT_CLASS: Record<MintAuthorityScoreFilterValue, string> = {
  hardened: "text-emerald-700 dark:text-emerald-400",
  governed: "text-blue-700 dark:text-blue-400",
  managed: "text-amber-700 dark:text-amber-400",
  concentrated: "text-orange-700 dark:text-orange-400",
  exposed: "text-red-700 dark:text-red-400",
  nr: "text-muted-foreground",
};

/** Band-toned text class for a published mint posture. */
export function mintPostureTextClassName(posture: string | null | undefined): string {
  return MINT_AUTHORITY_SCORE_TEXT_CLASS[resolveV9MintPostureBand(posture) ?? "nr"];
}

/**
 * The published V9 mint component, as every cross-coin surface reads it off
 * `card.breakdowns.control.components`. `breakdowns` is nullable on older
 * publications, so an absent component is a first-class NR rather than an error.
 */
export interface PublishedMintComponent {
  score: number | null;
  posture: string | null;
}

export interface MintAuthorityScoreDisplay {
  score: number | null;
  posture: string | null;
  scoreLabel: string;
  compactLabel: string;
  bandKey: MintAuthorityScoreFilterValue;
  bandLabel: string;
  badgeClassName: string;
  textClassName: string;
  detail: string;
}

/**
 * Safety 9.1: the mint score and band are read from the published V9 mint
 * component instead of recomputed in the browser from curated inputs. The
 * band comes from the published posture, so it stays stable when a bounded
 * merged-signal credit or penalty moves the component by a point.
 */
export function resolveMintAuthorityScoreDisplay(
  mint?: PublishedMintComponent | null,
): MintAuthorityScoreDisplay {
  const band = resolveV9MintPostureBand(mint?.posture);
  const bandKey: MintAuthorityScoreFilterValue = band ?? "nr";
  const score = band === null ? null : (mint?.score ?? null);
  const bandLabel = MINT_AUTHORITY_SCORE_FILTER_CONFIG[bandKey].label;
  const scoreLabel = score != null ? `${score}/100` : "NR";
  const compactLabel = score != null ? `${score} ${bandLabel}` : "NR";
  const detail =
    score != null
      ? `Mint control posture: ${scoreLabel} (${bandLabel}). ${MINT_AUTHORITY_SCORE_FILTER_CONFIG[bandKey].detail}`
      : MINT_AUTHORITY_SCORE_FILTER_CONFIG.nr.detail;

  return {
    score,
    posture: mint?.posture ?? null,
    scoreLabel,
    compactLabel,
    bandKey,
    bandLabel,
    badgeClassName: MINT_AUTHORITY_SCORE_BADGE_CLASS[bandKey],
    textClassName: MINT_AUTHORITY_SCORE_TEXT_CLASS[bandKey],
    detail,
  };
}

function hasActiveMultisigMintControl(summary: MintAuthorityCoverageSummary): boolean {
  return (summary.controls ?? []).some(
    (control) =>
      (control.authorityType === "safe" || control.authorityType === "multisig") &&
      control.directMintAbility !== "none",
  );
}

function hasDirectNonMultisigMintControl(summary: MintAuthorityCoverageSummary): boolean {
  return (summary.controls ?? []).some(
    (control) =>
      control.directMintAbility === "direct" &&
      control.authorityType !== "safe" &&
      control.authorityType !== "multisig",
  );
}

export function resolveMintAuthorityStatusKind(
  summary?: MintAuthorityCoverageSummary | null,
): MintAuthorityStatusKind {
  if (!summary) {
    return "unknown";
  }

  if (summary.mintPath === "wrapped-or-variant-inherited") {
    return "inherited-authority";
  }

  if (
    summary.mintPath === "immutable-user-collateralized" &&
    summary.authorityPosture === "none-resolved"
  ) {
    return "no-privileged-mint";
  }

  if (summary.mintPath === "bridge-or-oft-synthetic") {
    return "bridge-mint";
  }

  if (hasActiveMultisigMintControl(summary)) {
    return "multisig-mint";
  }

  if (
    summary.mintPath === "issuer-direct-mint" ||
    summary.mintPath === "offchain-attested-minter" ||
    hasDirectNonMultisigMintControl(summary)
  ) {
    return "issuer-or-backend-mint";
  }

  return "governed-mint";
}

export function resolveMintAuthorityStatus(
  summary?: MintAuthorityCoverageSummary | null,
): MintAuthorityStatusConfig {
  return MINT_AUTHORITY_STATUS_CONFIG[resolveMintAuthorityStatusKind(summary)];
}
