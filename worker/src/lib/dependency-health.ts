import { DATA_DEPENDENCY_REGISTRY, type DataDependencyDefinition } from "@shared/lib/data-dependency-registry";
import type {
  CacheStatus,
  CronStatus,
  DependencyCriticality,
  DependencyHealth,
  DependencyHealthItem,
  DependencyHealthStatus,
  PublicationHealth,
  PublicationSurfaceFailure,
  PublicationSurfaceHealth,
  PublicationSurfaceId,
} from "@shared/types/status";

type DependencySignal = {
  status: DependencyHealthStatus;
  updatedAt: number | null;
  ageSeconds: number | null;
  maxAgeSec: number | null;
  reason: string | null;
};

export interface BuildDependencyHealthInput {
  now: number;
  caches: Record<string, CacheStatus>;
  crons: Record<string, CronStatus>;
  publicationHealth: PublicationHealth | null;
}

const STATUS_RANK: Record<DependencyHealthStatus, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  stale: 3,
};

function isActionableStatus(status: DependencyHealthStatus): boolean {
  return status === "degraded" || status === "stale";
}

function maxStatus(left: DependencyHealthStatus, right: DependencyHealthStatus): DependencyHealthStatus {
  return STATUS_RANK[right] > STATUS_RANK[left] ? right : left;
}

function worseSignal(left: DependencySignal | null, right: DependencySignal | null): DependencySignal | null {
  if (!left) return right;
  if (!right) return left;
  if (STATUS_RANK[right.status] > STATUS_RANK[left.status]) return right;
  if (STATUS_RANK[right.status] < STATUS_RANK[left.status]) return left;
  if (left.updatedAt == null) return right;
  if (right.updatedAt == null) return left;
  return right.updatedAt >= left.updatedAt ? right : left;
}

function cacheSignal(cache: CacheStatus | undefined, now: number): DependencySignal {
  if (!cache) {
    return {
      status: "unknown",
      updatedAt: null,
      ageSeconds: null,
      maxAgeSec: null,
      reason: "Cache freshness status unavailable.",
    };
  }

  const maxAgeSec = cache.maxAge;
  const updatedAt = cache.ageSeconds != null ? Math.max(0, now - cache.ageSeconds) : null;
  if (cache.sourceStatus === "stale") {
    return {
      status: "stale",
      updatedAt: cache.sourceUpdatedAt ?? updatedAt,
      ageSeconds: cache.sourceAgeSeconds ?? cache.ageSeconds,
      maxAgeSec,
      reason: cache.warning ?? "Upstream source data is stale.",
    };
  }
  if (cache.sourceStatus === "degraded") {
    return {
      status: "degraded",
      updatedAt: cache.sourceUpdatedAt ?? updatedAt,
      ageSeconds: cache.sourceAgeSeconds ?? cache.ageSeconds,
      maxAgeSec,
      reason: cache.warning ?? "Upstream source data is degraded.",
    };
  }
  if (cache.ageSeconds == null) {
    return {
      status: "stale",
      updatedAt: null,
      ageSeconds: null,
      maxAgeSec,
      reason: cache.warning ?? "Freshness timestamp unavailable.",
    };
  }
  if (cache.ageSeconds > maxAgeSec) {
    return {
      status: "stale",
      updatedAt,
      ageSeconds: cache.ageSeconds,
      maxAgeSec,
      reason: cache.warning ?? `Freshness age ${cache.ageSeconds}s exceeds ${maxAgeSec}s.`,
    };
  }
  if (!cache.healthy) {
    return {
      status: "degraded",
      updatedAt,
      ageSeconds: cache.ageSeconds,
      maxAgeSec,
      reason: cache.warning ?? `Freshness age ${cache.ageSeconds}s is outside the healthy budget.`,
    };
  }

  return {
    status: "healthy",
    updatedAt,
    ageSeconds: cache.ageSeconds,
    maxAgeSec,
    reason: null,
  };
}

