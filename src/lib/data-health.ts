import type { ApiMeta } from "@/lib/api";
import { ApiFetchError } from "@/lib/api";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";

type DataHealthState = "fresh" | "degraded" | "stale" | "unavailable" | "error";

/** A producer that refreshed its totals while some sources are still backfilling coverage. */
export interface DataHealthCatchUp {
  /** Seconds; when the producer last rebuilt the observed totals. */
  observedAt: number;
  sources: readonly { label: string; lastSucceededAt: number | null }[];
}

interface QueryHealthInput {
  label: string;
  dataUpdatedAt: number;
  staleTime: number;
  error?: unknown | null;
  hasData?: boolean;
  meta?: ApiMeta | null;
  catchUp?: DataHealthCatchUp | null;
}

export interface DataHealthInfo {
  label: string;
  state: DataHealthState;
  message: string;
  dataUpdatedAt: number;
  ageMs: number | null;
  staleTime: number;
  meta: ApiMeta | null;
  degradationReason?: "age" | "source" | "refresh" | "catch-up";
  /** Set with `catch-up`: totals are current; only these sources hold the coverage clock back. */
  catchUp?: { observedAtMs: number; laggingLabels: string[] };
}

interface MergedDataHealth {
  state: DataHealthState;
  affectedLabels: string[];
  latestUpdatedAt: number | null;
}

const STATE_PRIORITY: Record<DataHealthState, number> = {
  error: 5,
  unavailable: 4,
  stale: 3,
  degraded: 2,
  fresh: 1,
};

