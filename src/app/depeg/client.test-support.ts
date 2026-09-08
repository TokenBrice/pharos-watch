import { vi, type Mock } from "vitest";

/**
 * Fresh query envelopes and resolver surfaces for the depeg route client.
 *
 * Every builder returns new objects with its own refetch spy so a case can
 * assert which queries a retry actually touched, and each scenario keeps its
 * distinguishing fields (enabled flags, pending incidents, events, errors)
 * visible at the call site.
 */
export interface QueryEnvelope<T> {
  data: T | undefined;
  error: Error | null;
  dataUpdatedAt: number;
  meta: null;
  refetch: Mock;
}

export interface DepegCoinFixture {
  id: string;
  symbol: string;
  name: string;
  pegType: string;
  pegCurrency: string;
  governance: string;
  currentDeviationBps: number;
  pegScore: number;
  pegPct: number;
  severityScore: number;
  spreadPenalty: number;
  eventCount: number;
  worstDeviationBps: number | null;
  activeDepeg: boolean;
  lastEventAt: number | null;
  trackingSpanDays: number;
  methodologyVersion: string;
}

export function makeCoin(
  id: string,
  symbol: string,
  overrides: Partial<DepegCoinFixture> = {},
): DepegCoinFixture {
  return {
    id,
    symbol,
    name: symbol,
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: 100,
    pegPct: 100,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: null,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 90,
    methodologyVersion: "v1",
    ...overrides,
  };
}

export function makePegSummaryResult(options: {
  coins: DepegCoinFixture[];
  summary?: Record<string, unknown>;
  isLoading?: boolean;
}): QueryEnvelope<{ coins: DepegCoinFixture[]; summary: Record<string, unknown> }> & { isLoading: boolean } {
  return {
    data: {
      coins: options.coins,
      summary: {
        activeDepegCount: options.coins.filter((coin) => coin.activeDepeg).length,
        medianDeviationBps: 0,
        worstCurrent: null,
        coinsAtPeg: options.coins.length,
        totalTracked: options.coins.length,
        depegEventsToday: 0,
        depegEventsYesterday: 0,
        ...options.summary,
      },
    },
    isLoading: options.isLoading ?? false,
    error: null,
    dataUpdatedAt: 0,
    meta: null,
    refetch: vi.fn(),
  };
}

export interface StressSignalFixture {
  band: string;
  computedAt?: number;
}

export function makeStressSignalsResult(options: {
  signals?: Record<string, StressSignalFixture>;
  oldestComputedAt?: number;
  malformedRows?: number;
} = {}): QueryEnvelope<Record<string, unknown>> {
  return {
    data: {
      signals: options.signals ?? {},
      oldestComputedAt: options.oldestComputedAt,
      malformedRows: options.malformedRows,
      updatedAt: 1_700_000_000,
      methodology: {},
    },
    error: null,
    dataUpdatedAt: 0,
    meta: null,
    refetch: vi.fn(),
  };
}

export interface DepegEventFixture {
  id: number;
  stablecoinId: string;
  symbol: string;
  endedAt: number | null;
}

export interface PendingIncidentFixture {
  stablecoinId: string;
  symbol: string;
  direction: string;
  firstSeenAt: number;
}

export function makeEventsResult(options: {
  events?: DepegEventFixture[];
  pending?: PendingIncidentFixture[];
} = {}) {
  return {
    data: { events: options.events ?? [], pending: options.pending ?? [] },
    error: null,
    dataUpdatedAt: 0,
    meta: null,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  };
}

const RESOLVER_META = {
  dataAsOf: 0,
  modelAsOf: 0,
  computedAt: 0,
  expiresAt: 0,
  degraded: false,
  degradedReason: null,
  publicWarning: "",
  resolutionRubricVersion: "v1",
  durationModelVersion: "v1",
  incidentGroupingVersion: "v1",
  supportRulesVersion: "v1",
  lineage: null,
};

const RESOLVER_REVIEW_META = {
  computedAt: 0,
  expiresAt: 0,
  degraded: false,
  degradedReason: null,
  reviewerVersion: "ddr-reviewer-v1",
  publicWarning: "",
  assessedEventCount: 0,
  reviewedEventCount: 0,
  pendingEventCount: 0,
  durationScoredCount: 0,
  verdictScoredCount: 0,
  methodologyVersions: [],
};

export function makeResolverSurfaces(options: {
  resolverEnabled?: boolean;
  resolverReviewerEnabled?: boolean;
  resolverError?: Error | null;
  reviewError?: Error | null;
  withData?: boolean;
} = {}) {
  const withData = options.withData ?? true;
  return {
    resolverEnabled: options.resolverEnabled ?? true,
    resolverReviewerEnabled: options.resolverReviewerEnabled ?? true,
    resolver: {
      data: withData ? { _meta: { ...RESOLVER_META }, rows: [], methodology: {} } : undefined,
      error: options.resolverError ?? null,
      dataUpdatedAt: 0,
      meta: null,
      refetch: vi.fn(),
    },
    resolverReview: {
      data: withData
        ? { _meta: { ...RESOLVER_REVIEW_META }, summary: {}, rows: [], methodology: {} }
        : undefined,
      error: options.reviewError ?? null,
      dataUpdatedAt: 0,
      meta: null,
      refetch: vi.fn(),
    },
  };
}

export function makeUrlFilters(params: Record<string, string> = {}) {
  return {
    getParam: (key: string, fallback = "") => params[key] ?? fallback,
    setParam: vi.fn(),
    setParams: vi.fn(),
  };
}