function cronSignal(cron: CronStatus | undefined, now: number): DependencySignal {
  if (!cron) {
    return {
      status: "unknown",
      updatedAt: null,
      ageSeconds: null,
      maxAgeSec: null,
      reason: "Cron telemetry unavailable.",
    };
  }

  const updatedAt = cron.lastRun?.startedAt ?? cron.latestAttempt?.updatedAt ?? cron.inFlight?.updatedAt ?? null;
  const ageSeconds = updatedAt != null ? Math.max(0, now - updatedAt) : null;
  const maxAgeSec = cron.expectedIntervalSec * 2;
  if (cron.telemetryUnknown) {
    return {
      status: "unknown",
      updatedAt,
      ageSeconds,
      maxAgeSec,
      reason: "Cron telemetry is marked unknown.",
    };
  }
  if (!cron.healthy) {
    const lastStatus = cron.lastRun?.status ?? cron.latestAttempt?.state ?? null;
    return {
      status: cron.lastRun ? "degraded" : "stale",
      updatedAt,
      ageSeconds,
      maxAgeSec,
      reason: lastStatus ? `Latest cron status is ${lastStatus}.` : "No successful cron run recorded.",
    };
  }

  return {
    status: "healthy",
    updatedAt,
    ageSeconds,
    maxAgeSec,
    reason: null,
  };
}

function publicationTimestamp(surface: PublicationSurfaceHealth): number | null {
  return surface.lastPublishedGeneration?.publishedAt
    ?? surface.lastPublishedGeneration?.validatedAt
    ?? surface.lastPublishedGeneration?.startedAt
    ?? null;
}

function failedPublicationSurfaceSignal(
  failedSurfaces: PublicationSurfaceFailure[] | undefined,
  surfaceId: PublicationSurfaceId,
  checkedAt: number,
  now: number,
): DependencySignal | null {
  const failure = failedSurfaces?.find((entry) => entry.surface === surfaceId);
  if (!failure) return null;
  return {
    status: "degraded",
    updatedAt: checkedAt,
    ageSeconds: Math.max(0, now - checkedAt),
    maxAgeSec: null,
    reason: `${failure.code}: ${failure.message}`,
  };
}

function publicationSignal(surface: PublicationSurfaceHealth | undefined, now: number): DependencySignal {
  if (!surface) {
    return {
      status: "unknown",
      updatedAt: null,
      ageSeconds: null,
      maxAgeSec: null,
      reason: "Publication health surface unavailable.",
    };
  }

  const publishedAt = publicationTimestamp(surface);
  const ageSeconds = publishedAt != null ? Math.max(0, now - publishedAt) : null;
  const latestAttempt = surface.lastAttemptedGeneration;
  if (!surface.lastPublishedGeneration) {
    return {
      status: "stale",
      updatedAt: latestAttempt?.startedAt ?? null,
      ageSeconds: null,
      maxAgeSec: null,
      reason: "No published generation recorded.",
    };
  }

  if (latestAttempt?.state === "failed" && latestAttempt.startedAt > surface.lastPublishedGeneration.startedAt) {
    return {
      status: "degraded",
      updatedAt: latestAttempt.failedAt ?? latestAttempt.startedAt,
      ageSeconds,
      maxAgeSec: null,
      reason: latestAttempt.failureReason ?? surface.lastFailureReason ?? "Latest generation failed.",
    };
  }

  if (surface.candidateAgeSec != null && surface.candidateAgeSec > 2 * 3600) {
    return {
      status: "degraded",
      updatedAt: latestAttempt?.startedAt ?? publishedAt,
      ageSeconds,
      maxAgeSec: 2 * 3600,
      reason: `Candidate generation has been pending for ${surface.candidateAgeSec}s.`,
    };
  }

  return {
    status: "healthy",
    updatedAt: publishedAt,
    ageSeconds,
    maxAgeSec: null,
    reason: null,
  };
}

function signalForDefinition(
  definition: DataDependencyDefinition,
  input: BuildDependencyHealthInput,
): DependencySignal {
  let signal: DependencySignal | null = null;

  if (definition.cacheKey) {
    signal = worseSignal(signal, cacheSignal(input.caches[definition.cacheKey], input.now));
  }
  if (definition.publicationSurface) {
    signal = worseSignal(
      signal,
      failedPublicationSurfaceSignal(
        input.publicationHealth?.failedSurfaces,
        definition.publicationSurface,
        input.publicationHealth?.checkedAt ?? input.now,
        input.now,
      ),
    );
    signal = worseSignal(
      signal,
      publicationSignal(input.publicationHealth?.surfaces[definition.publicationSurface], input.now),
    );
  }
  if (definition.producerJob) {
    signal = worseSignal(signal, cronSignal(input.crons[definition.producerJob], input.now));
  }

  return signal ?? {
    status: "unknown",
    updatedAt: null,
    ageSeconds: null,
    maxAgeSec: null,
    reason: "No dependency signal configured.",
  };
}

