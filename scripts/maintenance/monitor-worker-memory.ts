import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { SCHEDULED_SLOT_PLANS_BY_SCHEDULE, SCHEDULED_TASK_DESCRIPTORS } from "../../shared/lib/scheduled-runner-registry";
import { getCronSlotStartedAtForTrigger } from "../../shared/lib/cron-jobs";
import { assertCliUsage, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { parseAssignments } from "../lib/wrangler-toml.mjs";
import { buildScheduledInvocationQuery } from "./cron-delivery.mjs";

export const WORKER_MEMORY_TELEMETRY_POLICY = {
  schemaVersion: 1, scheduleIntervalSec: 3600, ingestionLagAllowanceSec: 900,
  maxCoverageLagSec: 8100, alertWindowSec: 86400,
  initialSliceSec: 21600, minSliceSec: 1, queryRowLimit: 10000, maxRequests: 240,
  collectionDeadlineSec: 360, requestTimeoutSec: 30, minRequestSpacingMs: 1000,
  cpuMatchToleranceUsExclusive: 2,
} as const;
/** Cloudflare's Cron CPU-class ceilings; the configured Worker cpu_ms can only lower them. */
const PLATFORM_CPU_CLASS_LIMIT_US = { "sub-hourly": 30_000_000, "hourly-or-longer": 900_000_000 } as const;
const WORKER_CPU_LIMIT_CONFIGS = ["../../worker/wrangler.toml", "../../worker/wrangler.heavy.toml"] as const;
function readConfiguredCpuLimitUs(): number {
  return Math.min(...WORKER_CPU_LIMIT_CONFIGS.map((path) => {
    const url = new URL(path, import.meta.url);
    const raw = parseAssignments(readFileSync(url, "utf8"))
      .find((assignment) => assignment.section === "limits" && assignment.key === "cpu_ms")?.value;
    if (!raw || !/^\d+$/.test(raw)) throw new Error(`Missing numeric [limits] cpu_ms in ${url.pathname}.`);
    return Number(raw) * 1000;
  }));
}
const configuredCpuLimitUs = readConfiguredCpuLimitUs();
/**
 * One authority for resource limits and the headroom threshold. CPU classes are
 * Cloudflare's Cron ceilings (30 s below a one-hour interval, 15 min
 * hourly-or-longer; docs/worker-and-api-limits.md#per-job-resource-evidence),
 * bounded by the lower configured `[limits] cpu_ms`; the isolate memory limit
 * is 128 MiB per isolate.
 */
export const WORKER_CAPACITY_POLICY = {
  warnRatio: 0.70,
  minSamples: 20,
  cpuLimitUs: {
    "sub-hourly": Math.min(PLATFORM_CPU_CLASS_LIMIT_US["sub-hourly"], configuredCpuLimitUs),
    "hourly-or-longer": Math.min(PLATFORM_CPU_CLASS_LIMIT_US["hourly-or-longer"], configuredCpuLimitUs),
  },
  memoryLimitBytes: 128 * 1048576,
} as const;
const TARGETS = { heavy: "stablecoin-heavy", public: "stablecoin-api" } as const;
type Role = keyof typeof TARGETS;
type Kind = "kills" | "scheduled" | "samples" | "role-day";
const numeric = z.number().finite().nonnegative();
const metric = numeric.nullish().transform((value) => value ?? null);
const timestamp = z.string().refine((value) => {
  const timezoneStart = value.endsWith("Z") ? value.length - 1 : value.length - 6;
  const timezone = value.slice(timezoneStart);
  const clock = value.slice(0, timezoneStart);
  const fraction = clock.slice(19);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(clock.slice(0, 19))
    && (timezone === "Z" || /^[+-]\d{2}:\d{2}$/.test(timezone))
    && (fraction === "" || (fraction.startsWith(".") && /^\d+$/.test(fraction.slice(1))))
    && Number.isFinite(Date.parse(value));
});
const metricsSchema = z.object({
  cpuTimeP50: metric, durationP50: metric, memoryUsageBytesP50: metric,
  memoryUsageBytesP90: metric, memoryUsageBytesP99: metric, memoryUsageBytesP999: metric,
});
const adaptiveSchema = z.object({
  dimensions: z.object({ datetime: timestamp.optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), scriptName: z.string(), scriptVersion: z.string().optional(), coloCode: z.string().min(1).optional(), status: z.string() }),
  sum: z.object({ requests: numeric, subrequests: metric }),
  avg: z.object({ sampleInterval: metric }).nullish().transform((value) => value ?? { sampleInterval: null }),
  quantiles: metricsSchema,
});
const scheduledSchema = z.object({ datetime: timestamp, scheduledDatetime: timestamp, cron: z.string(), status: z.string(), cpuTimeUs: numeric });
const observationEnvelopeSchema = z.object({
  generatedAt: timestamp, window: z.object({ from: timestamp, to: timestamp, mode: z.enum(["default", "explicit"]) }),
  sources: z.array(z.object({ workerRole: z.enum(["heavy", "public"]), kind: z.enum(["kills", "scheduled", "samples", "role-day"]), from: timestamp, to: timestamp, queryComplete: z.boolean(), failures: z.array(z.object({ from: timestamp, to: timestamp, reason: z.string() })) })),
});
type AdaptiveRow = z.infer<typeof adaptiveSchema>;
type ScheduledRow = z.infer<typeof scheduledSchema>;
type Failure = { from: string; to: string; reason: string };
type QueryRecord = {
  id: string; kind: Kind; scriptName: string; dataset: string; query: string;
  variables: { a: string; s: string; f: string; t: string }; startedAt: string; finishedAt: string;
  returnedRows: number | null; result: "available" | "split" | "unavailable"; reason: string | null;
  samplingIntervalUnknownRows: number | null; samplingIntervalRange: [number, number] | null;
};
type SourceRead = {
  id: string; kind: Kind; workerRole: Role; scriptName: string; dataset: string;
  from: string; to: string; fetchedAt: string; status: "available" | "partial" | "unavailable";
  queryComplete: boolean; samplingBasis: "adaptive" | "scheduled-dataset";
  returnedRows: number | null; knownReturnedRows: number; failures: Failure[];
  samplingIntervalUnknownRows: number; samplingIntervalRange: [number, number] | null;
};
type Lane = {
  cron: string; scheduledDatetime: string; scheduleKey: string; slotStartedAt: number;
  mappingBasis: "collector-registry"; candidateJobChains: readonly (readonly string[])[];
  budgetOnlyJobs: readonly string[];
  expectedJob: string | null; jobBasis: "registry-plan"; executionConfirmed: false;
};
type JoinedRow = {
  workerRole: Role; scriptName: string; adaptive: AdaptiveRow; groupKey: string;
  adaptiveStatus: string; scheduledStatus: string | null; correlation: string; reason: string | null;
  candidates: ScheduledRow[]; lane: Lane | null; cpuDeltaUs: number | null;
  matchingBasis: "same-script-exact-second-cpu-difference-under-2us";
  sourceSha: string | null; registrySourceSha: string | null;
};
type LaneDay = {
  dayUtc: string; windowFrom: string; windowTo: string; scriptName: string; workerRole: Role;
  cron: string | null; scheduleKey: string; status: string; scriptVersion: string | null;
  coloCode: string | null;
  rollup: "physical" | "logical"; queryComplete: boolean; reason: string | null;
  eligibleRows: number; matchedRows: number; memoryMeasuredRows: number; memoryUnavailableRows: number;
  groupedRows: number; ambiguousRows: number; unmatchedRows: number;
  samplingIntervalUnknownRows: number; samplingIntervalRange: [number, number] | null;
  basis: "empirical-nearest-rank-of-matched-row-memoryUsageBytesP50";
  sampledRowMemoryP50DistributionBytes: { p50: number; p90: number; p99: number; p999: number } | null;
};
type CapacityStatus = "ok" | "warn" | "unavailable" | "insufficient-samples";
type CapacityTrigger = {
  workerRole: Role; cron: string; cpuClass: keyof typeof WORKER_CAPACITY_POLICY.cpuLimitUs | null;
  limitUs: number | null; samples: number; p50Us: number | null; p99Us: number | null; maxUs: number | null;
  exceededCpu: number; p99Ratio: number | null; status: CapacityStatus; reason: string | null;
};
type CapacityMemory = {
  workerRole: Role; basis: "max-of-cloudflare-sampled-role-day-p99"; limitBytes: number;
  days: { dayUtc: string; from: string; to: string; status: string; requests: number; p99Bytes: number }[];
  p99Bytes: number | null; p99Ratio: number | null; status: CapacityStatus; reason: string | null;
};
type CapacityHeadroom = {
  status: Exclude<CapacityStatus, "insufficient-samples">; warnRatio: number; minSamples: number;
  limits: { cpuUs: typeof WORKER_CAPACITY_POLICY.cpuLimitUs; memoryBytes: number };
  triggers: CapacityTrigger[]; memory: CapacityMemory[]; reasons: string[];
};
type Verdict = {
  status: "no-observed-kills" | "observed-kills" | "unavailable"; reasons: string[];
  alertFrom: string; alertTo: string; heavyKillObserved: boolean; collectionIncomplete: boolean; freshnessFailed: boolean;
  observedHeavyRequests: number | null; observedPublicRequests: number | null;
  knownHeavyRequests: number; knownPublicRequests: number; exitCode: 0 | 1;
};
type WorkerMemoryReport = {
  schemaVersion: 1; reportId: string; generatedAt: string; sourceSha: string | null; runIdentity: string;
  targets: typeof TARGETS; policy: typeof WORKER_MEMORY_TELEMETRY_POLICY;
  window: { from: string; to: string; fromInclusive: true; toExclusive: true; mode: "default" | "explicit" };
  freshness: { status: "fresh" | "stale"; coverageLagSec: number; generationId: string; reason: string | null };
  sources: SourceRead[]; roleDays: { workerRole: Role; from: string; to: string; basis: "Cloudflare-sampled-role-day-quantiles"; queryComplete: boolean; rows: AdaptiveRow[] }[];
  laneDays: LaneDay[]; laneDescriptors: Record<string, (typeof SCHEDULED_TASK_DESCRIPTORS)[number][]>; samples: JoinedRow[];
  sampleCorrelations: { workerRole: Role; correlation: string; returnedRows: number }[];
  exceededMemory: { groups: JoinedRow[]; complete: boolean; returnedGroups: number | null; reportedRequests: number | null; knownReturnedGroups: number; knownReportedRequests: number; reasons: string[] };
  capacity: CapacityHeadroom;
  queries: QueryRecord[]; verdict: Verdict; caveats: string[]; outputFiles: string[];
};
const USAGE = `Usage: npm run ops:worker-memory -- [--from <ISO timestamp> --to <ISO timestamp>] [--out-dir <path>]
Reads sampled Cloudflare Worker isolate memory and independently filtered exceededMemory outcomes; no production mutations.
Requires CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN (Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID in the environment.
Windows require timezone-qualified timestamps, at most 48 hours. Default: previous UTC day plus today, with 900s ingestion lag.
Writes report.json, report.md, capacity.md, samples.ndjson, exceeded-memory.ndjson, queries.json under agents/worker-memory/<run>/.
Exits: 0 complete/no alert, 1 heavy kill, unavailable required evidence or stale default coverage (after writing evidence), 2 invalid usage. -h/--help: help.`;

