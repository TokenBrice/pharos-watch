import type {
  CircuitRecord,
  ProviderCircuitHealth,
  ProviderCircuitHealthEntry,
  ProviderCircuitHealthFamilySummary,
} from "@shared/types/status";
import { getProviderCircuitIndex, listActiveCircuitSources } from "./circuit-breaker";

function providerFamily(source: string): string {
  if (source.startsWith("live-reserves:")) return "live-reserves";
  if (source.startsWith("defillama-")) return "defillama";
  if (source.startsWith("coingecko-")) return "coingecko";
  if (source.startsWith("dexscreener-")) return "dexscreener";
  if (source.startsWith("dex-direct-api:")) return "dex-direct-api";
  if (source.startsWith("fx-")) return "fx";
  const [prefix] = source.split("-");
  return prefix || "unknown";
}

function emptyFamilySummary(): ProviderCircuitHealthFamilySummary {
  return {
    total: 0,
    closed: 0,
    halfOpen: 0,
    open: 0,
  };
}

function incrementFamily(
  byFamily: Record<string, ProviderCircuitHealthFamilySummary>,
  family: string,
  state: CircuitRecord["state"],
): void {
  const summary = byFamily[family] ?? emptyFamilySummary();
  summary.total++;
  if (state === "open") {
    summary.open++;
  } else if (state === "half-open") {
    summary.halfOpen++;
  } else {
    summary.closed++;
  }
  byFamily[family] = summary;
}

function toProviderEntry(source: string, record: CircuitRecord, now: number): ProviderCircuitHealthEntry {
  return {
    providerId: source,
    family: providerFamily(source),
    state: record.state,
    consecutiveFailures: record.consecutiveFailures,
    openedAt: record.openedAt,
    openAgeSec: record.openedAt == null ? null : Math.max(0, now - record.openedAt),
    lastFailureAt: record.lastFailureAt,
    lastSuccessAt: record.lastSuccessAt,
  };
}

export async function loadProviderCircuitHealth(
  db: D1Database,
  now: number,
): Promise<ProviderCircuitHealth> {
  const sources = listActiveCircuitSources();
  if (sources.length === 0) {
    return {
      checkedAt: now,
      status: "healthy",
      totalTracked: 0,
      closedCount: 0,
      halfOpenCount: 0,
      openCount: 0,
      openProviders: [],
      byFamily: {},
    };
  }

  const indexedRecords = await getProviderCircuitIndex(db);

  let closedCount = 0;
  let halfOpenCount = 0;
  let openCount = 0;
  const byFamily: Record<string, ProviderCircuitHealthFamilySummary> = {};
  const openProviders: ProviderCircuitHealthEntry[] = [];
  for (const source of sources) {
    const record = indexedRecords[source] ?? {
      state: "closed",
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      openedAt: null,
    };
    const family = providerFamily(source);
    incrementFamily(byFamily, family, record.state);
    if (record.state === "open") {
      openCount++;
      openProviders.push(toProviderEntry(source, record, now));
    } else if (record.state === "half-open") {
      halfOpenCount++;
      openProviders.push(toProviderEntry(source, record, now));
    } else {
      closedCount++;
    }
  }

  openProviders.sort((left, right) => {
    if (left.state !== right.state) return left.state === "open" ? -1 : 1;
    return (right.openAgeSec ?? -1) - (left.openAgeSec ?? -1);
  });

  return {
    checkedAt: now,
    status: openCount > 0 || halfOpenCount > 0 ? "degraded" : "healthy",
    totalTracked: sources.length,
    closedCount,
    halfOpenCount,
    openCount,
    openProviders: openProviders.slice(0, 25),
    byFamily,
  };
}
