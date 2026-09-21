import { solanaPublicKey } from "../../reserve-adapters/solana";

export function publicKeyBytes(address: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (address.length < 32 || address.length > 44) throw new Error("Invalid Solana address");
  let value = 0n;
  for (const character of address) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid Solana address");
    value = value * 58n + BigInt(digit);
  }
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { bytes[i] = Number(value & 255n); value >>= 8n; }
  if (value !== 0n || solanaPublicKey(bytes) !== address) throw new Error("Invalid Solana address");
  return bytes;
}
const FIELD = (1n << 255n) - 19n;
function modPow(base: bigint, power: bigint): bigint {
  let result = 1n;
  base = ((base % FIELD) + FIELD) % FIELD;
  while (power > 0n) { if (power & 1n) result = result * base % FIELD; base = base * base % FIELD; power >>= 1n; }
  return result;
}
const EDWARDS_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
function isEd25519Point(bytes: Uint8Array): boolean {
  const y = bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n) & ((1n << 255n) - 1n);
  const square = y * y % FIELD;
  // x²=(y²-1)/(d*y²+1); quadratic character is unchanged by multiplying
  // instead of dividing the denominator (avoids a second modular exponent).
  const numerator = (square + FIELD - 1n) % FIELD;
  const denominator = (EDWARDS_D * square + 1n) % FIELD;
  if (denominator === 0n) return false;
  return numerator === 0n || modPow(numerator * denominator, (FIELD - 1n) / 2n) === 1n;
}

export async function programAddress(programId: string, seeds: readonly Uint8Array[]): Promise<string> {
  const encoder = new TextEncoder();
  const suffix = [publicKeyBytes(programId), encoder.encode("ProgramDerivedAddress")];
  const size = seeds.reduce((total, seed) => total + seed.length, 1) + suffix.reduce((total, seed) => total + seed.length, 0);
  const input = new Uint8Array(size);
  let offset = 0;
  for (const seed of seeds) { input.set(seed, offset); offset += seed.length; }
  const bumpOffset = offset++;
  for (const seed of suffix) { input.set(seed, offset); offset += seed.length; }
  for (let bump = 255; bump >= 0; bump--) {
    input[bumpOffset] = bump;
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    if (!isEd25519Point(hash)) return solanaPublicKey(hash);
  }
  throw new Error("Unable to derive Solana PDA");
}
