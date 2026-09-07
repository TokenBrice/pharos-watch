import { DONOR_API_KEY_RATE_LIMIT_PER_MINUTE, DONOR_KEY_CLAIM_MAX_AGE_SEC } from "./ops-limits";

/**
 * Sign-In-With-Ethereum (EIP-4361) contract for donor key claims. The page
 * builds this exact text for `personal_sign`; the Worker parses it back with
 * viem's `parseSiweMessage` and checks domain, URI, chain, and time window.
 * Shared so tests and the browser produce byte-identical messages.
 */
export const DONOR_CLAIM_SIWE_DOMAIN = "pharos.watch";
export const DONOR_CLAIM_SIWE_URI = "https://pharos.watch/api/";
const DONOR_CLAIM_SIWE_CHAIN_ID = 1;
const DONOR_CLAIM_SIWE_STATEMENT =
  `Claim your Pharos supporter API key. One key per wallet, no expiry, ${DONOR_API_KEY_RATE_LIMIT_PER_MINUTE} requests per minute.`;
const DONOR_CLAIM_NONCE_LENGTH = 16;

const NONCE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Client-side random nonce (SIWE requires >= 8 alphanumerics). No server state. */
export function generateDonorClaimNonce(randomValues: (bytes: Uint8Array) => Uint8Array = fillRandom): string {
  const bytes = randomValues(new Uint8Array(DONOR_CLAIM_NONCE_LENGTH));
  let nonce = "";
  for (const byte of bytes) nonce += NONCE_ALPHABET[byte % NONCE_ALPHABET.length];
  return nonce;
}

function fillRandom(bytes: Uint8Array): Uint8Array {
  crypto.getRandomValues(bytes);
  return bytes;
}

export interface DonorClaimSiweFields {
  /** Checksummed or lowercase 0x address; written verbatim into the message. */
  address: string;
  nonce: string;
  issuedAt: Date;
}

export function buildDonorClaimSiweMessage({ address, nonce, issuedAt }: DonorClaimSiweFields): string {
  const expirationTime = new Date(issuedAt.getTime() + DONOR_KEY_CLAIM_MAX_AGE_SEC * 1000);
  return [
    `${DONOR_CLAIM_SIWE_DOMAIN} wants you to sign in with your Ethereum account:`,
    address,
    "",
    DONOR_CLAIM_SIWE_STATEMENT,
    "",
    `URI: ${DONOR_CLAIM_SIWE_URI}`,
    "Version: 1",
    `Chain ID: ${DONOR_CLAIM_SIWE_CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expirationTime.toISOString()}`,
  ].join("\n");
}