export function resolveWorkerMemoryWindow(from: string | undefined, to: string | undefined, now = new Date()) {
  assertCliUsage(Boolean(from) === Boolean(to), "--from and --to must be supplied together");
  const end = to ? Date.parse(to) : Math.floor((now.getTime() - WORKER_MEMORY_TELEMETRY_POLICY.ingestionLagAllowanceSec * 1000) / 1000) * 1000;
  const start = from ? Date.parse(from) : Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), new Date(end).getUTCDate() - 1);
  assertCliUsage(!from || timestamp.safeParse(from).success, "--from must be a timezone-qualified ISO timestamp");
  assertCliUsage(!to || timestamp.safeParse(to).success, "--to must be a timezone-qualified ISO timestamp");
  assertCliUsage(Number.isFinite(start) && Number.isFinite(end) && start < end && end <= now.getTime(), "Window must be increasing and not in the future");
  assertCliUsage(end - start <= 48 * 3600_000, "Window must not exceed 48 hours");
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}
export function parseWorkerMemoryArgs(argv: string[], now = new Date()) {
  const { values } = parseStrictCliArgs(argv, { options: { from: { type: "string" }, to: { type: "string" }, "out-dir": { type: "string" } } });
  if (values.help) return { help: true as const };
  const from = values.from as string | undefined;
  const to = values.to as string | undefined;
  resolveWorkerMemoryWindow(from, to, now);
  return { help: false as const, from, to, outDir: values["out-dir"] as string | undefined };
}
function adaptiveQuery(kind: Exclude<Kind, "scheduled">) {
  // coloCode is requested only for event-grouped Adaptive reads; it splits a
  // group by serving location. The role-day read keeps Cloudflare's date-level
  // quantile rollup so it remains comparable with retained artifacts.
  return `query($a:String!,$f:Time!,$t:Time!,$s:String!){viewer{accounts(filter:{accountTag:$a}){
    workersInvocationsAdaptive(limit:${WORKER_MEMORY_TELEMETRY_POLICY.queryRowLimit},filter:{scriptName:$s,datetime_geq:$f,datetime_lt:$t${kind === "kills" ? ',status:"exceededMemory"' : ""}},orderBy:[${kind === "role-day" ? "date" : "datetime"}_ASC]){
      dimensions{${kind === "role-day" ? "date" : "datetime scriptVersion coloCode"} scriptName status}
      sum{requests subrequests} avg{sampleInterval}
      quantiles{cpuTimeP50 durationP50 memoryUsageBytesP50 memoryUsageBytesP90 memoryUsageBytesP99 memoryUsageBytesP999}
    }}}}`;
}
function intervalRange(rows: AdaptiveRow[]) {
  let minimum: number | null = null;
  let maximum: number | null = null;
  for (const row of rows) {
    const interval = row.avg.sampleInterval;
    if (interval === null) continue;
    minimum = minimum === null ? interval : Math.min(minimum, interval);
    maximum = maximum === null ? interval : Math.max(maximum, interval);
  }
  return minimum === null || maximum === null ? null : [minimum, maximum] as [number, number];
}
function windows(from: string, to: string, stepMs: number, utcDay = false) {
  const result: { from: string; to: string }[] = [];
  const end = Date.parse(to);
  for (let start = Date.parse(from); start < end;) {
    const next = Math.min(end, utcDay ? Math.floor(start / 86400_000) * 86400_000 + 86400_000 : start + stepMs);
    result.push({ from: new Date(start).toISOString(), to: new Date(next).toISOString() });
    start = next;
  }
  return result;
}

