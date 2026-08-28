import type { BackingType, GovernanceType } from "../../types";

export const GOVERNANCE_DESCRIPTORS = {
  centralized: {
    label: "Centralized (CeFi)",
    shortLabel: "CeFi",
    proseLabel: "centralized",
    badgeLabel: "Centralized",
    badgeCls: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
  },
  "centralized-dependent": {
    label: "CeFi-Dependent",
    shortLabel: "CeFi-Dep",
    proseLabel: "CeFi-dependent",
    badgeLabel: "CeFi-Dependent",
    badgeCls: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  },
  decentralized: {
    label: "Decentralized (DeFi)",
    shortLabel: "DeFi",
    proseLabel: "decentralized",
    badgeLabel: "Decentralized",
    badgeCls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  },
} as const satisfies Record<GovernanceType, {
  label: string;
  shortLabel: string;
  proseLabel: string;
  badgeLabel: string;
  badgeCls: string;
}>;

export const BACKING_DESCRIPTORS = {
  "rwa-backed": {
    label: "Real-World Asset Backed",
    shortLabel: "RWA",
    sentenceLabel: "RWA-backed",
    proseLabel: "backed by real-world assets",
    badgeLabel: "RWA-Backed",
    badgeCls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  },
  "crypto-backed": {
    label: "Crypto-Collateralized",
    shortLabel: "Crypto",
    sentenceLabel: "Crypto-backed",
    proseLabel: "collateralized by crypto assets",
    badgeLabel: "Crypto-Backed",
    badgeCls: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20",
  },
  algorithmic: {
    label: "Algorithmic",
    shortLabel: "Algo",
    sentenceLabel: "algorithmic",
    proseLabel: "algorithmic stablecoin",
    badgeLabel: "Algorithmic",
    badgeCls: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  },
} as const satisfies Record<BackingType, {
  label: string;
  shortLabel: string;
  sentenceLabel: string;
  proseLabel: string;
  badgeLabel: string;
  badgeCls: string;
}>;

export function projectDescriptors<
  Key extends string,
  Descriptor,
  Projection,
>(
  descriptors: Record<Key, Descriptor>,
  project: (descriptor: Descriptor) => Projection,
): Record<Key, Projection> {
  return Object.fromEntries(
    (Object.entries(descriptors) as [Key, Descriptor][]).map(([key, descriptor]) => [key, project(descriptor)]),
  ) as Record<Key, Projection>;
}
