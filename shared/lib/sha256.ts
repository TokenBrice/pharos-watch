/**
 * Small synchronous SHA-256 helper for runtime-neutral shared code.
 *
 * Some shared call sites run inside synchronous browser/client paths, so Web
 * Crypto's async digest would force a wider contract. This implementation is
 * deterministic in browser and Node runtimes and avoids Node-only `crypto`
 * imports in client bundles.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const encoder = new TextEncoder();

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function toHexWord(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

class Sha256Accumulator {
  private readonly h = new Uint32Array(INITIAL_HASH);
  private readonly w = new Uint32Array(64);
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytesHashed = 0;
  private finalized = false;

  private processBlock(bytes: Uint8Array, offset: number): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 64);
    for (let i = 0; i < 16; i += 1) {
      this.w[i] = view.getUint32(i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(this.w[i - 15]!, 7) ^ rotr(this.w[i - 15]!, 18) ^ (this.w[i - 15]! >>> 3);
      const s1 = rotr(this.w[i - 2]!, 17) ^ rotr(this.w[i - 2]!, 19) ^ (this.w[i - 2]! >>> 10);
      this.w[i] = (this.w[i - 16]! + s0 + this.w[i - 7]! + s1) >>> 0;
    }

    let a = this.h[0]!;
    let b = this.h[1]!;
    let c = this.h[2]!;
    let d = this.h[3]!;
    let e = this.h[4]!;
    let f = this.h[5]!;
    let g = this.h[6]!;
    let hh = this.h[7]!;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i]! + this.w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h[0] = (this.h[0]! + a) >>> 0;
    this.h[1] = (this.h[1]! + b) >>> 0;
    this.h[2] = (this.h[2]! + c) >>> 0;
    this.h[3] = (this.h[3]! + d) >>> 0;
    this.h[4] = (this.h[4]! + e) >>> 0;
    this.h[5] = (this.h[5]! + f) >>> 0;
    this.h[6] = (this.h[6]! + g) >>> 0;
    this.h[7] = (this.h[7]! + hh) >>> 0;
  }

  update(bytes: Uint8Array): void {
    if (this.finalized) throw new Error("Cannot update a finalized SHA-256 digest");
    if (this.bytesHashed + bytes.byteLength > Math.floor(Number.MAX_SAFE_INTEGER / 8)) {
      throw new RangeError("SHA-256 input is too large");
    }
    this.bytesHashed += bytes.byteLength;

    let offset = 0;
    if (this.bufferLength > 0) {
      const copied = Math.min(64 - this.bufferLength, bytes.byteLength);
      this.buffer.set(bytes.subarray(0, copied), this.bufferLength);
      this.bufferLength += copied;
      offset += copied;
      if (this.bufferLength === 64) {
        this.processBlock(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= bytes.byteLength) {
      this.processBlock(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.bufferLength = bytes.byteLength - offset;
    }
  }

  digestHex(): string {
    if (this.finalized) throw new Error("SHA-256 digest has already been finalized");
    this.finalized = true;

    const finalLength = this.bufferLength < 56 ? 64 : 128;
    const finalBlocks = new Uint8Array(finalLength);
    finalBlocks.set(this.buffer.subarray(0, this.bufferLength));
    finalBlocks[this.bufferLength] = 0x80;

    const bitLength = this.bytesHashed * 8;
    const view = new DataView(finalBlocks.buffer);
    view.setUint32(finalLength - 8, Math.floor(bitLength / 0x1_0000_0000));
    view.setUint32(finalLength - 4, bitLength >>> 0);
    for (let offset = 0; offset < finalLength; offset += 64) {
      this.processBlock(finalBlocks, offset);
    }
    return Array.from(this.h, toHexWord).join("");
  }
}

/**
 * Hash UTF-8 text without first joining every chunk into one large string.
 * A trailing UTF-16 high surrogate is carried across chunk boundaries so the
 * result matches hashing the concatenated JavaScript string.
 */
export function sha256HexFromUtf8Chunks(chunks: Iterable<string>): string {
  const digest = new Sha256Accumulator();
  let pendingHighSurrogate = "";

  for (const chunk of chunks) {
    if (typeof chunk !== "string") throw new TypeError("SHA-256 text chunks must be strings");
    let text = pendingHighSurrogate + chunk;
    pendingHighSurrogate = "";
    const finalCodeUnit = text.charCodeAt(text.length - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
      pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (text.length > 0) digest.update(encoder.encode(text));
  }
  if (pendingHighSurrogate.length > 0) digest.update(encoder.encode(pendingHighSurrogate));
  return digest.digestHex();
}

export function sha256Hex(input: string): string {
  return sha256HexFromUtf8Chunks([input]);
}