function findRootDependencyId(
  id: string,
  dependencies: Record<string, DependencyHealthItem>,
  visiting: Set<string> = new Set(),
): string {
  if (visiting.has(id)) return id;
  visiting.add(id);

  const dependency = dependencies[id];
  if (!dependency) return id;
  const unhealthyParents = dependency.dependsOn
    .map((parentId) => dependencies[parentId])
    .filter((parent): parent is DependencyHealthItem => Boolean(parent) && isActionableStatus(parent.status))
    .sort((left, right) => STATUS_RANK[right.status] - STATUS_RANK[left.status]);

  if (unhealthyParents.length === 0) return id;
  return findRootDependencyId(unhealthyParents[0].id, dependencies, visiting);
}

function collectDownstreamIds(rootId: string, dependencies: Record<string, DependencyHealthItem>): string[] {
  const downstream = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const dependency of Object.values(dependencies)) {
      if (dependency.id === rootId || downstream.has(dependency.id)) continue;
      if (dependency.dependsOn.includes(rootId) || dependency.dependsOn.some((id) => downstream.has(id))) {
        downstream.add(dependency.id);
        changed = true;
      }
    }
  }
  return [...downstream].sort();
}

function maxCriticality(left: DependencyCriticality, right: DependencyCriticality): DependencyCriticality {
  return left === "critical" || right === "critical" ? "critical" : "watch";
}

function buildRootCauseGroups(dependencies: Record<string, DependencyHealthItem>): DependencyHealth["rootCauseGroups"] {
  const grouped = new Map<string, DependencyHealth["rootCauseGroups"][number]>();

  for (const dependency of Object.values(dependencies)) {
    if (!isActionableStatus(dependency.status)) continue;
    const rootId = findRootDependencyId(dependency.id, dependencies);
    const root = dependencies[rootId] ?? dependency;
    const existing = grouped.get(rootId);
    const symptomDependencyIds = new Set(existing?.symptomDependencyIds ?? []);
    if (dependency.id !== rootId) symptomDependencyIds.add(dependency.id);
    const impactedDependencyIds = new Set(existing?.impactedDependencyIds ?? collectDownstreamIds(rootId, dependencies));
    const consumerIds = new Set(existing?.consumerIds ?? root.consumers);
    for (const consumer of dependency.consumers) consumerIds.add(consumer);

    grouped.set(rootId, {
      rootDependencyId: rootId,
      rootStatus: maxStatus(existing?.rootStatus ?? root.status, root.status),
      rootReason: root.reason,
      symptomDependencyIds: [...symptomDependencyIds].sort(),
      impactedDependencyIds: [...impactedDependencyIds].sort(),
      consumerIds: [...consumerIds].sort(),
      criticality: maxCriticality(existing?.criticality ?? root.criticality, dependency.criticality),
    });
  }

  return [...grouped.values()].sort((left, right) => {
    const severity = STATUS_RANK[right.rootStatus] - STATUS_RANK[left.rootStatus];
    if (severity !== 0) return severity;
    if (left.criticality !== right.criticality) return left.criticality === "critical" ? -1 : 1;
    return left.rootDependencyId.localeCompare(right.rootDependencyId);
  });
}

export function buildDependencyHealth(input: BuildDependencyHealthInput): DependencyHealth {
  const dependencies: Record<string, DependencyHealthItem> = {};

  for (const definition of DATA_DEPENDENCY_REGISTRY) {
    const signal = signalForDefinition(definition, input);
    dependencies[definition.id] = {
      id: definition.id,
      label: definition.label,
      sourceOfTruth: definition.sourceOfTruth,
      producerJob: definition.producerJob,
      cacheKey: definition.cacheKey,
      publicationSurface: definition.publicationSurface,
      impactLayer: definition.impactLayer,
      criticality: definition.criticality,
      dependsOn: [...definition.dependsOn],
      consumers: [...definition.consumers],
      status: signal.status,
      checkedAt: input.now,
      updatedAt: signal.updatedAt,
      ageSeconds: signal.ageSeconds,
      maxAgeSec: signal.maxAgeSec,
      reason: signal.reason,
      runbookPath: definition.runbookPath,
    };
  }

  const summary = {
    total: Object.keys(dependencies).length,
    healthy: 0,
    degraded: 0,
    stale: 0,
    unknown: 0,
    rootCauseGroupCount: 0,
  };
  for (const dependency of Object.values(dependencies)) {
    summary[dependency.status] += 1;
  }

  const rootCauseGroups = buildRootCauseGroups(dependencies);
  summary.rootCauseGroupCount = rootCauseGroups.length;

  return {
    checkedAt: input.now,
    dependencies,
    rootCauseGroups,
    summary,
  };
}
