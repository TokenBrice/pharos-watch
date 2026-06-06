export { readJsonStorageValue, writeJsonStorageValue } from "@/lib/browser-storage";

export type SearchInput = string | URLSearchParams;

export function toSearchParams(input: SearchInput): URLSearchParams {
  return typeof input === "string" ? new URLSearchParams(input) : input;
}

export function parseEnumSearchParam<const T extends string>(
  input: SearchInput,
  key: string,
  values: readonly T[],
  options?: {
    normalize?: (value: string) => string;
    fallback?: T | null;
  },
): T | null {
  const raw = toSearchParams(input).get(key);
  if (raw == null) return options?.fallback ?? null;
  const normalized = options?.normalize ? options.normalize(raw) : raw;
  return values.includes(normalized as T) ? normalized as T : options?.fallback ?? null;
}

export function parseBoundedNumberSearchParam(
  input: SearchInput,
  key: string,
  options?: {
    fallback?: number | null;
    min?: number;
    max?: number;
    integer?: boolean;
  },
): number | null {
  const raw = toSearchParams(input).get(key);
  if (raw == null || raw.trim() === "") return options?.fallback ?? null;

  const value = Number(raw);
  if (!Number.isFinite(value)) return options?.fallback ?? null;
  const normalized = options?.integer ? Math.trunc(value) : value;
  if (options?.min != null && normalized < options.min) return options?.fallback ?? null;
  if (options?.max != null && normalized > options.max) return options?.fallback ?? null;
  return normalized;
}

export function parseBooleanSearchParam(
  input: SearchInput,
  key: string,
  fallback: boolean | null = null,
): boolean | null {
  const raw = toSearchParams(input).get(key);
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

export function parseStringSearchParam(
  input: SearchInput,
  key: string,
  options?: {
    trim?: boolean;
    fallback?: string | null;
  },
): string | null {
  const raw = toSearchParams(input).get(key);
  if (raw == null) return options?.fallback ?? null;
  const value = options?.trim === false ? raw : raw.trim();
  return value === "" ? options?.fallback ?? null : value;
}

export function parseArraySearchParam<T>(
  input: SearchInput,
  key: string,
  decodeItem: (value: string) => T | null,
  options?: {
    delimiter?: string;
    maxItems?: number;
  },
): T[] {
  const raw = toSearchParams(input).get(key);
  if (!raw) return [];
  const delimiter = options?.delimiter ?? ",";
  const items = raw
    .split(delimiter)
    .map((value) => decodeItem(value.trim()))
    .filter((value): value is T => value !== null);
  return options?.maxItems == null ? items : items.slice(0, options.maxItems);
}

export function parseStablecoinIdSearchParam(
  input: SearchInput,
  key: string,
  options: {
    decode?: (value: string) => string | null;
    isKnownCoinId: (value: string) => boolean;
  },
): string | null {
  const raw = toSearchParams(input).get(key);
  if (!raw) return null;
  const coinId = options.decode ? options.decode(raw) : raw;
  return coinId && options.isKnownCoinId(coinId) ? coinId : null;
}