function decodeDataHealthWarning(raw: string): string {
  const prefix = raw.match(/^\d{3}\s+\S+\s+"/);
  if (!prefix) return raw;
  let index = prefix[0].length - 1;
  const readQuoted = (): string | null => {
    if (raw[index] !== '"') return null;
    index += 1;
    let text = "";
    while (index < raw.length) {
      const char = raw[index++];
      if (char === '"') return text;
      if (char === "\\") {
        if (index === raw.length) return null;
        text += raw[index++];
      } else {
        text += char;
      }
    }
    return null;
  };
  const message = readQuoted();
  if (message === null) return raw;
  const messageEnd = index;
  while (index < raw.length && /\s/.test(raw[index])) index += 1;
  if (index < raw.length) {
    // The optional final quoted string is an HTTP warn-date, not product copy.
    if (index === messageEnd || readQuoted() === null) return raw;
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
  }
  return index === raw.length ? message : raw;
}

/** Keep transport syntax in metadata, never in reader-facing warning copy. */
export function parseDataHealthWarnings(warning: string): { raw: string; message: string }[] {
  if (!/^\s*\d{3}\s+\S+\s+"/.test(warning)) return [{ raw: warning, message: warning }];
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let protocolEntry = true;
  for (let index = 0; index < warning.length; index += 1) {
    const char = warning[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && char === "\\") {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n")) {
      const nextIsProtocol = /^\s*\d{3}\s+\S+\s+"/.test(warning.slice(index + 1));
      if (protocolEntry || nextIsProtocol) {
        entries.push(warning.slice(start, index).trim());
        start = index + 1;
        protocolEntry = nextIsProtocol;
      }
    }
  }
  entries.push(warning.slice(start).trim());
  return entries.filter(Boolean).map((raw) => ({ raw, message: decodeDataHealthWarning(raw) }));
}

export function formatDataHealthWarning(warning: string): string {
  return parseDataHealthWarnings(warning).map(({ message }) => message).join("\n");
}

function isUnavailableError(error: unknown): boolean {
  return error instanceof ApiFetchError && error.status === 503;
}

function getFreshBudgetMs(staleTime: number, meta: ApiMeta | null | undefined): number {
  const freshBudgetSec = meta && "freshBudgetSec" in meta ? meta.freshBudgetSec : undefined;
  return typeof freshBudgetSec === "number" && Number.isFinite(freshBudgetSec) && freshBudgetSec >= 0
    ? freshBudgetSec * 1000
    : FRESHNESS_RATIOS.FRESH * staleTime;
}

function getDegradedBudgetMs(staleTime: number, meta: ApiMeta | null | undefined): number {
  const budget = meta && "degradedBudgetSec" in meta ? meta.degradedBudgetSec : undefined;
  return typeof budget === "number" && Number.isFinite(budget) && budget >= 0
    ? budget * 1000
    : FRESHNESS_RATIOS.DEGRADED * staleTime;
}

/** The public stale boundary a verdict was judged against: producer `degradedBudgetSec`, else 12x base. */
export function getPublicStaleBudgetMs(entry: Pick<DataHealthInfo, "staleTime" | "meta">): number {
  return getDegradedBudgetMs(entry.staleTime, entry.meta);
}

function getUpdatedAtMs(input: QueryHealthInput): number {
  return input.meta?.updatedAt === null
    ? 0
    : input.meta?.updatedAt != null && input.meta.updatedAt > 0
      ? input.meta.updatedAt * 1000
      : input.dataUpdatedAt;
}

/** First integer millisecond beyond each effective health budget (comparisons are inclusive). */
export function getDataHealthBoundaries(input: QueryHealthInput): number[] {
  const updatedAt = getUpdatedAtMs(input);
  if (!(input.hasData ?? input.dataUpdatedAt > 0) || !(updatedAt > 0)) return [];
  const freshBudget = getFreshBudgetMs(input.staleTime, input.meta);
  const boundaries = [updatedAt + freshBudget, updatedAt + getDegradedBudgetMs(input.staleTime, input.meta)];
  if (input.catchUp) {
    boundaries.push(input.catchUp.observedAt * 1000 + freshBudget);
    for (const source of input.catchUp.sources) {
      if (source.lastSucceededAt != null) boundaries.push(source.lastSucceededAt * 1000 + freshBudget);
    }
  }
  return boundaries.filter(Number.isFinite).map((boundary) => Math.floor(boundary) + 1);
}

function pickBaseState(
  ageMs: number | null,
  staleTime: number,
  meta: ApiMeta | null | undefined,
): Exclude<DataHealthState, "error"> {
  if (ageMs === null) return "unavailable";
  const freshBudgetMs = getFreshBudgetMs(staleTime, meta);
  const degradedBudgetMs = getDegradedBudgetMs(staleTime, meta);
  if (ageMs <= freshBudgetMs) return "fresh";
  if (ageMs <= degradedBudgetMs) return "degraded";
  return "stale";
}

function hasServerDegradation(meta: ApiMeta | null | undefined): boolean {
  if (meta?.warning) return true;
  return Object.values(meta?.dependencies ?? {}).some((dependency) => dependency.status !== "fresh");
}

function getBaseMessage(state: Exclude<DataHealthState, "error">): string {
  if (state === "unavailable") return "Data is not yet available.";
  if (state === "fresh") return "Data is fresh.";
  if (state === "degraded") return "Data is delayed or from a degraded source.";
  return "Data is stale.";
}

export function deriveDataHealth(input: QueryHealthInput, nowMs = Date.now()): DataHealthInfo {
  const hasData = input.hasData ?? input.dataUpdatedAt > 0;
  const authorityUnavailable = input.meta?.updatedAt === null;
  const updatedAtMs = getUpdatedAtMs(input);
  const ageMs = updatedAtMs > 0 ? Math.max(0, nowMs - updatedAtMs) : null;
  const classifiedState = authorityUnavailable
    ? input.meta?.status === "stale" ? "stale" : "unavailable"
    : pickBaseState(ageMs, input.staleTime, input.meta);
  const serverFloor = input.meta?.status === "stale"
    ? "stale"
    : input.meta?.status === "degraded" || hasServerDegradation(input.meta)
      ? "degraded"
      : null;
  const baseState = authorityUnavailable || serverFloor === null
    ? classifiedState
    : classifiedState === "unavailable" || STATE_PRIORITY[classifiedState] < STATE_PRIORITY[serverFloor]
      ? serverFloor
      : classifiedState;

  let state: DataHealthState = baseState;
  let message = getBaseMessage(baseState);
  let degradationReason: DataHealthInfo["degradationReason"];
  if (input.error && !hasData) {
    state = isUnavailableError(input.error) ? "unavailable" : "error";
    message = state === "unavailable" ? "Data is not yet available." : "Failed to load data.";
  } else if (hasData && (
    input.error || input.meta?.warning?.includes("Latest sync-dex-liquidity run failed; serving last successful dataset")
  )) {
    // A successful API read can still report a failed producer refresh.
    state = baseState === "fresh" ? "degraded" : baseState;
    message = "Using last successful data while refresh retries.";
    degradationReason = "refresh";
  } else if (!hasData) {
    state = "unavailable";
    message = "Data is not yet available.";
  } else if (baseState === "degraded") {
    degradationReason = classifiedState === "degraded" || input.meta?.warning?.startsWith("110 ")
      ? "age"
      : "source";
  }

  // An aged coverage clock is not a stalled producer when the totals were rebuilt within budget
  // and the producer names the sources still catching up.
  let catchUp: DataHealthInfo["catchUp"];
  const ageOnly = classifiedState !== "fresh" && classifiedState !== "unavailable"
    && (!input.meta?.warning || input.meta.warning.startsWith("110 "))
    && Object.values(input.meta?.dependencies ?? {}).every((dependency) => dependency.status === "fresh");
  if (input.catchUp && hasData && !input.error && ageOnly) {
    const freshBudgetMs = getFreshBudgetMs(input.staleTime, input.meta);
    const observedAtMs = input.catchUp.observedAt * 1000;
    const laggingLabels = input.catchUp.sources
      .filter((source) => source.lastSucceededAt == null || nowMs - source.lastSucceededAt * 1000 > freshBudgetMs)
      .map((source) => source.label);
    if (nowMs - observedAtMs <= freshBudgetMs && laggingLabels.length > 0) {
      state = "degraded";
      message = "Totals are current; some sources are still catching up.";
      degradationReason = "catch-up";
      catchUp = { observedAtMs, laggingLabels };
    }
  }

  const result: DataHealthInfo = {
    label: input.label,
    state,
    message,
    dataUpdatedAt: updatedAtMs,
    ageMs,
    staleTime: input.staleTime,
    meta: input.meta ?? null,
  };
  if (degradationReason != null) result.degradationReason = degradationReason;
  if (catchUp) result.catchUp = catchUp;
  return result;
}

/**
 * The one public-visibility authority: readers see a warning only when data is past the stale
 * band or missing with nothing retained. `degraded` (source advisories, failed refreshes over
 * saved data, catch-up, mild lateness) is operator signal, routed to Telegram and /status.
 */
export function isPublicWarning(entry: DataHealthInfo): boolean {
  return entry.state === "stale" || entry.state === "unavailable" || entry.state === "error";
}

export function mergeHealthStates(entries: DataHealthInfo[]): MergedDataHealth {
  if (entries.length === 0) {
    return { state: "fresh", affectedLabels: [], latestUpdatedAt: null };
  }

  let state: DataHealthState = "fresh";
  let latestUpdatedAt: number | null = null;
  let latestAffectedUpdatedAt: number | null = null;
  const affectedLabels: string[] = [];

  for (const entry of entries) {
    if (STATE_PRIORITY[entry.state] > STATE_PRIORITY[state]) {
      state = entry.state;
    }
    if (entry.state !== "fresh") {
      affectedLabels.push(entry.label);
      if (
        entry.dataUpdatedAt > 0
        && (latestAffectedUpdatedAt === null || entry.dataUpdatedAt > latestAffectedUpdatedAt)
      ) {
        latestAffectedUpdatedAt = entry.dataUpdatedAt;
      }
    }
    if (entry.dataUpdatedAt > 0 && (latestUpdatedAt === null || entry.dataUpdatedAt > latestUpdatedAt)) {
      latestUpdatedAt = entry.dataUpdatedAt;
    }
  }

  return {
    state,
    affectedLabels,
    latestUpdatedAt: state === "fresh" ? latestUpdatedAt : latestAffectedUpdatedAt,
  };
}

export function formatDataHealthTimestamp(
  timestampMs: number | null,
  locale?: Intl.LocalesArgument,
  timeZone?: string,
): string {
  if (!timestampMs || timestampMs <= 0) return "never";
  return new Date(timestampMs).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  });
}
