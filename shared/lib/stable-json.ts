function assertPlainStableJsonValue(value: unknown, path: string): void {
  if (value === null || value === undefined) return;

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return;
  if (valueType === "number") {
    const numberValue = value as number;
    if (!Number.isFinite(numberValue) || Math.abs(numberValue) > Number.MAX_SAFE_INTEGER) {
      throw new TypeError(`Cannot serialize non-finite or unsafe number at ${path}`);
    }
    return;
  }
  if (valueType === "bigint" || valueType === "function" || valueType === "symbol") {
    throw new TypeError(`Cannot serialize ${valueType} at ${path}`);
  }

  if (value instanceof Date) {
    throw new TypeError(`Cannot serialize Date at ${path}; convert it first`);
  }
  if (value instanceof Map || value instanceof Set) {
    throw new TypeError(`Cannot serialize Map/Set at ${path}; convert it first`);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError(`Cannot serialize binary data at ${path}; convert it first`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (entry === undefined) {
        throw new TypeError(`Cannot serialize undefined array entry at ${path}[${index}]`);
      }
      assertPlainStableJsonValue(entry, `${path}[${index}]`);
    });
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`Cannot serialize non-plain object at ${path}`);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertPlainStableJsonValue(entry, `${path}.${key}`);
  }
}


const CANONICAL_CHUNK_TARGET = 64 * 1024;

function* stringifyCanonicalChunks(value: unknown): Generator<string> {
  const stackValues: unknown[] = [value];
  const stackRaw: boolean[] = [false];
  // Join each bounded chunk before retaining it: concatenation ropes otherwise
  // keep a node per JSON token alive until the entire canonical stream flattens.
  let chunk: string[] = [];
  let chunkLength = 0;

  while (stackValues.length > 0) {
    const current = stackValues.pop();
    const raw = stackRaw.pop()!;
    let fragment = "";
    if (raw) {
      fragment = current as string;
    } else if (current === null) {
      fragment = "null";
    } else if (current !== undefined && (
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "boolean"
    )) {
      fragment = JSON.stringify(current);
    } else if (Array.isArray(current)) {
      stackValues.push("]");
      stackRaw.push(true);
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stackValues.push(current[index]);
        stackRaw.push(false);
        if (index > 0) {
          stackValues.push(",");
          stackRaw.push(true);
        }
      }
      fragment = "[";
    } else if (current !== undefined) {
      const objectValue = current as Record<string, unknown>;
      const keys = Object.keys(objectValue)
        .filter((key) => objectValue[key] !== undefined)
        .sort();
      stackValues.push("}");
      stackRaw.push(true);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        stackValues.push(objectValue[key]);
        stackRaw.push(false);
        stackValues.push(":");
        stackRaw.push(true);
        stackValues.push(JSON.stringify(key));
        stackRaw.push(true);
        if (index > 0) {
          stackValues.push(",");
          stackRaw.push(true);
        }
      }
      fragment = "{";
    }

    chunk.push(fragment);
    chunkLength += fragment.length;
    if (chunkLength >= CANONICAL_CHUNK_TARGET) {
      yield chunk.join("");
      chunk = [];
      chunkLength = 0;
    }
  }
  if (chunkLength > 0) yield chunk.join("");
}

/** Deterministic JSON for runtime-neutral identity and digest projections. */
export function stableJsonStringifyV1(value: unknown): string {
  return [...stableJsonStringifyChunksV1(value)].join("");
}

/**
 * The exact V1 canonical byte stream without materializing the complete JSON
 * string. Intended for large digest payloads.
 */
export function stableJsonStringifyChunksV1(value: unknown): Iterable<string> {
  assertPlainStableJsonValue(value, "$");
  return stringifyCanonicalChunks(value);
}
