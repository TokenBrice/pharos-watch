/**
 * FNV-1a 32-bit, the single definition shared by every Pharos consumer.
 *
 * Output feeds persisted identity keys (`TELEGRAM_MINI_APP_CATALOG_VERSION`,
 * watchlist tokens, the Telegram pending-queue dedupe key), so the mixing
 * schedule is frozen: offset basis 0x811c9dc5, prime 0x01000193, one UTF-16
 * **code unit** per round via `charCodeAt`. Changing any of those rotates every
 * derived key and invalidates cached rows — treat this file as a wire format.
 *
 * Callers that need a different alphabet (base36, unpadded hex) format the
 * numeric result themselves rather than forking the mixing loop.
 */

/** Raw 32-bit unsigned digest. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Zero-padded 8-character lowercase hex digest. */
export function fnv1a32Hex(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, "0");
}
