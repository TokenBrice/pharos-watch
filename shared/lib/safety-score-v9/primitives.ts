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

export function domainKey(domain: V9FailureDomainRef): string {
  return `${domain.kind}:${domain.key}`;
}

export function canonicalDomains(domains: readonly V9FailureDomainRef[]): V9FailureDomainRef[] {
  return [...new Map(domains.map((domain) => [domainKey(domain), domain])).values()].sort((left, right) =>
    compareText(domainKey(left), domainKey(right)),
  );
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
