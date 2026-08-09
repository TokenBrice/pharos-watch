/**
 * Pharos URN scheme — `urn:pharos:<entity-class>:<id>[@<qualifier>]`
 *
 * RFC 8141 conformant. The grammar is stable: the `urn:pharos:` prefix and
 * separator characters never change. New entity classes may be appended
 * (additive) but existing entries are immutable once shipped. See
 * `docs/pharos-urn.md` for the canonical class list and history.
 *
 * Runtime-neutral. Do not import from `@/` or `worker/` in this file.
 */

/** Closed enum of entity classes recognised by the Pharos URN scheme. */
const PHAROS_URN_ENTITY_CLASSES = [
  "coin",
  "depeg-event",
  "methodology",
  "digest",
  "cemetery",
  "dataset",
  "snapshot",
  "depeg-report",
  "page",
] as const;

export type PharosUrnEntityClass = (typeof PHAROS_URN_ENTITY_CLASSES)[number];

export interface PharosUrn {
  entityClass: PharosUrnEntityClass;
  id: string;
  qualifier?: string;
}

const URN_PREFIX = "urn:pharos:";

const ID_ALPHABET = /^[a-z0-9-]+$/;
const QUALIFIER_ALPHABET = /^[a-z0-9.-]+$/;
const ALPHANUMERIC = /^[a-z0-9]$/;

function isValidSegment(value: string, alphabet: RegExp): boolean {
  if (value.length === 0) return false;
  if (!ALPHANUMERIC.test(value[0])) return false;
  if (!ALPHANUMERIC.test(value[value.length - 1])) return false;
  return alphabet.test(value);
}

function isValidId(value: string): boolean {
  return isValidSegment(value, ID_ALPHABET);
}

function isValidQualifier(value: string): boolean {
  return isValidSegment(value, QUALIFIER_ALPHABET);
}

function isEntityClass(value: string): value is PharosUrnEntityClass {
  return (PHAROS_URN_ENTITY_CLASSES as readonly string[]).includes(value);
}

/**
 * Format a Pharos URN.
 *
 * @example
 *   formatPharosUrn("coin", "usdc-circle")
 *   // → "urn:pharos:coin:usdc-circle"
 *
 *   formatPharosUrn("methodology", "safety-score", "v7.2")
 *   // → "urn:pharos:methodology:safety-score@v7.2"
 *
 * @throws TypeError on invalid input.
 */
export function formatPharosUrn(
  entityClass: PharosUrnEntityClass,
  id: string,
  qualifier?: string,
): string {
  if (!isEntityClass(entityClass)) {
    throw new TypeError(`Invalid Pharos URN entity class: ${entityClass}`);
  }
  if (!isValidId(id)) {
    throw new TypeError(`Invalid Pharos URN id: ${id}`);
  }
  if (qualifier !== undefined && !isValidQualifier(qualifier)) {
    throw new TypeError(`Invalid Pharos URN qualifier: ${qualifier}`);
  }
  const base = `${URN_PREFIX}${entityClass}:${id}`;
  return qualifier ? `${base}@${qualifier}` : base;
}

/**
 * Parse a Pharos URN. Returns `null` on any malformed input.
 *
 * Strict validation: lowercase only, hyphens not underscores, `urn:pharos:`
 * prefix required, entity-class must be in the closed enum.
 */
// The documented inverse of `formatPharosUrn` (docs/pharos-urn.md). No runtime
// caller today; its suite is the round-trip guard for the formatter, which is
// in production via `src/lib/pharos-urn-json-ld.ts`.
export function parsePharosUrn(urn: string): PharosUrn | null {
  if (typeof urn !== "string") return null;
  if (!urn.startsWith(URN_PREFIX)) return null;

  const remainder = urn.slice(URN_PREFIX.length);
  const colonIndex = remainder.indexOf(":");
  if (colonIndex <= 0) return null;

  const entityClass = remainder.slice(0, colonIndex);
  if (!isEntityClass(entityClass)) return null;

  const tail = remainder.slice(colonIndex + 1);
  if (!tail) return null;

  const atIndex = tail.indexOf("@");
  if (atIndex === -1) {
    if (!isValidId(tail)) return null;
    return { entityClass, id: tail };
  }

  const id = tail.slice(0, atIndex);
  const qualifier = tail.slice(atIndex + 1);
  if (!isValidId(id)) return null;
  if (!isValidQualifier(qualifier)) return null;
  return { entityClass, id, qualifier };
}
