// Runtime-neutral immutable-value helpers shared by V9 schemas (shared/types)
// and the evaluator (shared/lib). They live here so schema-side admission can
// freeze and intern values without importing shared/lib.

// Shared immutable result metadata, never a mutable working list. The mutable
// annotation matches schema-inferred arrays; the finalized graph is read-only.
export const V9_EMPTY_ARRAY: never[] = Object.freeze([]) as unknown as never[];
const EMPTY_INTERNED_OBJECT: Record<string, never> = Object.freeze({});

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Intern freshly schema-owned JSON values in place, never caller-owned inputs.
 * Reference-preserving schema branches must already be strictly admitted and immutable.
 */
export function createV9ValueInterner(
  canonicalize?: (value: object, keys: readonly string[]) => object | undefined,
  isAlreadyAdmitted?: (value: object) => boolean,
): <T>(value: T) => T {
  const objects = new Map<string, object>();
  // Equal strings may still retain distinct backing storage after schema transforms.
  const strings = new Map<string, string>();
  const identities = new Map<unknown, number>();
  let nextIdentity = 0;
  const identity = (value: unknown): string => {
    if (typeof value === "number" && Object.is(value, -0)) return "-0";
    let id = identities.get(value);
    if (id === undefined) {
      id = nextIdentity++;
      identities.set(value, id);
    }
    return String(id);
  };
  const intern = <T>(value: T): T => {
    if (typeof value === "string") {
      const canonical = strings.get(value);
      if (canonical !== undefined) return canonical as T;
      strings.set(value, value);
      return value;
    }
    if (value === null || typeof value !== "object") return value;
    if (isAlreadyAdmitted?.(value)) return value;
    const keys = Object.keys(value);
    const array = Array.isArray(value);
    if (keys.length === 0 && (!array || value.length === 0)) {
      return (array ? V9_EMPTY_ARRAY : EMPTY_INTERNED_OBJECT) as T;
    }
    const replacement = canonicalize?.(value, keys);
    if (replacement !== undefined) return replacement as T;
    if (Object.isFrozen(value)) return value;
    const record = value as Record<string, unknown>;
    // Dense JSON arrays keep the compact key; sparse arrays must also pin their length.
    let key = array ? (keys.length === value.length ? "a" : `a#${value.length}:`) : "o";
    for (const property of keys) {
      const child = intern(record[property]);
      record[property] = child;
      key += `${property.length}:${property}=${identity(child)};`;
    }
    const canonical = objects.get(key);
    if (canonical !== undefined) return canonical as T;
    objects.set(key, value);
    Object.freeze(value);
    return value;
  };
  return intern;
}
