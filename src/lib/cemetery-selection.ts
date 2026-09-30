import { CAUSE_OF_DEATH_VALUES, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { PEG_CURRENCY_VALUES, type PegCurrency } from "@shared/types/core";
import { MECHANISM_ARCHETYPE_VALUES, type MechanismArchetype } from "@shared/types/stablecoin-taxonomy";

/**
 * Pure contracts behind cemetery selection and deep links (plan §7.1) and the
 * Autopsy Register URL filters (plan §6.3). `#<id>` is the canonical record
 * anchor; `#obituary-<id>` is a legacy alias.
 */

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

export const CEMETERY_SECTION_ANCHORS = [
  "cemetery",
  "key-facts",
  "causes",
  "register",
  "analysis",
  "methodology",
  "dataset",
  "faq",
] as const;
export type CemeteryStaticSectionAnchor = (typeof CEMETERY_SECTION_ANCHORS)[number];
export type CemeteryCauseAnchor = `cause-${CauseOfDeath}`;
export type CemeterySectionAnchor = CemeteryStaticSectionAnchor | CemeteryCauseAnchor;

export const CEMETERY_RESERVED_ID_PREFIXES = ["grave-", "walk-", "obituary-", "autopsy-", "cause-"] as const;

const LEGACY_RECORD_PREFIX = "obituary-";
const CAUSE_ANCHOR_PREFIX = "cause-";

/** The `#cause-<slug>` anchor for one cause row in "How stablecoins die". */
export function cemeteryCauseAnchor(cause: CauseOfDeath): CemeteryCauseAnchor {
  return `${CAUSE_ANCHOR_PREFIX}${cause}`;
}

function isStaticSectionAnchor(value: string): value is CemeteryStaticSectionAnchor {
  return (CEMETERY_SECTION_ANCHORS as readonly string[]).includes(value);
}

function isCauseOfDeath(value: string): value is CauseOfDeath {
  return (CAUSE_OF_DEATH_VALUES as readonly string[]).includes(value);
}

export type CemeteryHashTarget =
  | { kind: "record"; id: string; legacy: boolean }
  | { kind: "section"; anchor: CemeterySectionAnchor }
  | null;

/**
 * Resolves a location hash (with or without the leading `#`, URL-encoded or
 * not) against the known record ids. Unknown ids, unknown `cause-*` slugs and
 * malformed encodings resolve to `null`.
 */
export function parseCemeteryHash(hash: string, knownIds: ReadonlySet<string>): CemeteryHashTarget {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  let target: string;
  try {
    target = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!target) return null;

  if (isStaticSectionAnchor(target)) return { kind: "section", anchor: target };
  if (target.startsWith(CAUSE_ANCHOR_PREFIX)) {
    const cause = target.slice(CAUSE_ANCHOR_PREFIX.length);
    return isCauseOfDeath(cause) ? { kind: "section", anchor: cemeteryCauseAnchor(cause) } : null;
  }
  if (knownIds.has(target)) return { kind: "record", id: target, legacy: false };
  if (target.startsWith(LEGACY_RECORD_PREFIX)) {
    const id = target.slice(LEGACY_RECORD_PREFIX.length);
    if (knownIds.has(id)) return { kind: "record", id, legacy: true };
  }
  return null;
}

/**
 * Record ids that would shadow a section anchor or a reserved element-id
 * namespace. Must be empty for the real cemetery set.
 */
export function findCemeteryIdCollisions(ids: Iterable<string>): string[] {
  const collisions = new Set<string>();
  for (const id of ids) {
    if (isStaticSectionAnchor(id) || CEMETERY_RESERVED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) {
      collisions.add(id);
    }
  }
  return [...collisions];
}

// ---------------------------------------------------------------------------
// Peak buckets
// ---------------------------------------------------------------------------

export const CEMETERY_PEAK_BUCKET_KEYS = ["1b-plus", "100m-1b", "10m-100m", "under-10m", "not-recorded"] as const;
export type CemeteryPeakBucket = (typeof CEMETERY_PEAK_BUCKET_KEYS)[number];

export const CEMETERY_PEAK_BUCKET_LABELS: Readonly<Record<CemeteryPeakBucket, string>> = {
  "1b-plus": "$1B or more",
  "100m-1b": "$100M to $1B",
  "10m-100m": "$10M to $100M",
  "under-10m": "Under $10M",
  "not-recorded": "Not recorded",
};

/**
 * Buckets a recorded peak market cap. A missing, non-finite or non-positive
 * peak is "not-recorded", never the smallest bucket.
 */
export function peakBucketOf(peak: number | null | undefined): CemeteryPeakBucket {
  if (peak == null || !Number.isFinite(peak) || peak <= 0) return "not-recorded";
  if (peak >= 1_000_000_000) return "1b-plus";
  if (peak >= 100_000_000) return "100m-1b";
  if (peak >= 10_000_000) return "10m-100m";
  return "under-10m";
}

// ---------------------------------------------------------------------------
// Register filters
// ---------------------------------------------------------------------------

/** URL params owned by the Autopsy Register, in canonical href order. */
const CEMETERY_REGISTER_PARAMS = ["cause", "year", "peg", "mechanism", "record", "peak", "q", "sort", "dir"] as const;
export type CemeteryRegisterParam = (typeof CEMETERY_REGISTER_PARAMS)[number];

/** "tracked" = tracked archive (frozen) rows, "curated" = the rest, "case-study" = rows with a case study. */
const CEMETERY_RECORD_FILTER_VALUES = ["tracked", "curated", "case-study"] as const;
export type CemeteryRecordFilter = (typeof CEMETERY_RECORD_FILTER_VALUES)[number];

export const CEMETERY_RECORD_FILTER_LABELS: Readonly<Record<CemeteryRecordFilter, string>> = {
  tracked: "Tracked archive",
  curated: "Curated",
  "case-study": "Case study",
};

const CEMETERY_REGISTER_SORT_KEYS = ["died", "peak", "name", "cause"] as const;
export type CemeteryRegisterSortKey = (typeof CEMETERY_REGISTER_SORT_KEYS)[number];

const CEMETERY_REGISTER_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type CemeteryRegisterSortDirection = (typeof CEMETERY_REGISTER_SORT_DIRECTIONS)[number];

export const CEMETERY_REGISTER_QUERY_MAX_LENGTH = 80;

export interface CemeteryRegisterFilters {
  cause?: CauseOfDeath;
  /** Four-digit death year, kept as a string to compare with `deathDate`. */
  year?: string;
  peg?: PegCurrency;
  mechanism?: MechanismArchetype;
  record?: CemeteryRecordFilter;
  peak?: CemeteryPeakBucket;
  /** Trimmed search text, at most {@link CEMETERY_REGISTER_QUERY_MAX_LENGTH} characters. */
  q?: string;
  sort?: CemeteryRegisterSortKey;
  dir?: CemeteryRegisterSortDirection;
}

function oneOf<T extends string>(values: readonly T[]) {
  return (value: string): T | undefined => ((values as readonly string[]).includes(value) ? (value as T) : undefined);
}

const REGISTER_PARAM_NORMALIZERS: {
  readonly [K in CemeteryRegisterParam]: (value: string) => CemeteryRegisterFilters[K] | undefined;
} = {
  cause: oneOf(CAUSE_OF_DEATH_VALUES),
  year: (value) => (/^\d{4}$/.test(value) ? value : undefined),
  peg: oneOf(PEG_CURRENCY_VALUES),
  mechanism: oneOf(MECHANISM_ARCHETYPE_VALUES),
  record: oneOf(CEMETERY_RECORD_FILTER_VALUES),
  peak: oneOf(CEMETERY_PEAK_BUCKET_KEYS),
  q: (value) => value.trim().slice(0, CEMETERY_REGISTER_QUERY_MAX_LENGTH).trimEnd() || undefined,
  sort: oneOf(CEMETERY_REGISTER_SORT_KEYS),
  dir: oneOf(CEMETERY_REGISTER_SORT_DIRECTIONS),
};

function normalizeRegisterFilters(read: (param: CemeteryRegisterParam) => string | null | undefined): CemeteryRegisterFilters {
  const filters: CemeteryRegisterFilters = {};
  for (const param of CEMETERY_REGISTER_PARAMS) {
    const raw = read(param);
    if (raw == null) continue;
    const value = REGISTER_PARAM_NORMALIZERS[param](raw);
    if (value !== undefined) (filters as Record<CemeteryRegisterParam, string>)[param] = value;
  }
  return filters;
}

/** Reads the register filters from URL params, dropping every invalid value. */
export function parseRegisterFilters(params: URLSearchParams): CemeteryRegisterFilters {
  return normalizeRegisterFilters((param) => params.get(param));
}

export interface BuildRegisterHrefOptions {
  /** Current params; unrelated (non-register) params are preserved in order after the register params. */
  base?: URLSearchParams;
  /** Defaults to `/cemetery/`. */
  pathname?: string;
  /** Hash target without `#`; defaults to `register`, `null` omits it. */
  hash?: string | null;
}

/**
 * Builds a register link such as `/cemetery/?cause=abandoned#register`.
 * `filters` is the complete register state: register params in `base` are
 * replaced, invalid values are dropped, and params follow
 * {@link CEMETERY_REGISTER_PARAMS} order.
 */
export function buildRegisterHref(filters: CemeteryRegisterFilters, opts: BuildRegisterHrefOptions = {}): string {
  const { base, pathname = "/cemetery/", hash = "register" } = opts;
  const normalized = normalizeRegisterFilters((param) => filters[param]);
  const params = new URLSearchParams();
  for (const param of CEMETERY_REGISTER_PARAMS) {
    const value = normalized[param];
    if (value !== undefined) params.append(param, value);
  }
  if (base) {
    const registerParams: readonly string[] = CEMETERY_REGISTER_PARAMS;
    for (const [key, value] of base) {
      if (!registerParams.includes(key)) params.append(key, value);
    }
  }
  const search = params.toString();
  return `${pathname}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
}
