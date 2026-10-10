import type { V9MintPostureBand } from "../safety-score-v9/mint-posture";
import { V9_MINT_POSTURE_BAND_ORDER } from "../safety-score-v9/mint-posture";
import { projectDescriptors } from "./descriptors";

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

export interface MintAuthorityStatusConfig {
  kind: MintAuthorityStatusKind;
  label: string;
  spokenLabel: string;
  tone: MintAuthorityTone;
  available: boolean;
  sortRank: number;
  detail: string;
  badgeClassName: string;
}

export const MINT_AUTHORITY_FILTER_VALUES = [
  "no-privileged-mint",
  "governed-mint",
  "multisig-mint",
  "issuer-or-backend-mint",
  "bridge-mint",
  "inherited-authority",
  "unknown",
] as const satisfies readonly MintAuthorityStatusKind[];

export const MINT_AUTHORITY_SCORE_FILTER_VALUES = [
  ...V9_MINT_POSTURE_BAND_ORDER, "nr",
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
    detail: "Native issuance is unreviewed or the available evidence does not establish its mint-authority route.",
    badgeClassName: "border-border/60 bg-muted/20 text-muted-foreground",
  },
};

export const V9_MINT_POSTURE_BANDS: Record<V9MintPostureBand, { label: string; detail: string }> = {
  hardened: {
    label: "Hardened",
    detail: "No live mint authority, or a bounded administrator that cannot expand the claim.",
  },
  governed: {
    label: "Governed",
    detail: "Partially bounded administration, delayed governance or minority-veto issuance, or reviewed operational envelopes with token-governed expansion.",
  },
  managed: {
    label: "Managed",
    detail: "Economically unbounded minting that is reconciled against reserves or prudentially supervised.",
  },
  concentrated: {
    label: "Concentrated",
    detail: "Minting depends on a concentrated or collateral-gated administrator path.",
  },
  exposed: {
    label: "Exposed",
    detail: "Known economically unbounded minting without a qualified governance, reconciliation, or supervisory process, or an active mint incident. An unanswered reconciliation question is disclosed separately.",
  },
};

export const MINT_AUTHORITY_SCORE_DESCRIPTORS = {
  hardened: { ...V9_MINT_POSTURE_BANDS.hardened, badgeClassName: "border-emerald-500/30 bg-emerald-500/10", textClassName: "text-emerald-700 dark:text-emerald-400" },
  governed: { ...V9_MINT_POSTURE_BANDS.governed, badgeClassName: "border-blue-500/30 bg-blue-500/10", textClassName: "text-blue-700 dark:text-blue-400" },
  managed: { ...V9_MINT_POSTURE_BANDS.managed, badgeClassName: "border-amber-500/30 bg-amber-500/10", textClassName: "text-amber-700 dark:text-amber-400" },
  concentrated: { ...V9_MINT_POSTURE_BANDS.concentrated, badgeClassName: "border-orange-500/30 bg-orange-500/10", textClassName: "text-orange-700 dark:text-orange-400" },
  exposed: { ...V9_MINT_POSTURE_BANDS.exposed, badgeClassName: "border-red-500/30 bg-red-500/10", textClassName: "text-red-700 dark:text-red-400" },
  nr: { label: "NR", detail: "The mint control posture is not rated because the review is missing, unknown, or unresolved.", badgeClassName: "border-border/60 bg-muted/30", textClassName: "text-muted-foreground" },
} satisfies Record<MintAuthorityScoreFilterValue, { label: string; detail: string; badgeClassName: string; textClassName: string }>;

export const MINT_AUTHORITY_SCORE_FILTER_CONFIG = projectDescriptors(
  MINT_AUTHORITY_SCORE_DESCRIPTORS, ({ label, detail }) => ({ label, detail }),
);
