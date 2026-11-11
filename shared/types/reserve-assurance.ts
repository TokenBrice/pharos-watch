/**
 * Engagement class of the proof-of-reserves artefact. `agreed-upon-procedures`
 * is a third-party engagement that expresses no assurance opinion, while
 * `attestation` is an independent verification-agent report distinct from
 * both audit-grade assurance and issuer self-reporting.
 */
export const PROOF_OF_RESERVES_TYPE_VALUES = [
  "independent-audit",
  "agreed-upon-procedures",
  "attestation",
  "real-time",
  "self-reported",
] as const;

/**
 * Attestor quality ladder. `none` is a *reviewed* negative — a reviewer
 * established that no reserve attestation exists. `undisclosed` is the absence
 * of evidence: the issuer names no attestor, or the claimed artefact is not
 * retrievable. The two must stay distinct so the UI never renders an
 * undisclosed attestor as an asserted "No attestation".
 */
export const ATTESTOR_TIER_VALUES = ["big4", "regional", "niche", "self", "none", "undisclosed"] as const;
export type AttestorTier = (typeof ATTESTOR_TIER_VALUES)[number];

export const PROOF_OF_RESERVES_CADENCE_VALUES = [
  "daily-nav",
  "real-time",
  "daily",
  "weekly",
  "monthly",
  "semi-monthly",
  "quarterly",
  "semi-annual",
  "annual",
  "ad-hoc",
  /** Reviewed negative: the issuer publishes no periodic reserve report. */
  "none",
  /** Absence of evidence: no cadence is published, or the artefact is unreachable. */
  "undisclosed",
] as const;
export const PROOF_ASSURANCE_METHOD_VALUES = [
  "audit",
  "examination",
  "review",
  "agreed-upon-procedures",
  "attestation",
  "onchain-proof",
  "self-verification",
  "unknown",
] as const;
export const PROOF_ASSURANCE_SCOPE_VALUES = ["assets-only", "assets-and-liabilities", "unknown"] as const;
export const LIABILITY_RECONCILIATION_VALUES = ["full", "partial", "none", "unknown"] as const;
