import type { BackingType, GovernanceType, Infrastructure } from "@shared/types";

export type InfrastructureTaxonomyValue = Infrastructure;

export const GOVERNANCE_SLUGS: Record<GovernanceType, string> = {
  centralized: "cefi",
  "centralized-dependent": "cefi-dependent",
  decentralized: "defi",
};

export const BACKING_SLUGS: Record<BackingType, string> = {
  "rwa-backed": "rwa",
  "crypto-backed": "crypto",
  algorithmic: "algorithmic",
};

export const INFRASTRUCTURE_SLUGS: Record<InfrastructureTaxonomyValue, string> = {
  "liquity-v1": "liquity-v1",
  "liquity-v2": "liquity-v2",
  m0: "m0",
};

export function buildGovernanceTaxonomyUrl(value: GovernanceType): string {
  return `/stablecoins/governance/${GOVERNANCE_SLUGS[value]}/`;
}

export function buildBackingTaxonomyUrl(value: BackingType): string {
  return `/stablecoins/backing/${BACKING_SLUGS[value]}/`;
}

export function buildInfrastructureTaxonomyUrl(value: InfrastructureTaxonomyValue): string {
  return `/stablecoins/infrastructure/${INFRASTRUCTURE_SLUGS[value]}/`;
}
