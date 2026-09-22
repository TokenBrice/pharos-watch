export type WorkerCanaryMode = "off" | "shadow" | "status" | "alert";

export function normalizeWorkerCanaryMode(value: string | undefined): WorkerCanaryMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "shadow" || normalized === "status" || normalized === "alert") return normalized;
  return "off";
}