export function joinScheduledMemory(adaptiveRows: AdaptiveRow[], scheduledRows: ScheduledRow[], role: Role, scheduledAvailable = true, sourceSha: string | null = null): JoinedRow[] {
  const bySecond = new Map<number, ScheduledRow[]>();
  for (const row of scheduledRows) {
    const second = Math.floor(Date.parse(row.datetime) / 1000);
    const bucket = bySecond.get(second) ?? [];
    bucket.push(row);
    bySecond.set(second, bucket);
  }
  const matches = adaptiveRows.map((row) => row.dimensions.scriptName !== TARGETS[role] || row.quantiles.cpuTimeP50 === null ? []
    : (bySecond.get(Math.floor(Date.parse(row.dimensions.datetime!) / 1000)) ?? []).filter((candidate) => Math.abs(candidate.cpuTimeUs - row.quantiles.cpuTimeP50!) < WORKER_MEMORY_TELEMETRY_POLICY.cpuMatchToleranceUsExclusive));
  const reverse = new Map<ScheduledRow, number>();
  for (const candidates of matches) for (const row of candidates) reverse.set(row, (reverse.get(row) ?? 0) + 1);
  return adaptiveRows.map((row, index) => {
    const candidates = matches[index]!;
    let correlation = !scheduledAvailable ? "scheduled-unavailable" : row.sum.requests !== 1 || row.avg.sampleInterval !== 1 ? "grouped"
      : candidates.length === 0 ? "unmatched" : candidates.length !== 1 || reverse.get(candidates[0]!) !== 1 ? "ambiguous" : "unique-singleton";
    let lane: Lane | null = null;
    const scheduled = correlation === "unique-singleton" ? candidates[0]! : null;
    if (scheduled) {
      const plan = SCHEDULED_SLOT_PLANS_BY_SCHEDULE[scheduled.cron];
      if (!plan) correlation = "registry-unmapped";
      else if (plan.worker !== role) correlation = "registry-owner-mismatch";
      else lane = {
        cron: scheduled.cron, scheduledDatetime: scheduled.scheduledDatetime, scheduleKey: plan.scheduleKey,
        slotStartedAt: getCronSlotStartedAtForTrigger(plan.scheduleKey, scheduled.cron, Date.parse(scheduled.scheduledDatetime)),
        mappingBasis: "collector-registry", candidateJobChains: plan.jobChains,
        budgetOnlyJobs: plan.budgetOnlyJobs ?? [], expectedJob: plan.jobChains.length === 1 && plan.jobChains[0]?.length === 1 ? plan.jobChains[0][0]! : null,
        jobBasis: "registry-plan", executionConfirmed: false,
      };
    }
    return {
      workerRole: role, scriptName: row.dimensions.scriptName, adaptive: row,
      groupKey: JSON.stringify([row.dimensions.scriptName, row.dimensions.scriptVersion ?? null, row.dimensions.datetime, row.dimensions.status, row.dimensions.coloCode ?? null]),
      adaptiveStatus: row.dimensions.status, scheduledStatus: scheduled?.status ?? null, correlation,
      reason: correlation === "unique-singleton" ? null : correlation === "grouped" ? "requests-or-sampling-not-singleton" : correlation === "unmatched" && role === "public" ? "unattributed-public-invocation" : correlation,
      candidates, lane, cpuDeltaUs: scheduled && row.quantiles.cpuTimeP50 !== null ? Math.abs(scheduled.cpuTimeUs - row.quantiles.cpuTimeP50) : null,
      matchingBasis: "same-script-exact-second-cpu-difference-under-2us", sourceSha, registrySourceSha: sourceSha,
    };
  });
}

export function buildDailyLaneSamples(samples: JoinedRow[], scheduled: { role: Role; rows: ScheduledRow[] }[], sources: SourceRead[], from: string, to: string): LaneDay[] {
  const groups = new Map<string, { seed: Omit<LaneDay, "eligibleRows" | "matchedRows" | "memoryMeasuredRows" | "memoryUnavailableRows" | "groupedRows" | "ambiguousRows" | "unmatchedRows" | "samplingIntervalUnknownRows" | "samplingIntervalRange" | "sampledRowMemoryP50DistributionBytes">; rows: JoinedRow[] }>();
  function add(role: Role, day: string, cron: string, scheduleKey: string, status: string, version: string | null, colo: string | null, row?: JoinedRow) {
    for (const rollup of ["physical", "logical"] as const) {
      const key = JSON.stringify([role, day, rollup === "physical" ? cron : null, scheduleKey, status, version, colo]);
      let group = groups.get(key);
      if (!group) {
        const start = new Date(Math.max(Date.parse(from), Date.parse(`${day}T00:00:00Z`))).toISOString();
        const end = new Date(Math.min(Date.parse(to), Date.parse(`${day}T00:00:00Z`) + 86400_000)).toISOString();
        const complete = sources.filter((source) => source.workerRole === role && ["samples", "scheduled"].includes(source.kind)).every((source) => !source.failures.some((failure) => failure.from < end && failure.to > start));
        group = { seed: { dayUtc: day, windowFrom: start, windowTo: end, scriptName: TARGETS[role], workerRole: role, cron: rollup === "physical" ? cron : null, scheduleKey, status, scriptVersion: version, coloCode: colo, rollup, queryComplete: complete, reason: null, basis: "empirical-nearest-rank-of-matched-row-memoryUsageBytesP50" }, rows: [] };
        groups.set(key, group);
      }
      if (row) group.rows.push(row);
    }
  }
  for (const row of samples) {
    const lanes = row.lane ? [{ cron: row.lane.cron, scheduleKey: row.lane.scheduleKey }] : [...new Map(row.candidates.flatMap((candidate) => {
      const plan = SCHEDULED_SLOT_PLANS_BY_SCHEDULE[candidate.cron];
      return plan?.worker === row.workerRole ? [[candidate.cron, { cron: candidate.cron, scheduleKey: plan.scheduleKey }] as const] : [];
    })).values()];
    for (const lane of lanes) add(row.workerRole, row.adaptive.dimensions.datetime!.slice(0, 10), lane.cron, lane.scheduleKey, row.adaptiveStatus, row.adaptive.dimensions.scriptVersion ?? null, row.adaptive.dimensions.coloCode ?? null, row);
  }
  for (const source of scheduled) for (const row of source.rows) {
    const plan = SCHEDULED_SLOT_PLANS_BY_SCHEDULE[row.cron];
    if (!plan || plan.worker !== source.role) continue;
    const day = row.datetime.slice(0, 10);
    if (![...groups.values()].some((group) => group.seed.workerRole === source.role && group.seed.dayUtc === day && group.seed.cron === row.cron)) add(source.role, day, row.cron, plan.scheduleKey, "no-usable-memory-observations", null, null);
  }
  return [...groups.values()].map(({ seed, rows }) => {
    const eligible = rows.filter((row) => row.correlation === "unique-singleton" && row.lane !== null);
    const values = eligible.flatMap((row) => row.adaptive.quantiles.memoryUsageBytesP50 === null ? [] : [row.adaptive.quantiles.memoryUsageBytesP50]).sort((a, b) => a - b);
    const quantile = (q: number) => values[Math.ceil(q * values.length) - 1]!;
    return { ...seed, reason: !seed.queryComplete ? "source-window-incomplete" : values.length ? null : "memory-metric-unavailable",
      eligibleRows: eligible.length, matchedRows: eligible.length, memoryMeasuredRows: values.length, memoryUnavailableRows: eligible.length - values.length,
      groupedRows: rows.filter((row) => row.correlation === "grouped").length,
      ambiguousRows: rows.filter((row) => row.correlation === "ambiguous").length,
      unmatchedRows: rows.filter((row) => row.correlation === "unmatched" || row.correlation === "scheduled-unavailable").length,
      samplingIntervalUnknownRows: rows.filter((row) => row.adaptive.avg.sampleInterval === null).length,
      samplingIntervalRange: intervalRange(rows.map((row) => row.adaptive)),
      sampledRowMemoryP50DistributionBytes: seed.queryComplete && values.length ? { p50: quantile(0.5), p90: quantile(0.9), p99: quantile(0.99), p999: quantile(0.999) } : null,
    };
  });
}

