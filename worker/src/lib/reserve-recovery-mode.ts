export type ReserveRecoveryMode = "off" | "shadow" | "reconcile" | "recover";

export function normalizeReserveRecoveryMode(value: string | null | undefined): ReserveRecoveryMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "shadow" || normalized === "reconcile" || normalized === "recover") {
    return normalized;
  }
  return "off";
}
