// eslint-disable-next-line security/detect-unsafe-regex -- anchored bounded optional code prefix plus fixed-width base32 contract id; linear, no backtracking ambiguity.
const SOROBAN_IDENTITY_RE = /^(?:[A-Z0-9]{1,12}-)?(C[A-Z2-7]{55})$/;

/**
 * Return the raw Soroban contract id used by Soroban-aware indexes.
 *
 * Registry deployments may be represented as either `C...` or
 * `CODE-C...`. The code prefix is a Pharos display/deployment identity, not
 * part of the on-chain contract address and must never be sent to a classic
 * Stellar/Horizon asset query.
 */
export function canonicalSorobanTokenId(address: string): string | null {
  const normalized = address.trim().toUpperCase();
  const match = SOROBAN_IDENTITY_RE.exec(normalized);
  return match?.[1] ?? null;
}