function expandCronField(field: string, size: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, rawStep, ...rest] = part.split("/");
    if (rest.length || range === undefined) return null;
    const step = rawStep === undefined ? 1 : /^\d+$/.test(rawStep) ? Number(rawStep) : 0;
    if (step < 1) return null;
    const bounds = range === "*" ? ["0", String(size - 1)] : range.split("-");
    if (bounds.length > 2 || !bounds.every((bound) => /^\d+$/.test(bound))) return null;
    const from = Number(bounds[0]);
    const to = bounds.length === 2 ? Number(bounds[1]) : rawStep === undefined ? from : null;
    if (to === null || from > to || to >= size) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size ? [...values].sort((a, b) => a - b) : null;
}

/**
 * Cloudflare gives Cron expressions with intervals below one hour the 30-second
 * CPU class and hourly-or-longer expressions the 15-minute class. Only the
 * minute/hour fields set that interval; day/month/weekday restrictions can only
 * lengthen it, so this class is conservative (never under-reports headroom use).
 */
export function classifyCronCpuClass(expression: string): keyof typeof WORKER_CAPACITY_POLICY.cpuLimitUs | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = expandCronField(fields[0]!, 60);
  const hours = expandCronField(fields[1]!, 24);
  if (!minutes || !hours) return null;
  const firings = [...new Set(hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute)))].sort((a, b) => a - b);
  const gaps = firings.map((value, index) => index === 0 ? value + 1440 - firings[firings.length - 1]! : value - firings[index - 1]!);
  return Math.min(...gaps) < 60 ? "sub-hourly" : "hourly-or-longer";
}

