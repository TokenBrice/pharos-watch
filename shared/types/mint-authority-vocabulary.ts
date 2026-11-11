export const MINT_AUTHORITY_MINT_PATH_VALUES = [
  "immutable-user-collateralized",
  "user-collateralized-governed",
  "issuer-direct-mint",
  "permissioned-minter",
  "offchain-attested-minter",
  "facilitator-bucket-mint",
  "amo-or-custodian-hybrid",
  "bridge-or-oft-synthetic",
  "m0-permissioned-minter",
  "wrapped-or-variant-inherited",
  "unknown",
] as const;
export type MintAuthorityMintPath = (typeof MINT_AUTHORITY_MINT_PATH_VALUES)[number];

// Ordered strongest-first, matching `V9_MINT_POSTURE_BAND_ORDER`.
//
// Economically unbounded issuance is annotated separately by independently
// evidenced reconciliation/supervision, qualified governance process, adverse
// authority, and active incident. Process rungs require complete execution-scope
// evidence; `compromised` is reserved for an active mint incident.
//
// `none-resolved` and `none-resolved-mint` are the two scopes of the same
// finding. `none-resolved` is whole-of-chain: no privileged control of any kind
// anywhere on the mint path, and for a wrapper only when the parent is itself
// `none-resolved`. `none-resolved-mint` is *mint-scoped*: no privileged mint
// path on this asset, while other control domains (upgradeability, parameters,
// and — for a wrapper — the parent's own mint authority) may still exist. V9
// derives its mint posture mint-scoped, so a share wrapper over a governed
// parent derives `none-resolved` while the whole-of-chain curated value could
// never say it; the mint-scoped value is what those annotations mean.
export const MINT_AUTHORITY_POSTURE_VALUES = [
  "none-resolved",
  "none-resolved-mint",
  "bounded-admin",
  "partially-bounded-admin",
  "unbounded-reconciled",
  "unbounded-governed",
  "unbounded-veto-guarded",
  "unbounded-operationally-governed",
  "concentrated-admin",
  "collateral-gated",
  "unbounded-adverse",
  "compromised",
  "unknown",
] as const;
export type MintAuthorityPosture = (typeof MINT_AUTHORITY_POSTURE_VALUES)[number];

export const MINT_AUTHORITY_CONFIDENCE_VALUES = ["verified", "probable", "manual-review", "unknown"] as const;
export type MintAuthorityConfidence = (typeof MINT_AUTHORITY_CONFIDENCE_VALUES)[number];

export const MINT_AUTHORITY_NO_LOCAL_ISSUANCE_KIND_VALUES = [
  "inherited-parent-issuance",
  "external-only-representation",
] as const;
export const MINT_AUTHORITY_CONTROL_ROLE_VALUES = [
  "direct-minter",
  "minter-admin",
  "facilitator",
  "bucket-admin",
  "cap-admin",
  "proxy-admin",
  "bridge-admin",
  "timelock",
  "governor",
  "backend-signer",
  "custodian",
  "wrapper",
  "other",
  "unknown",
] as const;

/**
 * AUTHORITY-LADDER 9.46 (2026-09-01): `validator-quorum` names an external
 * message-validation quorum — a LayerZero DVN set, a Chainlink CCIP DON/RMN, a
 * Bantu AMTP validator group, an IBC light-client validator set — whose members
 * are a rotating, protocol-scoped population rather than a named key holder.
 * It is a KNOWN-BUT-WEAK authority: it grades at or below `issuer-backend` and
 * never above a named multisig, because an anonymous rotating quorum is not
 * stronger than a 3-of-5 Safe. Use it only where the controlling party genuinely
 * is the validation domain; a named operator behind it is still that operator.
 */
export const MINT_AUTHORITY_TYPE_VALUES = [
  "safe",
  "multisig",
  "eoa",
  "timelock",
  "dao-governor",
  "contract",
  "issuer-backend",
  "validator-quorum",
  "chain-consensus",
  "bridge",
  "custodian",
  "none",
  "unknown",
] as const;

export const MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES = [
  "direct",
  "cap-limited",
  "can-authorize",
  "upgrade-only",
  "parameter-only",
  "none",
  "unknown",
] as const;
export type MintAuthorityDirectMintAbility = (typeof MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES)[number];

export const MINT_AUTHORITY_SAFE_SOURCE_VALUES = ["onchain", "safe-api", "manual"] as const;
// Reviewed economic-control facts the Safety Score v9 engine consumes. They are
// optional on the profile; when absent the engine keeps its inferred/encoding
// behavior (fail-closed inertness). Evidence lives in the profile's existing
// review.sources — these fields do not carry their own citations.
/**
 * MINT-LADDER 9.32 (2026-08-21): `collateral-gated` means every live mint path
 * requires collateral by construction;
 * no privileged party can mint arbitrarily; any minter-authorization or
 * mint-logic-replacement/upgrade path is absent, renounced, or behind a
 * timelock of at least 86400 seconds. Curator-asserted with sources; anything
 * weaker stays `unbounded`.
 */
export const MINT_AUTHORITY_ECONOMIC_CAP_SEMANTICS_VALUES = [
  "unbounded",
  "raiseable",
  "bounded",
  "collateral-gated",
  "unknown",
] as const;
export type MintAuthorityEconomicCapSemantics = (typeof MINT_AUTHORITY_ECONOMIC_CAP_SEMANTICS_VALUES)[number];

export const MINT_AUTHORITY_RECONCILIATION_VALUES = [
  "continuous",
  "periodic",
  // Disclosed issuer ledger process; no reserve-assurance or cadence credit.
  "internal-ledger",
  "none",
  "not-applicable",
  "unknown",
] as const;

export const MINT_AUTHORITY_SUPERVISION_VALUES = ["prudential", "attestation-only", "none", "unknown"] as const;

export const MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES = [
  "none-detected",
  "present",
  "unknown",
  "not-applicable",
] as const;

export const MINT_AUTHORITY_UPGRADE_MODEL_VALUES = [
  "immutable",
  "transparent-proxy",
  "uups",
  "beacon",
  "diamond",
  "custom",
  "unknown",
] as const;

export const MINT_AUTHORITY_KEY_CUSTODY_ATTESTATION_KIND_VALUES = ["mpc", "hsm", "hardware-wallet"] as const;
