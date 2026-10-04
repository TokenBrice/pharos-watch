import { compareCodeUnits } from "../compare";
import type { V9FailureDomainRef } from "../../types/safety-score-v9-fact-primitives";
import { sha256HexFromUtf8Chunks } from "../sha256";
import { stableJsonStringifyChunksV1 } from "../stable-json";

// Compatibility name for existing V9 callers; implementation lives in compare.ts.
export { compareCodeUnits as compareText } from "../compare";

// Shared immutable result metadata, never a mutable working list. The mutable
// annotation matches schema-inferred arrays; the finalized graph is read-only.
export const V9_EMPTY_ARRAY: never[] = Object.freeze([]) as unknown as never[];
const EMPTY_INTERNED_OBJECT: Record<string, never> = Object.freeze({});

export function assertScore(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Safety Score v9 ${field} must be between 0 and 100`);
  }
}

export function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

export function canonicalUniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  compare: (left: T, right: T) => number,
  keep: "first" | "last" = "first",
): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (keep === "first" && byKey.has(key)) continue;
    byKey.set(key, value);
  }
  return [...byKey.values()].sort(compare);
}

export function parentAttributionFields(
  item: { source: string; path: string; message: string },
  context: { pathPrefix: string; messagePrefix: string },
): { path: string; message: string } {
  const alreadyAttributed = item.source === "parent-score" && item.path.startsWith(context.pathPrefix);
  return {
    path: alreadyAttributed ? item.path : `${context.pathPrefix}${item.path}`,
    message:
      alreadyAttributed && item.message.startsWith(context.messagePrefix)
        ? item.message
        : `${context.messagePrefix}${item.message}`,
  };
}

export function propagateParentAttribution<T, R>({
  upstreamAssetId,
  items,
  project,
  keyOf,
  compare,
}: {
  upstreamAssetId: string;
  items: readonly T[];
  project: (
    item: T,
    context: {
      upstreamAssetId: string;
      pathPrefix: string;
      messagePrefix: string;
    },
  ) => R;
  keyOf: (value: R) => string;
  compare: (left: R, right: R) => number;
}): R[] {
  const pathPrefix = `parent:${upstreamAssetId}:`;
  const messagePrefix = `Required parent ${upstreamAssetId}: `;
  return canonicalUniqueBy(items.map((item) => project(item, { upstreamAssetId, pathPrefix, messagePrefix })), keyOf, compare, "last");
}

export function domainKey(domain: V9FailureDomainRef): string {
  return `${domain.kind}:${domain.key}`;
}

export function canonicalDomains(domains: readonly V9FailureDomainRef[]): V9FailureDomainRef[] {
  return canonicalUniqueBy(domains, domainKey, (left, right) => compareCodeUnits(domainKey(left), domainKey(right)), "last");
}

export function domainDigest(domain: string, payload: unknown): string {
  return sha256HexFromUtf8Chunks(
    stableJsonStringifyChunksV1({ domain, payload }),
  );
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Intern freshly schema-admitted values within one asset, never across generations. */
export function createV9ValueInterner(
  canonicalize?: (value: object, keys: readonly string[]) => object | undefined,
  isAlreadyAdmitted?: (value: object) => boolean,
): <T>(value: T) => T {
  const objects = new Map<string, object>();
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
    if (keys.length === 0) return (array ? V9_EMPTY_ARRAY : EMPTY_INTERNED_OBJECT) as T;
    const replacement = canonicalize?.(value, keys);
    if (replacement !== undefined) return replacement as T;
    const record = value as Record<string, unknown>;
    let key = array ? "a" : "o";
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