function nearestRank(sorted: readonly number[], q: number) {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

/**
 * Per-trigger CPU headroom from the already-fetched `workersInvocationsScheduled`
 * rows and per-script memory headroom from the sampled role/day
 * `memoryUsageBytesP99` quantiles. Percentiles are nearest rank within one cron
 * trigger; memory keeps Cloudflare's day-level quantiles instead of pooling them
 * into a percentile-of-percentiles. Partial sources stay `unavailable`, never `ok`.
 */
export function buildCapacityHeadroom(input: {
  roleDays: WorkerMemoryReport["roleDays"];
  scheduled: { workerRole: Role; rows: ScheduledRow[]; complete: boolean }[];
}): CapacityHeadroom {
  const policy = WORKER_CAPACITY_POLICY;
  const triggers: CapacityTrigger[] = [];
  for (const source of input.scheduled) {
    const byCron = new Map<string, ScheduledRow[]>();
    for (const row of source.rows) {
      const bucket = byCron.get(row.cron);
      if (bucket) bucket.push(row);
      else byCron.set(row.cron, [row]);
    }
    if (!byCron.size) {
      triggers.push({ workerRole: source.workerRole, cron: "", cpuClass: null, limitUs: null, samples: 0, p50Us: null, p99Us: null, maxUs: null, exceededCpu: 0, p99Ratio: null, status: "unavailable", reason: source.complete ? "scheduled-rows-absent" : "scheduled-source-incomplete" });
      continue;
    }
    for (const [cron, rows] of [...byCron].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = rows.map((row) => row.cpuTimeUs).sort((a, b) => a - b);
      const cpuClass = classifyCronCpuClass(cron);
      const limitUs = cpuClass === null ? null : policy.cpuLimitUs[cpuClass];
      const p99Us = nearestRank(sorted, 0.99);
      const p99Ratio = limitUs === null ? null : p99Us / limitUs;
      const exceededCpu = rows.filter((row) => row.status === "exceededCpu").length;
      const status: CapacityStatus = !source.complete || limitUs === null ? "unavailable"
        : exceededCpu > 0 ? "warn"
          : sorted.length < policy.minSamples ? "insufficient-samples"
            : p99Ratio! > policy.warnRatio ? "warn" : "ok";
      triggers.push({ workerRole: source.workerRole, cron, cpuClass, limitUs, samples: sorted.length,
        p50Us: nearestRank(sorted, 0.5), p99Us, maxUs: sorted[sorted.length - 1]!, exceededCpu, p99Ratio, status,
        reason: status === "warn" ? (exceededCpu > 0 ? "cpu-exceeded-cpu-observed" : "cpu-p99-over-warn-threshold")
          : status === "unavailable" ? (source.complete ? "cpu-class-unknown" : "scheduled-source-incomplete")
            : status === "insufficient-samples" ? "insufficient-samples" : null });
    }
  }
  const memory: CapacityMemory[] = (["heavy", "public"] as const).map((workerRole) => {
    const roleDays = input.roleDays.filter((day) => day.workerRole === workerRole);
    const incomplete = roleDays.some((day) => !day.queryComplete);
    const days = roleDays.filter((day) => day.queryComplete)
      .flatMap((day) => day.rows.flatMap((row) => row.quantiles.memoryUsageBytesP99 === null ? [] : [{
        dayUtc: day.from.slice(0, 10), from: day.from, to: day.to, status: row.dimensions.status, requests: row.sum.requests, p99Bytes: row.quantiles.memoryUsageBytesP99,
      }]));
    const p99Bytes = days.length ? Math.max(...days.map((day) => day.p99Bytes)) : null;
    const p99Ratio = p99Bytes === null ? null : p99Bytes / policy.memoryLimitBytes;
    const warn = p99Ratio !== null && p99Ratio > policy.warnRatio;
    return { workerRole, basis: "max-of-cloudflare-sampled-role-day-p99", limitBytes: policy.memoryLimitBytes, days, p99Bytes, p99Ratio,
      status: warn ? "warn" : incomplete || p99Bytes === null ? "unavailable" : "ok",
      reason: warn ? "memory-p99-over-warn-threshold" : incomplete ? "role-day-source-incomplete" : p99Bytes === null ? "memory-p99-unavailable" : null };
  });
  const rows = [...triggers, ...memory];
  return { status: rows.some((row) => row.status === "warn") ? "warn" : rows.some((row) => row.status !== "ok") ? "unavailable" : "ok",
    warnRatio: policy.warnRatio, minSamples: policy.minSamples, limits: { cpuUs: policy.cpuLimitUs, memoryBytes: policy.memoryLimitBytes },
    triggers, memory, reasons: [...new Set(rows.flatMap((row) => row.reason === null ? [] : [row.reason]))] };
}

function markdownCell(value: string) {
  return value.replace(/[|<>`\r\n]/g, " ");
}

export function renderCapacityMarkdown(capacity: CapacityHeadroom, window: WorkerMemoryReport["window"]) {
  const seconds = (us: number | null) => us === null ? "unavailable" : (us / 1e6).toFixed(2);
  const mib = (bytes: number | null) => bytes === null ? "unavailable" : (bytes / 1048576).toFixed(2);
  const ratio = (value: number | null) => value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
  const lines = ["## Worker capacity headroom", "",
    `Verdict: **${capacity.status}**. Warn above ${(capacity.warnRatio * 100).toFixed(0)}% of a platform limit with at least ${capacity.minSamples} samples, or on any \`exceededCpu\` outcome; effective CPU limits are ${Math.round(capacity.limits.cpuUs["sub-hourly"] / 1e6)} s below a one-hour interval and ${Math.round(capacity.limits.cpuUs["hourly-or-longer"] / 1e6)} s hourly-or-longer (Cloudflare classes bounded by configured \`cpu_ms\`); the isolate memory limit is 128 MiB.`,
    `Window (${window.mode}): ${window.from} ≤ scheduled invocation < ${window.to}. Triggers below ${capacity.minSamples} samples report their observed values without a headroom verdict.`,
    `Reasons: ${capacity.reasons.join(", ") || "none"}.`, "",
    "| Role | Cron trigger | CPU class | N | p50 s | p99 s | Max s | Limit s | p99 / limit | exceededCpu | Verdict |",
    "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const row of capacity.triggers) lines.push(`| ${row.workerRole} | ${markdownCell(row.cron || "all triggers")} | ${row.cpuClass ?? "unknown"} | ${row.samples} | ${seconds(row.p50Us)} | ${seconds(row.p99Us)} | ${seconds(row.maxUs)} | ${seconds(row.limitUs)} | ${ratio(row.p99Ratio)} | ${row.exceededCpu} | ${row.status}${row.reason ? ` (${row.reason})` : ""} |`);
  lines.push("", "Memory basis: the highest Cloudflare sampled role/day `memoryUsageBytesP99` per script, never a pooled percentile. Sampled isolate memory is shared across concurrent invocations, not a phase high-water mark or a headroom measurement.", "",
    "| Role | Sampled days | Worst day | Outcome | Requests | p99 MiB | Limit MiB | p99 / limit | Verdict |", "|---|---|---|---|---|---|---|---|---|");
  for (const row of capacity.memory) {
    const worst = row.days.length ? row.days.reduce((a, b) => b.p99Bytes > a.p99Bytes ? b : a) : null;
    lines.push(`| ${row.workerRole} | ${row.days.length} | ${worst?.dayUtc ?? "unavailable"} | ${markdownCell(worst?.status ?? "unavailable")} | ${worst?.requests ?? "unavailable"} | ${mib(row.p99Bytes)} | ${mib(row.limitBytes)} | ${ratio(row.p99Ratio)} | ${row.status}${row.reason ? ` (${row.reason})` : ""} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function evaluateMemoryObservation(report: Pick<WorkerMemoryReport, "generatedAt" | "window" | "sources" | "exceededMemory">, now = new Date()): Verdict {
  observationEnvelopeSchema.parse(report);
  const end = Date.parse(report.window.to);
  const start = end - WORKER_MEMORY_TELEMETRY_POLICY.alertWindowSec * 1000;
  const kills = report.exceededMemory.groups.filter((row) => Date.parse(row.adaptive.dimensions.datetime!) >= start && Date.parse(row.adaptive.dimensions.datetime!) < end);
  const known = (role: Role) => kills.filter((row) => row.workerRole === role).reduce((sum, row) => sum + row.adaptive.sum.requests, 0);
  const complete = (role: Role) => report.sources.some((source) => source.workerRole === role && source.kind === "kills") && report.sources.filter((source) => source.workerRole === role && source.kind === "kills").every((source) => source.queryComplete);
  const reasons: string[] = [];
  const heavyKillObserved = kills.some((row) => row.workerRole === "heavy");
  if (heavyKillObserved) reasons.push("heavy-exceeded-memory-observed");
  if (kills.some((row) => row.workerRole === "public")) reasons.push("public-exceeded-memory-observed-report-only");
  const required = report.sources.filter((source) => source.workerRole === "heavy" || source.kind !== "samples");
  if (required.some((source) => !source.queryComplete)) reasons.push(...required.flatMap((source) => source.failures.map((failure) => failure.reason)));
  const coverageStale = now.getTime() - end > WORKER_MEMORY_TELEMETRY_POLICY.maxCoverageLagSec * 1000;
  if (coverageStale) reasons.push("coverage-stale");
  const missingSource = (["heavy", "public"] as const).some((role) =>
    (role === "heavy" ? ["kills", "scheduled", "samples"] : ["kills", "scheduled"]).some((kind) =>
      !report.sources.some((source) => source.workerRole === role && source.kind === kind && source.from === report.window.from && source.to === report.window.to))
    || windows(report.window.from, report.window.to, 86400_000, true).some((day) =>
      !report.sources.some((source) => source.workerRole === role && source.kind === "role-day" && source.from === day.from && source.to === day.to)));
  const collectionIncomplete = missingSource || required.some((source) => !source.queryComplete);
  const freshnessFailed = coverageStale && report.window.mode === "default";
  if (missingSource) reasons.push("required-source-missing");
  return { status: kills.length ? "observed-kills" : collectionIncomplete || freshnessFailed ? "unavailable" : "no-observed-kills", reasons: [...new Set(reasons)],
    alertFrom: new Date(start).toISOString(), alertTo: report.window.to, heavyKillObserved, collectionIncomplete, freshnessFailed,
    observedHeavyRequests: complete("heavy") ? known("heavy") : null, observedPublicRequests: complete("public") ? known("public") : null,
    knownHeavyRequests: known("heavy"), knownPublicRequests: known("public"), exitCode: heavyKillObserved || collectionIncomplete || freshnessFailed ? 1 : 0 };
}

export async function collectWorkerMemory({ from, to, token, accountId, now = new Date(), sourceSha = null, runIdentity = randomUUID(), fetchImpl = fetch, clock = Date.now, wait = sleep }: {
  from?: string; to?: string; token?: string; accountId?: string; now?: Date; sourceSha?: string | null; runIdentity?: string;
  fetchImpl?: typeof fetch; clock?: () => number; wait?: (milliseconds: number) => Promise<unknown>;
}): Promise<WorkerMemoryReport> {
  const window = resolveWorkerMemoryWindow(from, to, now);
  const policy = WORKER_MEMORY_TELEMETRY_POLICY;
  const started = clock();
  let lastRequest = -Infinity;
  const queries: QueryRecord[] = [];
  const sources: SourceRead[] = [];
  const data = new Map<string, (AdaptiveRow | ScheduledRow)[]>();
  async function read(role: Role, kind: Kind, bounds = window) {
    const scriptName = TARGETS[role];
    const dataset = kind === "scheduled" ? "workersInvocationsScheduled" : "workersInvocationsAdaptive";
    const query = kind === "scheduled" ? buildScheduledInvocationQuery(policy.queryRowLimit) : adaptiveQuery(kind);
    const rows: (AdaptiveRow | ScheduledRow)[] = [];
    const dailyRows: { from: string; to: string; rows: AdaptiveRow[] }[] = [];
    const failures: Failure[] = [];
    async function slice(f: string, t: string): Promise<void> {
      const record: QueryRecord = { id: `q${queries.length + 1}`, kind, scriptName, dataset, query, variables: { a: accountId ?? "unavailable", s: scriptName, f, t }, startedAt: new Date(clock()).toISOString(), finishedAt: new Date(clock()).toISOString(), returnedRows: null, result: "unavailable", reason: null, samplingIntervalUnknownRows: null, samplingIntervalRange: null };
      queries.push(record);
      let reason: string | null = !token?.trim() || !accountId?.trim() ? "analytics-auth-unavailable" : null;
      if (!reason && queries.length > policy.maxRequests) reason = "analytics-request-budget";
      if (!reason && clock() - started >= policy.collectionDeadlineSec * 1000) reason = "analytics-deadline";
      if (!reason) {
        await wait(Math.max(0, policy.minRequestSpacingMs - (clock() - lastRequest)));
        if (clock() - started >= policy.collectionDeadlineSec * 1000) reason = "analytics-deadline";
      }
      if (!reason) {
        try {
          lastRequest = clock();
          const response = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(Math.min(policy.requestTimeoutSec * 1000, Math.max(1, policy.collectionDeadlineSec * 1000 - (clock() - started)))),
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ query, variables: { ...record.variables, a: accountId } }),
          });
          if (!response.ok) { await response.arrayBuffer(); reason = response.status === 401 || response.status === 403 ? "analytics-auth-unavailable" : "analytics-http-unavailable"; }
          else {
            const payload = await response.json();
            if (Array.isArray(payload.errors) && payload.errors.length) reason = "analytics-graphql-error";
            else {
              const accounts = payload.data?.viewer?.accounts;
              const raw: unknown[] | undefined = Array.isArray(accounts) && accounts.length === 1 ? accounts[0]?.[dataset] : undefined;
              if (!Array.isArray(raw)) reason = "analytics-schema-invalid";
              else {
                record.returnedRows = raw.length;
                if (raw.length >= policy.queryRowLimit) {
                  const midpoint = Math.floor((Date.parse(f) + Date.parse(t)) / 2000) * 1000;
                  if (Date.parse(t) - Date.parse(f) <= policy.minSliceSec * 1000 || midpoint <= Date.parse(f) || midpoint >= Date.parse(t)) reason = "analytics-result-cap";
                  else {
                    record.result = "split";
                    record.finishedAt = new Date(clock()).toISOString();
                    await slice(f, new Date(midpoint).toISOString());
                    await slice(new Date(midpoint).toISOString(), t);
                    return;
                  }
                } else {
                  const parsed = kind === "scheduled" ? z.array(scheduledSchema).safeParse(raw) : z.array(adaptiveSchema).safeParse(raw);
                  if (!parsed.success) reason = "analytics-schema-invalid";
                  else {
                    const accepted = parsed.data.filter((row) => {
                      const invocation = "datetime" in row ? row.datetime : row.dimensions.datetime;
                      return kind === "role-day" || (invocation !== undefined && Date.parse(invocation) >= Date.parse(f) && Date.parse(invocation) < Date.parse(t));
                    });
                    if (parsed.data.some((row) => !("datetime" in row) && (row.dimensions.scriptName !== scriptName || (kind === "kills" && row.dimensions.status !== "exceededMemory") || (kind === "role-day" ? !row.dimensions.date : !row.dimensions.datetime || !row.dimensions.scriptVersion)))) reason = "analytics-schema-invalid";
                    else {
                      rows.push(...accepted);
                      record.result = "available";
                      if (kind !== "scheduled") {
                        const adaptive = accepted as AdaptiveRow[];
                        record.samplingIntervalUnknownRows = adaptive.filter((row) => row.avg.sampleInterval === null).length;
                        record.samplingIntervalRange = intervalRange(adaptive);
                        if (kind === "role-day") dailyRows.push({ from: f, to: t, rows: adaptive });
                      }
                    }
                  }
                }
              }
            }
          }
        } catch { reason = clock() - started >= policy.collectionDeadlineSec * 1000 ? "analytics-deadline" : "analytics-http-unavailable"; }
      }
      record.finishedAt = new Date(clock()).toISOString();
      record.reason = reason;
      if (reason) failures.push({ from: f, to: t, reason });
    }
    for (const part of kind === "role-day" ? [bounds] : windows(bounds.from, bounds.to, policy.initialSliceSec * 1000)) await slice(part.from, part.to);
    const adaptive = kind === "scheduled" ? [] : rows as AdaptiveRow[];
    const source: SourceRead = { id: `${role}-${kind}-${bounds.from}`, workerRole: role, scriptName, kind, dataset, ...bounds,
      fetchedAt: new Date(clock()).toISOString(), status: !failures.length ? "available" : rows.length ? "partial" : "unavailable", queryComplete: !failures.length,
      samplingBasis: kind === "scheduled" ? "scheduled-dataset" : "adaptive", returnedRows: failures.length ? null : rows.length, knownReturnedRows: rows.length, failures,
      samplingIntervalUnknownRows: adaptive.filter((row) => row.avg.sampleInterval === null).length, samplingIntervalRange: intervalRange(adaptive) };
    sources.push(source);
    if (kind !== "role-day") data.set(`${role}-${kind}`, rows);
    return { source, dailyRows };
  }
  // Both filtered kill inventories precede correlation and any broad HTTP population.
  for (const kind of ["kills", "scheduled", "samples"] as const) for (const role of ["heavy", "public"] as const) await read(role, kind);
  const roleDays: WorkerMemoryReport["roleDays"] = [];
  for (const role of ["heavy", "public"] as const) for (const day of windows(window.from, window.to, 86400_000, true)) {
    const result = await read(role, "role-day", day);
    for (const part of result.dailyRows.length ? result.dailyRows : [{ ...day, rows: [] }]) roleDays.push({ workerRole: role, ...part, basis: "Cloudflare-sampled-role-day-quantiles", queryComplete: result.source.queryComplete });
  }
  const joined = (role: Role, kind: "kills" | "samples") => joinScheduledMemory(data.get(`${role}-${kind}`) as AdaptiveRow[], data.get(`${role}-scheduled`) as ScheduledRow[], role, sources.find((source) => source.workerRole === role && source.kind === "scheduled")!.queryComplete, sourceSha);
  const kills = [...joined("heavy", "kills"), ...joined("public", "kills")];
  const broad = [...joined("heavy", "samples"), ...joined("public", "samples")];
  const killSources = sources.filter((source) => source.kind === "kills");
  const complete = killSources.every((source) => source.queryComplete);
  const knownRequests = kills.reduce((sum, row) => sum + row.adaptive.sum.requests, 0);
  const generatedAt = new Date(now.getTime() + Math.max(0, clock() - started)).toISOString();
  const reportId = randomUUID();
  const laneDescriptors: WorkerMemoryReport["laneDescriptors"] = {};
  for (const descriptor of SCHEDULED_TASK_DESCRIPTORS) {
    if (descriptor.producerKind === "scheduled-job") (laneDescriptors[descriptor.scheduleKey] ??= []).push(descriptor);
  }
  const report: WorkerMemoryReport = {
    schemaVersion: 1, reportId, generatedAt, sourceSha, runIdentity, targets: TARGETS, policy, window: { ...window, fromInclusive: true, toExclusive: true, mode: from === undefined && to === undefined ? "default" : "explicit" },
    freshness: { status: "fresh", coverageLagSec: (Date.parse(generatedAt) - Date.parse(window.to)) / 1000, generationId: reportId, reason: null },
    sources, roleDays, laneDays: buildDailyLaneSamples(broad, (["heavy", "public"] as const).map((role) => ({ role, rows: data.get(`${role}-scheduled`) as ScheduledRow[] })), sources, window.from, window.to),
    laneDescriptors,
    samples: broad.filter((row) => row.lane !== null || row.candidates.length > 0),
    sampleCorrelations: (["heavy", "public"] as const).flatMap((workerRole) => {
      const counts = new Map<string, number>();
      for (const row of broad) if (row.workerRole === workerRole) counts.set(row.correlation, (counts.get(row.correlation) ?? 0) + 1);
      return [...counts].map(([correlation, returnedRows]) => ({ workerRole, correlation, returnedRows }));
    }),
    exceededMemory: { groups: kills, complete, returnedGroups: complete ? kills.length : null, reportedRequests: complete ? knownRequests : null, knownReturnedGroups: kills.length, knownReportedRequests: knownRequests, reasons: [...new Set(killSources.flatMap((source) => source.failures.map((failure) => failure.reason)))] },
    capacity: buildCapacityHeadroom({
      roleDays,
      scheduled: (["heavy", "public"] as const).map((role) => ({ workerRole: role, rows: data.get(`${role}-scheduled`) as ScheduledRow[], complete: sources.find((source) => source.workerRole === role && source.kind === "scheduled")!.queryComplete })),
    }),
    queries, verdict: { status: "unavailable", reasons: [], alertFrom: window.from, alertTo: window.to, heavyKillObserved: false, collectionIncomplete: true, freshnessFailed: false, observedHeavyRequests: null, observedPublicRequests: null, knownHeavyRequests: 0, knownPublicRequests: 0, exitCode: 1 },
    caveats: ["All memory values are sampled V8 isolate memory shared across concurrent invocations, not phase peaks or headroom.", "Query-complete is not unsampled request-population completeness. Unknown values are null, never zero-filled.", "Filtered Adaptive exceededMemory is kill authority; Scheduled status can differ. Correlation is not a request ID.", "Current collector-registry candidate jobs are not historical execution or culprit proof.", "Public kills and incomplete public broad samples are report-only; revisit after one week of baseline.", "Small-N empirical P999 can equal the largest returned P50 sample. No population confidence is claimed.", "Adaptive coloCode is the serving location of the sampled invocation group; missing colo stays unknown and is never inferred from request.cf or a self-fetch echo."],
    outputFiles: ["report.json", "report.md", "capacity.md", "samples.ndjson", "exceeded-memory.ndjson", "queries.json"],
  };
  report.verdict = evaluateMemoryObservation(report, new Date(generatedAt));
  if (report.verdict.reasons.includes("coverage-stale")) { report.freshness.status = "stale"; report.freshness.reason = "coverage-stale"; }
  return report;
}

const capacitySchema = z.object({
  status: z.enum(["ok", "warn", "unavailable"]), warnRatio: z.number().gt(0).lte(1), minSamples: z.number().int().nonnegative(),
  limits: z.object({ cpuUs: z.object({ "sub-hourly": numeric, "hourly-or-longer": numeric }), memoryBytes: numeric }),
  triggers: z.array(z.object({
    workerRole: z.enum(["heavy", "public"]), cron: z.string(), cpuClass: z.enum(["sub-hourly", "hourly-or-longer"]).nullable(),
    limitUs: metric, samples: numeric, p50Us: metric, p99Us: metric, maxUs: metric, exceededCpu: numeric, p99Ratio: metric,
    status: z.enum(["ok", "warn", "unavailable", "insufficient-samples"]), reason: z.string().nullable(),
  })),
  memory: z.array(z.object({
    workerRole: z.enum(["heavy", "public"]), basis: z.literal("max-of-cloudflare-sampled-role-day-p99"), limitBytes: numeric,
    days: z.array(z.object({ dayUtc: z.string(), from: timestamp, to: timestamp, status: z.string(), requests: numeric, p99Bytes: numeric })),
    p99Bytes: metric, p99Ratio: metric, status: z.enum(["ok", "warn", "unavailable"]), reason: z.string().nullable(),
  })),
  reasons: z.array(z.string()),
});
function validateReport(report: WorkerMemoryReport) {
  observationEnvelopeSchema.extend({ schemaVersion: z.literal(1), capacity: capacitySchema, verdict: z.object({ heavyKillObserved: z.boolean(), collectionIncomplete: z.boolean(), freshnessFailed: z.boolean(), exitCode: z.union([z.literal(0), z.literal(1)]), reasons: z.array(z.string()) }) }).parse(report);
  for (const row of [...report.samples, ...report.exceededMemory.groups]) adaptiveSchema.parse(row.adaptive);
}
export function renderWorkerMemoryMarkdown(report: WorkerMemoryReport) {
  validateReport(report);
  const mib = (value: number | null | undefined) => value == null ? "unavailable" : (value / 1048576).toFixed(2);
  const safe = markdownCell;
  const lines = ["# Worker sampled isolate memory", "", `Verdict: **${report.verdict.status}**; exit ${report.verdict.exitCode}.`,
    `Window (${report.window.mode}): ${report.window.from} ≤ invocation < ${report.window.to}. Generated: ${report.generatedAt}; generation: ${report.reportId}.`,
    `Targets: heavy=${TARGETS.heavy}, public=${TARGETS.public}. Collector/registry SHA: ${report.sourceSha ?? "unavailable"}.`,
    `Freshness: ${report.freshness.status}; coverage-lag budget 8100s (gates default windows only), ingestion allowance 900s (not an ingestion guarantee). No report-age gate is applied.`,
    `Reasons: ${report.verdict.reasons.join(", ") || "none"}.`,
    `Capacity headroom: **${report.capacity.status}**; per-trigger CPU and sampled memory tables are in \`capacity.md\`.`, "", ...report.caveats.map((text) => `- ${text}`), "",
    "## Independently filtered exceededMemory inventory", "", `Returned groups: ${report.exceededMemory.returnedGroups ?? "unavailable"}; known subtotal ${report.exceededMemory.knownReturnedGroups}. Reported requests: ${report.exceededMemory.reportedRequests ?? "unavailable"}; known subtotal ${report.exceededMemory.knownReportedRequests}.`,
    "Full inventory: `exceeded-memory.ndjson` (bounded display below: first 100 groups). Lane descriptors are stored once in `report.json.laneDescriptors`, keyed by each row's `lane.scheduleKey`.", "", "| Invocation | Role | Colo | Requests / sample interval | Physical / logical lane | Correlation | Adaptive / Scheduled status |", "|---|---|---|---|---|---|---|"];
  for (const row of report.exceededMemory.groups.slice(0, 100)) lines.push(`| ${row.adaptive.dimensions.datetime} | ${row.workerRole} | ${safe(row.adaptive.dimensions.coloCode ?? "unknown")} | ${row.adaptive.sum.requests} / ${row.adaptive.avg.sampleInterval ?? "unknown"} | ${safe(row.lane?.cron ?? "unattributed")} / ${safe(row.lane?.scheduleKey ?? "unattributed")} | ${row.correlation} | exceededMemory / ${safe(row.scheduledStatus ?? "unavailable")} |`);
  lines.push("", "## Lane/day/colo empirical matched-row P50 distribution (MiB)", "", "Basis: empirical-nearest-rank-of-matched-row-memoryUsageBytesP50. Outcome/version/colo strata and physical/logical rollups stay separate. Counts accompany every distribution; null is unavailable.", "", "| Day / role | Lane / rollup | Outcome / version / colo | N measured / matched | p50 | p90 | p99 | p999 | Complete |", "|---|---|---|---|---|---|---|---|---|");
  for (const row of report.laneDays) {
    const q = row.sampledRowMemoryP50DistributionBytes;
    lines.push(`| ${row.dayUtc} / ${row.workerRole} | ${safe(row.cron ?? row.scheduleKey)} / ${row.rollup} | ${safe(row.status)} / ${safe(row.scriptVersion ?? "unknown")} / ${safe(row.coloCode ?? "unknown")} | ${row.memoryMeasuredRows} / ${row.matchedRows} | ${mib(q?.p50)} | ${mib(q?.p90)} | ${mib(q?.p99)} | ${mib(q?.p999)} | ${row.queryComplete} |`);
  }
  lines.push("", "## Direct Cloudflare sampled role/day quantiles (MiB)", "", "Not pooled lane statistics or percentile-of-percentiles. Each row retains its exact source window in report.json.", "", "| Role / source window | Outcome | Requests / sample interval | p50 | p90 | p99 | p999 | Complete |", "|---|---|---|---|---|---|---|---|");
  for (const day of report.roleDays) {
    if (!day.rows.length) lines.push(`| ${day.workerRole} / ${day.from}–${day.to} | no observations | unavailable | unavailable | unavailable | unavailable | unavailable | ${day.queryComplete} |`);
    for (const row of day.rows) lines.push(`| ${day.workerRole} / ${day.from}–${day.to} | ${safe(row.dimensions.status)} | ${row.sum.requests} / ${row.avg.sampleInterval ?? "unknown"} | ${mib(day.queryComplete ? row.quantiles.memoryUsageBytesP50 : null)} | ${mib(day.queryComplete ? row.quantiles.memoryUsageBytesP90 : null)} | ${mib(day.queryComplete ? row.quantiles.memoryUsageBytesP99 : null)} | ${mib(day.queryComplete ? row.quantiles.memoryUsageBytesP999 : null)} | ${day.queryComplete} |`);
  }
  lines.push("", "## Broad sample correlation coverage", "", "Returned row counts below are not request totals or population estimates. Unmatched public samples have no route attribution; only candidate-bearing rows are retained in samples.ndjson.", "", "| Role | Correlation | Returned rows |", "|---|---|---|");
  for (const row of report.sampleCorrelations) lines.push(`| ${row.workerRole} | ${row.correlation} | ${row.returnedRows} |`);
  lines.push("", "## Source coverage", "", "| Role / source | Window | Query complete | Returned rows / known subtotal | Sampling interval range / unknown rows | Reasons |", "|---|---|---|---|---|---|");
  for (const source of report.sources) lines.push(`| ${source.workerRole} / ${source.kind} | ${source.from}–${source.to} | ${source.queryComplete} | ${source.returnedRows ?? "unavailable"} / ${source.knownReturnedRows} | ${source.samplingIntervalRange?.join("–") ?? "unknown"} / ${source.samplingIntervalUnknownRows} | ${[...new Set(source.failures.map((failure) => failure.reason))].join(", ") || "none"} |`);
  return `${lines.join("\n")}\n`;
}
export async function writeWorkerMemoryReport(report: WorkerMemoryReport, outDir: string) {
  validateReport(report);
  await mkdir(outDir, { recursive: true });
  const ndjson = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  await Promise.all([
    writeFile(resolve(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(resolve(outDir, "report.md"), renderWorkerMemoryMarkdown(report)),
    writeFile(resolve(outDir, "capacity.md"), renderCapacityMarkdown(report.capacity, report.window)),
    writeFile(resolve(outDir, "samples.ndjson"), ndjson(report.samples)),
    writeFile(resolve(outDir, "exceeded-memory.ndjson"), ndjson(report.exceededMemory.groups)),
    writeFile(resolve(outDir, "queries.json"), `${JSON.stringify(report.queries, null, 2)}\n`),
  ]);
}
runDirectCli(import.meta.url, async () => {
  const args = parseWorkerMemoryArgs(process.argv.slice(2));
  if (writeCliHelpIfRequested(args, USAGE) || args.help) return;
  const runIdentity = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}` : new Date().toISOString().replace(/[:.]/g, "-");
  const report = await collectWorkerMemory({ ...args, token: process.env.CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, sourceSha: process.env.GITHUB_SHA ?? null, runIdentity });
  await writeWorkerMemoryReport(report, args.outDir ?? `agents/worker-memory/${runIdentity}`);
  console.log(`Worker memory: ${report.verdict.status}; heavy-kill-observed=${report.verdict.heavyKillObserved}; collection-incomplete=${report.verdict.collectionIncomplete}; freshness-failed=${report.verdict.freshnessFailed}; reasons=${report.verdict.reasons.join(",") || "none"}`);
  process.exitCode = report.verdict.exitCode;
});
