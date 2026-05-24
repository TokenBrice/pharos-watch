import type { MintAuthorityClientSummary } from "@shared/types/stablecoin-client-meta";
import type { CoverageBreakdownItem, CoverageRow, CoverageStatus } from "@/lib/coverage-types";
import {
  breakdownItem,
  createPresetStatus,
  createStatus,
  defineCoverageFeature,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

type MintAuthorityStatusKind =
  | "no-privileged-mint"
  | "governed-mint"
  | "multisig-mint"
  | "issuer-or-backend-mint"
  | "bridge-mint"
  | "inherited-authority"
  | "unknown";

const MINT_AUTHORITY_PRESETS: Record<MintAuthorityStatusKind, CoverageStatusPreset> = {
  "no-privileged-mint": {
    kind: "no-privileged-mint",
    label: "No priv.",
    spokenLabel: "No privileged mint",
    tone: "emerald",
    available: true,
    sortRank: 1,
    detail:
      "A curated review says durable minting is limited to protocol or user mechanics, with no privileged mint, cap, or upgrade path resolved.",
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
  },
  unknown: {
    kind: "unknown",
    label: "Unknown",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No curated mint-authority review is available for this asset.",
  },
};

function hasActiveMultisigMintControl(summary: MintAuthorityClientSummary): boolean {
  return (summary.controls ?? []).some(
    (control) =>
      (control.authorityType === "safe" || control.authorityType === "multisig") &&
      control.directMintAbility !== "none",
  );
}

function resolveMintAuthority(summary?: MintAuthorityClientSummary | null): CoverageStatus {
  if (!summary) {
    return createStatus(
      MINT_AUTHORITY_PRESETS.unknown.kind,
      MINT_AUTHORITY_PRESETS.unknown.label,
      MINT_AUTHORITY_PRESETS.unknown.tone,
      MINT_AUTHORITY_PRESETS.unknown.available,
      MINT_AUTHORITY_PRESETS.unknown.sortRank,
      MINT_AUTHORITY_PRESETS.unknown.detail,
    );
  }

  if (summary.mintPath === "wrapped-or-variant-inherited") {
    return createPresetStatus(MINT_AUTHORITY_PRESETS["inherited-authority"]);
  }

  if (
    summary.mintPath === "immutable-user-collateralized" &&
    summary.authorityPosture === "none-resolved"
  ) {
    return createPresetStatus(MINT_AUTHORITY_PRESETS["no-privileged-mint"]);
  }

  if (summary.mintPath === "bridge-or-oft-synthetic") {
    return createPresetStatus(MINT_AUTHORITY_PRESETS["bridge-mint"]);
  }

  if (hasActiveMultisigMintControl(summary)) {
    return createPresetStatus(MINT_AUTHORITY_PRESETS["multisig-mint"]);
  }

  if (
    summary.mintPath === "issuer-direct-mint" ||
    summary.mintPath === "offchain-attested-minter"
  ) {
    return createPresetStatus(MINT_AUTHORITY_PRESETS["issuer-or-backend-mint"]);
  }

  return createPresetStatus(MINT_AUTHORITY_PRESETS["governed-mint"]);
}

function formatMintAuthority(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = (kind: string) => breakdownMap.get(kind) ?? 0;
  return [
    breakdownItem("no-privileged-mint", "no privileged", get("no-privileged-mint")),
    breakdownItem("governed-mint", "governed", get("governed-mint")),
    breakdownItem("multisig-mint", "multisig", get("multisig-mint")),
    breakdownItem("issuer-or-backend-mint", "issuer/backend", get("issuer-or-backend-mint")),
    breakdownItem("bridge-mint", "bridge", get("bridge-mint")),
    breakdownItem("inherited-authority", "inherited", get("inherited-authority")),
    breakdownItem("unknown", "unknown", get("unknown")),
  ];
}

const MINT_AUTHORITY_KINDS: readonly MintAuthorityStatusKind[] = [
  "no-privileged-mint",
  "governed-mint",
  "multisig-mint",
  "issuer-or-backend-mint",
  "bridge-mint",
  "inherited-authority",
  "unknown",
] as const;

const MINT_AUTHORITY_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "No priv.",
    description:
      "Curated review says durable minting is limited to protocol or user mechanics and no privileged mint path is resolved.",
    kinds: ["no-privileged-mint"],
  },
  {
    term: "Governed",
    description: "Governance, facilitators, caps, or parameters can affect minting.",
    kinds: ["governed-mint"],
  },
  {
    term: "Multisig",
    description: "A Safe or multisig can mint, authorize minters, raise caps, or upgrade mint logic.",
    kinds: ["multisig-mint"],
  },
  {
    term: "Issuer",
    description: "An issuer, backend signer, custodian, EOA, or service role controls minting.",
    kinds: ["issuer-or-backend-mint"],
  },
  {
    term: "Bridge",
    description: "Mint authority is primarily bridge, OFT, lockbox, messenger, or attestation-route based.",
    kinds: ["bridge-mint"],
  },
  {
    term: "Inherited",
    description: "A wrapper, savings, staked, or variant asset inherits reviewed mint-authority context.",
    kinds: ["inherited-authority"],
  },
];

export const coverageFeature = defineCoverageFeature({
  statusKinds: MINT_AUTHORITY_KINDS,
  legendItems: MINT_AUTHORITY_LEGEND,
  resolve: resolveMintAuthority,
  formatBreakdown: formatMintAuthority,
});

export const resolveMintAuthorityCoverage = coverageFeature.resolve;
export const formatMintAuthorityBreakdown = coverageFeature.formatBreakdown;
export const MINT_AUTHORITY_STATUS_KINDS = coverageFeature.statusKinds;
export const MINT_AUTHORITY_LEGEND_ITEMS = coverageFeature.legendItems;
