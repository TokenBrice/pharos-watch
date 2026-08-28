import { coerceFiniteNumber } from "@shared/lib/type-guards";

export function toFiniteNumber(value: unknown): number | null {
  return coerceFiniteNumber(value);
}

export function parsePositiveNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function requireFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}
