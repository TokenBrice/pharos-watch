import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import {
  MINT_AUTHORITY_SCORE_BANDS,
  computeMintAuthorityScore,
  resolveMintAuthorityScoreBand,
  type MintAuthorityParentResolver,
  type MintAuthorityScoreBand,
  type MintAuthorityScoreResult,
  type MintAuthorityScoringInput,
} from "@shared/lib/mint-authority-scoring";

export type MintAuthorityStatusKind =
  | "no-privileged-mint"
  | "governed-mint"
  | "multisig-mint"
  | "issuer-or-backend-mint"
  | "bridge-mint"
  | "inherited-authority"
  | "unknown";

type MintAuthorityTone = "emerald" | "sky" | "amber" | "violet" | "slate";
export type MintAuthorityScoreFilterValue = MintAuthorityScoreBand | "nr";

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
  hardened: {
    label: MINT_AUTHORITY_SCORE_BANDS.hardened.label,
    // Range source: MINT_AUTHORITY_SCORE_BANDS.hardened.min.
    detail: "Mint Authority Score is 80 or higher.",
  },
  governed: {
    label: MINT_AUTHORITY_SCORE_BANDS.governed.label,
    // Range source: governed.min through hardened.min - 1.
    detail: "Mint Authority Score is 65 to 79.",
  },
  managed: {
    label: MINT_AUTHORITY_SCORE_BANDS.managed.label,
    // Range source: managed.min through governed.min - 1.
    detail: "Mint Authority Score is 50 to 64.",
  },
  concentrated: {
    label: MINT_AUTHORITY_SCORE_BANDS.concentrated.label,
    // Range source: concentrated.min through managed.min - 1.
    detail: "Mint Authority Score is 35 to 49.",
  },
  exposed: {
    label: MINT_AUTHORITY_SCORE_BANDS.exposed.label,
    // Range source: below MINT_AUTHORITY_SCORE_BANDS.concentrated.min.
    detail: "Mint Authority Score is below 35.",
  },
  nr: {
    label: "NR",
    detail: "Mint Authority Score is not rated because the review is missing, unknown, or unresolved.",
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

/** Band-toned text class for any 0-100 mint-authority score value (total or component). */
export function mintAuthorityScoreTextClassName(score: number | null | undefined): string {
  return MINT_AUTHORITY_SCORE_TEXT_CLASS[resolveMintAuthorityScoreBand(score ?? null) ?? "nr"];
}

export interface MintAuthorityScoreDisplay {
  result: MintAuthorityScoreResult;
  scoreLabel: string;
  compactLabel: string;
  bandKey: MintAuthorityScoreFilterValue;
  bandLabel: string;
  badgeClassName: string;
  textClassName: string;
  detail: string;
}

function mintAuthoritySummaryToScoringInput(
  id: string | undefined,
  summary?: MintAuthorityCoverageSummary | null,
): MintAuthorityScoringInput | null {
  if (!summary) return null;

  return {
    id,
    mintPath: summary.mintPath,
    authorityPosture: summary.authorityPosture,
    confidence: summary.confidence,
    inheritedFrom: summary.inheritedFrom,
    mintIncidents: summary.mintIncidents,
    controls: summary.controls,
  };
}

const resolveClientParent: MintAuthorityParentResolver = (id) => {
  const parent = CLIENT_TRACKED_META_BY_ID.get(id);
  return mintAuthoritySummaryToScoringInput(id, parent?.mintAuthoritySummary);
};

function computeMintAuthoritySummaryScore(
  id: string | undefined,
  summary?: MintAuthorityCoverageSummary | null,
): MintAuthorityScoreResult {
  return computeMintAuthorityScore(mintAuthoritySummaryToScoringInput(id, summary), resolveClientParent);
}

export function resolveMintAuthorityScoreDisplay(
  id: string | undefined,
  summary?: MintAuthorityCoverageSummary | null,
): MintAuthorityScoreDisplay {
  const result = computeMintAuthoritySummaryScore(id, summary);
  const bandKey = result.band ?? "nr";
  const scoreLabel = result.score != null ? `${result.score}/100` : "NR";
  const compactLabel = result.score != null ? `${result.score} ${result.bandLabel}` : "NR";
  const detail =
    result.score != null
      ? `Mint Authority Score: ${scoreLabel} (${result.bandLabel}). Higher scores mean fewer or better-bounded privileged mint paths.`
      : "Mint Authority Score is not rated because the review is missing, unknown, or unresolved.";

  return {
    result,
    scoreLabel,
    compactLabel,
    bandKey,
    bandLabel: result.bandLabel,
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
