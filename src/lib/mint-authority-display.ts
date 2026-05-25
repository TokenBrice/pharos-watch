import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";

export type MintAuthorityStatusKind =
  | "no-privileged-mint"
  | "governed-mint"
  | "multisig-mint"
  | "issuer-or-backend-mint"
  | "bridge-mint"
  | "inherited-authority"
  | "unknown";

type MintAuthorityTone = "emerald" | "sky" | "amber" | "violet" | "slate";

interface MintAuthorityStatusConfig {
  kind: MintAuthorityStatusKind;
  label: string;
  spokenLabel: string;
  tone: MintAuthorityTone;
  available: boolean;
  coverageSortRank: number;
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

export const MINT_AUTHORITY_FILTER_VALUES = MINT_AUTHORITY_STATUS_VALUES;

export const MINT_AUTHORITY_STATUS_CONFIG: Record<MintAuthorityStatusKind, MintAuthorityStatusConfig> = {
  "no-privileged-mint": {
    kind: "no-privileged-mint",
    label: "No priv.",
    spokenLabel: "No privileged mint",
    tone: "emerald",
    available: true,
    coverageSortRank: 1,
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
    coverageSortRank: 1,
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
    coverageSortRank: 1,
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
    coverageSortRank: 1,
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
    coverageSortRank: 1,
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
    coverageSortRank: 1,
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
    coverageSortRank: 0,
    detail: "No curated mint-authority review is available for this asset.",
    badgeClassName: "border-border/60 bg-muted/20 text-muted-foreground",
  },
};

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
