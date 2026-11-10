export function word(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

export function encodeBytes(value: string): string {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  const paddedByteLength = Math.ceil(body.length / 2 / 32) * 32;
  return `${word(body.length / 2)}${body.padEnd(paddedByteLength * 2, "0")}`;
}

export function encodeAggregate3Return(results: Array<{ success: boolean; returnData: string }>): `0x${string}` {
  const encoded = results.map((result) =>
    `${word(result.success ? 1 : 0)}${word(64)}${encodeBytes(result.returnData)}`);
  let offset = results.length * 32;
  const offsets = encoded.map((entry) => {
    const encodedOffset = word(offset);
    offset += entry.length / 2;
    return encodedOffset;
  });
  return `0x${word(32)}${word(results.length)}${offsets.join("")}${encoded.join("")}` as `0x${string}`;
}
