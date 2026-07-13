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

function stringifyCanonical(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stringifyCanonical(entry)).join(",")}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const entries = Object.keys(objectValue)
    .filter((key) => objectValue[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(objectValue[key])}`);
  return `{${entries.join(",")}}`;
}

/** Deterministic JSON for runtime-neutral identity and digest projections. */
export function stableJsonStringifyV1(value: unknown): string {
  assertPlainStableJsonValue(value, "$");
  return stringifyCanonical(value);
}
