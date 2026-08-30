import {
  compareText,
  type V9FailureDomainRef,
} from "../../types/safety-score-v9-fact-primitives";
import { sha256HexFromUtf8Chunks } from "../sha256";
import { stableJsonStringifyChunksV1 } from "../stable-json";

// Canonical ordering is a determinism-digest input; it has one definition.
export { compareText };
export { clampScore } from "../math";

export function assertScore(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Safety Score v9 ${field} must be between 0 and 100`);
  }
}

export function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
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
  return canonicalUniqueBy(domains, domainKey, (left, right) => compareText(domainKey(left), domainKey(right)), "last");
}

export function domainDigest(domain: string, payload: unknown): string {
  return sha256HexFromUtf8Chunks(
    stableJsonStringifyChunksV1({ domain, payload }),
  );
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
