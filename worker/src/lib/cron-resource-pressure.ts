import { ResourcePressureSchema, type ResourcePressure } from "@shared/types/status/cron";

/** Select valid evidence by its observation clock; the candidate wins ties. */
export function selectLatestResourcePressure(
  current: ResourcePressure | null,
  candidate: unknown,
): ResourcePressure | null {
  const parsed = ResourcePressureSchema.safeParse(candidate);
  return parsed.success && (!current || parsed.data.observedAt >= current.observedAt)
    ? parsed.data : current;
}

/** Estimates and intake evidence only: Workers exposes no usable heap API. */
export function buildResourcePressure(
  input: Partial<ResourcePressure> & { cacheBypassed?: boolean } = {},
): ResourcePressure {
  const measured = input.intakeBytes != null || input.cacheBytes != null
    || input.inputBytes != null || input.catalogAssets != null;
  const guard = input.guard === "resource-budget-exceeded" || (input.rejectedBodies != null && input.rejectedBodies > 0)
    ? "resource-budget-exceeded"
    : input.cacheBypassed ? "cache-bypassed" : input.guard ?? (measured ? "within-policy" : "not-measured");
  return ResourcePressureSchema.parse({
    phase: (input.phase?.trim() || "not-measured").slice(0, 80),
    observedAt: input.observedAt ?? Math.floor(Date.now() / 1000),
    bodyCapBytes: input.bodyCapBytes ?? null,
    cacheCapBytes: input.cacheCapBytes ?? null,
    cacheEntryCapBytes: input.cacheEntryCapBytes ?? null,
    maxConcurrentDecodes: input.maxConcurrentDecodes ?? null,
    inputCapBytes: input.inputCapBytes ?? null,
    catalogMaxAssets: input.catalogMaxAssets ?? null,
    intakeBytes: input.intakeBytes ?? null,
    cacheBytes: input.cacheBytes ?? null,
    rejectedBodies: input.rejectedBodies ?? null,
    inputBytes: input.inputBytes ?? null,
    catalogAssets: input.catalogAssets ?? null,
    intakeBasis: input.intakeBytes == null ? "unavailable" : "actual-stream",
    cacheBasis: input.cacheBasis ?? "unavailable",
    guard,
    platformOutcome: input.platformOutcome ?? null,
    platformOutcomeSource: input.platformOutcomeSource ?? null,
    heapUsedBytes: null,
    heapUnavailableReason: "workers-runtime-no-heap-api",
  });
}
