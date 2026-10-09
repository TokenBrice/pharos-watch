type FixtureCborValue = bigint | string | Uint8Array | Map<string, FixtureCborValue>;

/** Fixture-only RFC 8949 decoder, independent of the Worker's private codec. */
export function decodeIcpQueryFixture(bytes: Uint8Array): {
  value: FixtureCborValue;
  integerHeaders: number[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const integerHeaders: number[] = [];
  let offset = 0;
  function decode(): FixtureCborValue {
    const header = view.getUint8(offset++);
    const major = header >> 5;
    const info = header & 31;
    let size: bigint;
    if (info < 24) size = BigInt(info);
    else {
      const width = 2 ** (info - 24);
      if (info === 24) size = BigInt(view.getUint8(offset));
      else if (info === 25) size = BigInt(view.getUint16(offset));
      else if (info === 26) size = BigInt(view.getUint32(offset));
      else if (info === 27) size = view.getBigUint64(offset);
      else throw new Error("unsupported fixture CBOR length");
      offset += width;
    }
    if (major === 0) {
      integerHeaders.push(header);
      return size;
    }
    const length = Number(size);
    if (!Number.isSafeInteger(length) || length > bytes.length - offset) {
      throw new Error("truncated fixture CBOR value");
    }
    if (major === 2 || major === 3) {
      const value = bytes.subarray(offset, offset + length);
      offset += length;
      return major === 2 ? value : new TextDecoder().decode(value);
    }
    if (major === 5) {
      const map = new Map<string, FixtureCborValue>();
      for (let index = 0; index < length; index++) {
        const key = decode();
        if (typeof key !== "string") throw new Error("fixture CBOR map key must be text");
        map.set(key, decode());
      }
      return map;
    }
    throw new Error("unsupported fixture CBOR major type");
  }
  const value = decode();
  if (offset !== bytes.length) throw new Error("trailing fixture CBOR bytes");
  return { value, integerHeaders };
}

/** A minimal standard CBOR { status: "replied", reply: { arg: bytes } } envelope. */
export function icpReplyFixtureResponse(reply: Uint8Array): Response {
  if (reply.length > 255) throw new Error("fixture reply exceeds one-byte length");
  const prefix = Buffer.from("a266737461747573677265706c696564657265706c79a163617267", "hex");
  const byteStringHeader = reply.length < 24 ? [0x40 | reply.length] : [0x58, reply.length];
  return new Response(Uint8Array.from([...prefix, ...byteStringHeader, ...reply]), {
    headers: { "Content-Type": "application/cbor" },
  });
}
