export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function requireFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}
