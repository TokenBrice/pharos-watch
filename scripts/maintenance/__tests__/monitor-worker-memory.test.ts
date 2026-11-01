import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { buildCapacityHeadroom, classifyCronCpuClass, collectWorkerMemory, evaluateMemoryObservation, joinScheduledMemory, parseWorkerMemoryArgs, renderCapacityMarkdown, renderWorkerMemoryMarkdown, WORKER_CAPACITY_POLICY, writeWorkerMemoryReport } from "../monitor-worker-memory";
import fixtures from "./fixtures/worker-memory/october-kills.json";

const from = "2026-10-14T00:00:00Z";
const to = "2026-10-15T00:00:00Z";
const now = new Date("2026-10-15T00:15:00Z");
const scheduled = fixtures.scheduled[0]!;
// Original captures omit per-second sampling and P999. They remain unknown in
// the committed fixture; explicit test variants below exercise new query fields.
function adaptive(overrides: Record<string, unknown> = {}) {
  return { ...fixtures.adaptive[0]!, avg: { sampleInterval: 1 }, quantiles: { ...fixtures.adaptive[0]!.quantiles, memoryUsageBytesP999: null }, ...overrides };
}
function response(dataset: string, rows: unknown[]) {
  return new Response(JSON.stringify({ data: { viewer: { accounts: [{ [dataset]: rows }] } } }));
}
function injectedFetch(handler: (query: string, variables: { s: string; f: string; t: string }) => Response) {
  return vi.fn<typeof fetch>(async (url, options) => {
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    const { query, variables } = JSON.parse(String(options?.body));
    expect(query).not.toContain("mutation");
    return handler(query, variables);
  });
}
const emptyFetch = () => injectedFetch((query) => response(query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", []));
const options = () => ({ from, to, now, token: "test-only-token", accountId: "test-account", wait: async () => {}, clock: () => now.getTime() });

// Parse through the collector boundary so tests use the same nullable row shape.
async function capture(rows: unknown[], scheduledRows: unknown[] = [scheduled], includeBroad = false) {
  return collectWorkerMemory({ ...options(), fetchImpl: injectedFetch((query, variables) => {
    const isScheduled = query.includes("workersInvocationsScheduled");
    const selected = isScheduled ? scheduledRows : query.includes('status:"exceededMemory"') || (includeBroad && query.includes("datetime scriptVersion")) ? rows : [];
    return response(isScheduled ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", selected.filter((value) => {
      const row = value as { datetime?: string; dimensions?: { datetime: string; scriptName: string } };
      const datetime = row.datetime ?? row.dimensions?.datetime;
      return (!row.dimensions || row.dimensions.scriptName === variables.s) && (!isScheduled || variables.s === "stablecoin-heavy") && datetime !== undefined && Date.parse(datetime) >= Date.parse(variables.f) && Date.parse(datetime) < Date.parse(variables.t);
    }));
  }) });
}

function workflowStepScript(name: string) {
  const workflow = parseYaml(readFileSync(".github/workflows/worker-memory-monitor.yml", "utf8"));
  const run = workflow.jobs.memory.steps.find((step: { name?: string }) => step.name === name).run as string;
  const script = run.match(/<<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/)?.[1];
  if (!script) throw new Error(`Missing Node verdict script: ${name}`);
  return script;
}

function runWorkflowVerdict(name: string, runnerTemp: string, collectOutcome: "success" | "failure") {
  return spawnSync(process.execPath, ["--input-type=module", "-e", workflowStepScript(name)], {
    env: { ...process.env, RUNNER_TEMP: runnerTemp, COLLECT_OUTCOME: collectOutcome }, encoding: "utf8",
  });
}

function runWorkflowDecision(name: string, runnerTemp: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", workflowStepScript(name)], {
    env: { ...process.env, RUNNER_TEMP: runnerTemp, ...env }, encoding: "utf8",
  });
}

describe("sampled Worker memory correlation", () => {
  it.each(["internalError", "clientDisconnected"])("uses Adaptive kill authority despite Scheduled %s", async (status) => {
    const report = await capture([adaptive()], [{ ...scheduled, status }]);
    expect(report.exceededMemory.groups).toHaveLength(1);
    const kill = report.exceededMemory.groups[0]!;
    expect(kill.lane).toMatchObject({ cron: "16 * * * *", scheduleKey: "halfHourlyChartsOffset", slotStartedAt: Date.parse("2026-10-14T01:16:00Z") / 1000, executionConfirmed: false, expectedJob: null });
    expect(kill.lane?.candidateJobChains.flat()).toContain("prepare-safety-score-v9-input");
    expect(kill.lane?.candidateJobChains.flat()).not.toContain("compute-safety-score-v9");
    expect(kill.scheduledStatus).toBe(status);
    expect(report.samples).toEqual([]);
    expect(report.verdict).toMatchObject({ heavyKillObserved: true, exitCode: 1 });
  });
  it("retains original missing sampling rather than inventing singleton attribution", async () => {
    const report = await capture(fixtures.adaptive);
    expect(report.exceededMemory.groups[0]).toMatchObject({ correlation: "grouped", lane: null, adaptive: { avg: { sampleInterval: null }, quantiles: { memoryUsageBytesP999: null } } });
    expect(report.exceededMemory.groups[0]?.candidates[0]?.cron).toBe("16 * * * *");
    expect(report.verdict.heavyKillObserved).toBe(true);
  });
  it.each([null, 1, 2])("requires both requests=1 and sampleInterval=1 (%s)", async (sampleInterval) => {
    const report = await capture([adaptive({ avg: { sampleInterval } })]);
    expect(report.exceededMemory.groups[0]?.correlation).toBe(sampleInterval === 1 ? "unique-singleton" : "grouped");
  });
  it("keeps grouped, duplicate and reverse-collision evidence unassigned", async () => {
    const report = await capture([adaptive()]);
    const row = report.exceededMemory.groups[0]!.adaptive;
    expect(joinScheduledMemory([{ ...row, sum: { ...row.sum, requests: 2 } }], [scheduled], "heavy")[0]?.correlation).toBe("grouped");
    expect(joinScheduledMemory([row], [scheduled, { ...scheduled }], "heavy")[0]?.correlation).toBe("ambiguous");
    expect(joinScheduledMemory([row, { ...row }], [scheduled], "heavy").map((result) => result.correlation)).toEqual(["ambiguous", "ambiguous"]);
  });
  it("matches strictly under 2 microseconds, same script and same second only", async () => {
    const report = await capture([adaptive()]);
    const row = report.exceededMemory.groups[0]!.adaptive;
    expect(joinScheduledMemory([row], [{ ...scheduled, cpuTimeUs: scheduled.cpuTimeUs + 1.999 }], "heavy")[0]?.correlation).toBe("unique-singleton");
    expect(joinScheduledMemory([row], [{ ...scheduled, cpuTimeUs: scheduled.cpuTimeUs + 2 }], "heavy")[0]?.correlation).toBe("unmatched");
    expect(joinScheduledMemory([row], [{ ...scheduled, datetime: "2026-10-14T01:16:40Z" }], "heavy")[0]?.correlation).toBe("unmatched");
    expect(joinScheduledMemory([row], [scheduled], "public")[0]?.lane).toBeNull();
  });
  it("normalizes scheduled time and maps compiler candidates without confirming execution", async () => {
    const report = await capture([adaptive()]);
    const row = report.exceededMemory.groups[0]!.adaptive;
    const result = joinScheduledMemory([row], [{ ...scheduled, cron: "22 * * * *", scheduledDatetime: "2026-10-14T00:22:37Z" }], "heavy")[0]!;
    expect(result.lane).toMatchObject({ expectedJob: "compute-safety-score-v9", jobBasis: "registry-plan", executionConfirmed: false, slotStartedAt: Date.parse("2026-10-14T00:22:00Z") / 1000 });
    expect(joinScheduledMemory([row], [{ ...scheduled, cron: "unknown" }], "heavy")[0]?.correlation).toBe("registry-unmapped");
    expect(joinScheduledMemory([row], [{ ...scheduled, cron: "10 * * * *" }], "heavy")[0]?.correlation).toBe("registry-owner-mismatch");
  });
  it("keeps the October 15 public DEX fixture report-only and unattributed without Scheduled evidence", async () => {
    const report = await collectWorkerMemory({ ...options(), from: "2026-10-15T00:00:00Z", to: "2026-10-16T00:00:00Z", now: new Date("2026-10-16T00:15:00Z"), fetchImpl: injectedFetch((query, variables) => response(query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", query.includes('status:"exceededMemory"') && variables.s === "stablecoin-api" && variables.f <= "2026-10-15T05:10:15Z" && variables.t > "2026-10-15T05:10:15Z" ? [fixtures.adaptive[1]] : [])) });
    expect(report.exceededMemory.groups).toHaveLength(1);
    expect(report.exceededMemory.groups[0]?.lane).toBeNull();
    expect(report.verdict).toMatchObject({ status: "observed-kills", heavyKillObserved: false, collectionIncomplete: false, exitCode: 0, knownPublicRequests: 1 });
  });
  it("retains Adaptive coloCode evidence without relaxing singleton attribution", async () => {
    const report = await capture([adaptive({ dimensions: { ...fixtures.adaptive[0]!.dimensions, coloCode: "MEL" } })]);
    const kill = report.exceededMemory.groups[0]!;
    expect(kill.adaptive.dimensions.coloCode).toBe("MEL");
    expect(kill.correlation).toBe("unique-singleton");
    expect(report.queries.find((query) => query.kind === "kills")!.query).toContain("coloCode");
    const dir = await mkdtemp(join(tmpdir(), "worker-memory-colo-"));
    try {
      await writeWorkerMemoryReport(report, dir);
      const retained = (await readFile(join(dir, "exceeded-memory.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(retained[0].adaptive.dimensions.coloCode).toBe("MEL");
      expect(await readFile(join(dir, "report.md"), "utf8")).toContain("MEL");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("keeps colo codes out of role-day quantiles and never pools lane/day memory across a colo change", async () => {
    const base = {
      dimensions: { ...fixtures.adaptive[0]!.dimensions, status: "success" },
      quantiles: { ...fixtures.adaptive[0]!.quantiles, memoryUsageBytesP999: null },
      sum: { requests: 1, subrequests: 0 },
      avg: { sampleInterval: 1 },
    };
    const mel = { ...base, dimensions: { ...base.dimensions, datetime: "2026-10-14T01:16:39Z", coloCode: "MEL" }, quantiles: { ...base.quantiles, memoryUsageBytesP50: 10 * 1048576 } };
    const fra = { ...base, dimensions: { ...base.dimensions, datetime: "2026-10-14T01:16:40Z", coloCode: "FRA" }, quantiles: { ...base.quantiles, memoryUsageBytesP50: 20 * 1048576 } };
    const version = base.dimensions.scriptVersion;
    const report = await collectWorkerMemory({ ...options(), fetchImpl: injectedFetch((query, variables) => {
      const isScheduled = query.includes("workersInvocationsScheduled");
      const broadAdaptive = !isScheduled && query.includes("datetime scriptVersion") && !query.includes('status:"exceededMemory"');
      const rows = isScheduled
        ? [{ ...scheduled }, { ...scheduled, datetime: "2026-10-14T01:16:40Z" }]
        : broadAdaptive ? [mel, fra] : [];
      return response(isScheduled ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", variables.s === "stablecoin-heavy" ? rows : []);
    }) });
    expect(report.queries.find((query) => query.kind === "role-day")!.query).not.toContain("coloCode");
    const lanes = report.laneDays.filter((row) => row.rollup === "logical" && row.scriptVersion === version);
    expect(lanes.map((row) => row.coloCode).sort()).toEqual(["FRA", "MEL"]);
    expect(lanes.map((row) => row.sampledRowMemoryP50DistributionBytes?.p50 ?? null).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([10 * 1048576, 20 * 1048576]);
    expect(lanes.every((row) => row.memoryMeasuredRows === 1)).toBe(true);
  });
  it("leaves colo unknown instead of inferring it for rows without the dimension", async () => {
    const report = await capture([adaptive()], [scheduled], true);
    expect(report.laneDays.length).toBeGreaterThan(0);
    expect(report.laneDays.every((row) => row.coloCode === null)).toBe(true);
    expect(report.samples.every((row) => row.adaptive.dimensions.coloCode === undefined)).toBe(true);
    expect(report.exceededMemory.groups[0]!.adaptive.dimensions.coloCode).toBeUndefined();
  });
});

describe("bounded Analytics collection and unavailable evidence", () => {
  it("bisects capped parent windows, discards parents and owns Scheduled boundaries once", async () => {
    const caps: string[] = [];
    const report = await collectWorkerMemory({ ...options(), from: "2026-10-14T01:00:00Z", to: "2026-10-14T02:00:00Z", fetchImpl: injectedFetch((query, variables) => {
      const dataset = query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive";
      if (variables.s === "stablecoin-heavy" && query.includes('status:"exceededMemory"') && Date.parse(variables.t) - Date.parse(variables.f) > 1800_000) {
        caps.push(variables.f);
        return response(dataset, Array.from({ length: 10000 }, () => adaptive()));
      }
      const datetime = dataset === "workersInvocationsScheduled" ? scheduled.datetime : "2026-10-14T01:16:39Z";
      return response(dataset, variables.s === "stablecoin-heavy" && variables.f <= datetime && variables.t > datetime && (dataset === "workersInvocationsScheduled" || query.includes('status:"exceededMemory"')) ? [dataset === "workersInvocationsScheduled" ? scheduled : adaptive()] : []);
    }) });
    expect(caps).toHaveLength(1);
    expect(report.queries.filter((query) => query.result === "split")).toHaveLength(1);
    expect(report.exceededMemory.knownReturnedGroups).toBe(1);
    expect(report.exceededMemory.complete).toBe(true);
  });
  it("splits Scheduled inclusive bounds locally without deduplicating within-response rows", async () => {
    const boundary = { ...scheduled, datetime: "2026-10-14T01:30:00Z", scheduledDatetime: "2026-10-14T00:16:00Z" };
    const report = await collectWorkerMemory({ ...options(), from: "2026-10-14T01:00:00Z", to: "2026-10-14T02:00:00Z", fetchImpl: injectedFetch((query, variables) => {
      if (!query.includes("workersInvocationsScheduled") || variables.s !== "stablecoin-heavy") return response(query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", []);
      const span = Date.parse(variables.t) - Date.parse(variables.f);
      return response("workersInvocationsScheduled", span > 1800_000 ? Array.from({ length: 10000 }, () => boundary) : [boundary, { ...boundary }]);
    }) });
    const source = report.sources.find((row) => row.kind === "scheduled" && row.workerRole === "heavy")!;
    expect(source.queryComplete).toBe(true);
    expect(source.returnedRows).toBe(2);
  });
  it("keeps evidence unavailable on the request and deadline ceilings", async () => {
    const fetchImpl = injectedFetch((query) => response(query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", query.includes('status:"exceededMemory"') ? Array.from({ length: 10000 }, () => null) : []));
    const budget = await collectWorkerMemory({ ...options(), fetchImpl });
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(240);
    expect(budget.verdict.reasons).toContain("analytics-request-budget");
    let tick = now.getTime();
    const deadline = await collectWorkerMemory({ ...options(), fetchImpl: emptyFetch(), clock: () => { tick += 360_000; return tick; } });
    expect(deadline.verdict.reasons).toContain("analytics-deadline");
    expect(deadline.exceededMemory.reportedRequests).toBeNull();
  });
  it("marks one-second caps unavailable rather than counting capped parents", async () => {
    const report = await collectWorkerMemory({ ...options(), from: "2026-10-14T01:16:39Z", to: "2026-10-14T01:16:40Z", fetchImpl: injectedFetch((query) => response(query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", query.includes('status:"exceededMemory"') ? Array.from({ length: 10000 }, () => adaptive()) : [])) });
    expect(report.exceededMemory.reportedRequests).toBeNull();
    expect(report.exceededMemory.knownReportedRequests).toBe(0);
    expect(report.verdict.reasons).toContain("analytics-result-cap");
  });
  it.each([401, 429, 503])("retains a heavy kill and writes evidence when a sibling returns HTTP %s", async (status) => {
    const report = await collectWorkerMemory({ ...options(), fetchImpl: injectedFetch((query, variables) => variables.s === "stablecoin-api" ? new Response("provider error must not leak", { status }) : response(query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", query.includes('status:"exceededMemory"') && variables.f <= scheduled.datetime && variables.t > scheduled.datetime ? [adaptive()] : [])) });
    expect(report.verdict.exitCode).toBe(1);
    expect(report.exceededMemory.reportedRequests).toBeNull();
    expect(report.exceededMemory.knownReportedRequests).toBe(1);
    expect(report.verdict.heavyKillObserved).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "worker-memory-"));
    try {
      await writeWorkerMemoryReport(report, dir);
      expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).exceededMemory.knownReportedRequests).toBe(1);
      expect(await readFile(join(dir, "exceeded-memory.ndjson"), "utf8")).toContain("exceededMemory");
      expect(await readFile(join(dir, "queries.json"), "utf8")).not.toContain("provider error");
      expect(JSON.stringify(report)).not.toContain("test-only-token");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("public broad failure is report-only, but heavy broad failure is incomplete", async () => {
    for (const target of ["stablecoin-api", "stablecoin-heavy"]) {
      const report = await collectWorkerMemory({ ...options(), fetchImpl: injectedFetch((query, variables) => !query.includes("workersInvocationsScheduled") && !query.includes('status:"exceededMemory"') && query.includes("datetime scriptVersion") && variables.s === target ? new Response("denied", { status: 403 }) : response(query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", [])) });
      expect(report.verdict.collectionIncomplete).toBe(target === "stablecoin-heavy");
    }
  });
  it("distinguishes unknown memory from observed zero without alerting on >128 MiB samples", async () => {
    for (const memory of [null, 0, 220 * 1048576]) {
      const row = adaptive({ dimensions: { ...fixtures.adaptive[0]!.dimensions, status: "success" }, quantiles: { ...adaptive().quantiles, memoryUsageBytesP50: memory } });
      const report = await collectWorkerMemory({ ...options(), fetchImpl: injectedFetch((query, variables) => response(query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", variables.s === "stablecoin-heavy" && variables.f <= scheduled.datetime && variables.t > scheduled.datetime ? query.includes("workersInvocationsScheduled") ? [scheduled] : query.includes("datetime scriptVersion") && !query.includes('status:"exceededMemory"') ? [row] : [] : [])) });
      expect(report.verdict.exitCode).toBe(0);
      const lane = report.laneDays.find((day) => day.scriptVersion !== null)!;
      expect(lane.sampledRowMemoryP50DistributionBytes?.p50 ?? null).toBe(memory);
      expect(renderWorkerMemoryMarkdown(report)).toContain("not phase peaks or headroom");
    }
  });
  it("missing credentials never transport and preserve unavailable null counts", async () => {
    const fetchImpl = emptyFetch();
    const report = await collectWorkerMemory({ ...options(), token: undefined, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.exceededMemory.reportedRequests).toBeNull();
    expect(report.verdict).toMatchObject({ collectionIncomplete: true, exitCode: 1 });
  });
  it("rejects HTTP-200 GraphQL and malformed row evidence", async () => {
    for (const body of [{ errors: [{ message: "secret provider detail" }] }, { data: { viewer: { accounts: [] } } }, { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ ...adaptive(), sum: { requests: null } }] }] } } }]) {
      const report = await collectWorkerMemory({ ...options(), fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body))) });
      expect(report.verdict.collectionIncomplete).toBe(true);
      expect(report.exceededMemory.reportedRequests).toBeNull();
      expect(JSON.stringify(report)).not.toContain("secret provider detail");
    }
  });
  it.each(["default", "explicit"] as const)("labels stale %s coverage separately from collection completeness", async (mode) => {
    const report = await collectWorkerMemory({ ...options(), from: mode === "default" ? undefined : from, to: mode === "default" ? undefined : to, fetchImpl: emptyFetch() });
    expect(report.window.mode).toBe(mode);
    const boundary = new Date(Date.parse(report.window.to) + 8100_000);
    expect(evaluateMemoryObservation(report, boundary)).toMatchObject({ collectionIncomplete: false, freshnessFailed: false, exitCode: 0 });
    const stale = evaluateMemoryObservation(report, new Date(boundary.getTime() + 1));
    expect(stale.reasons).toContain("coverage-stale");
    expect(stale).toMatchObject({ collectionIncomplete: false, freshnessFailed: mode === "default", exitCode: mode === "default" ? 1 : 0 });
  });
  it("reports a complete historical forensic window as stale without failing it", async () => {
    const report = await collectWorkerMemory({ ...options(), now: new Date("2026-10-16T00:15:00Z"), fetchImpl: emptyFetch() });
    expect(report.freshness).toMatchObject({ status: "stale", reason: "coverage-stale" });
    expect(report.verdict).toMatchObject({ status: "no-observed-kills", reasons: ["coverage-stale"], collectionIncomplete: false, freshnessFailed: false, exitCode: 0 });
    expect(report.policy).not.toHaveProperty("maxReportAgeSec");
    expect(report.freshness).not.toHaveProperty("reportAgeSec");
    expect(renderWorkerMemoryMarkdown(report)).not.toContain("7200");
    const killReport = await capture([adaptive()]);
    expect(evaluateMemoryObservation(killReport, new Date("2026-10-16T00:15:00Z"))).toMatchObject({
      heavyKillObserved: true, collectionIncomplete: false, freshnessFailed: false, exitCode: 1,
    });
  });
  it("uses exact trailing-window boundaries even for historical observations", async () => {
    const report = await capture([adaptive()]);
    const event = Date.parse(scheduled.datetime);
    expect(evaluateMemoryObservation({ ...report, window: { ...report.window, to: new Date(event + 86400_000).toISOString() } }, now).heavyKillObserved).toBe(true);
    expect(evaluateMemoryObservation({ ...report, window: { ...report.window, to: new Date(event + 86400_000 + 1).toISOString() } }, now).heavyKillObserved).toBe(false);
  });
});

function scheduledRows(cron: string, count: number, cpuTimeUs: number, status = "success") {
  return Array.from({ length: count }, (_, index) => ({
    ...scheduled, cron, cpuTimeUs, status,
    datetime: new Date(Date.parse(from) + index * 60_000).toISOString(),
    scheduledDatetime: new Date(Date.parse(from) + index * 60_000).toISOString(),
  }));
}
function roleDay(workerRole: "heavy" | "public", memoryP99: number | null, queryComplete = true) {
  return {
    workerRole, from, to, basis: "Cloudflare-sampled-role-day-quantiles" as const, queryComplete,
    rows: [{
      dimensions: { date: "2026-10-14", scriptName: workerRole === "heavy" ? "stablecoin-heavy" : "stablecoin-api", status: "success" },
      sum: { requests: 12, subrequests: 3 }, avg: { sampleInterval: 1 },
      quantiles: { cpuTimeP50: null, durationP50: null, memoryUsageBytesP50: null, memoryUsageBytesP90: null, memoryUsageBytesP99: memoryP99, memoryUsageBytesP999: null },
    }],
  };
}
const memoryOk = () => [roleDay("heavy", 1048576), roleDay("public", 1048576)];
function headroom(rows: ReturnType<typeof scheduledRows>, complete = true, roleDays = memoryOk()) {
  return buildCapacityHeadroom({ roleDays, scheduled: [{ workerRole: "heavy", rows, complete }] });
}
const reportWindow = { from, to, fromInclusive: true as const, toExclusive: true as const, mode: "default" as const };

describe("capacity headroom against platform limits", () => {
  it.each([
    ["*/5 * * * *", "sub-hourly"],
    ["26,56 * * * *", "sub-hourly"],
    ["2,7,12,17,22,27,32,37,42,47,52,57 * * * *", "sub-hourly"],
    ["0 * * * *", "hourly-or-longer"],
    ["3 */6 * * *", "hourly-or-longer"],
    ["0 8 * * *", "hourly-or-longer"],
    ["0 6 1 * *", "hourly-or-longer"],
  ])("derives the Cloudflare CPU class from %s", (expression, expected) => {
    expect(classifyCronCpuClass(expression)).toBe(expected);
  });
  it.each(["0 * * *", "61 * * * *", "*/5 25 * * *", "0-* * * * *", "every hour"])("leaves unparseable expressions unknown (%s)", (expression) => {
    expect(classifyCronCpuClass(expression)).toBeNull();
  });
  it("bounds the CPU class limits by the configured Worker cpu_ms", () => {
    expect(WORKER_CAPACITY_POLICY.cpuLimitUs["sub-hourly"]).toBe(30_000_000);
    expect(WORKER_CAPACITY_POLICY.cpuLimitUs["hourly-or-longer"]).toBe(300_000_000);
  });
  it("warns strictly above 70% of the class limit", () => {
    const at = (cpuTimeUs: number) => headroom(scheduledRows("*/5 * * * *", 100, cpuTimeUs)).triggers[0]!;
    expect(at(21_000_000)).toMatchObject({ cpuClass: "sub-hourly", limitUs: 30_000_000, samples: 100, status: "ok", reason: null });
    expect(at(21_000_001)).toMatchObject({ status: "warn", reason: "cpu-p99-over-warn-threshold" });
    expect(headroom(scheduledRows("16 * * * *", 100, 210_000_001)).triggers[0]).toMatchObject({
      cpuClass: "hourly-or-longer", limitUs: 300_000_000, p99Ratio: 210_000_001 / 300_000_000, status: "warn",
    });
  });
  it("warns on an exceededCpu outcome below the p99 threshold", () => {
    const rows = [...scheduledRows("16 * * * *", 100, 1_000_000), ...scheduledRows("16 * * * *", 1, 2_000_000, "exceededCpu")];
    expect(headroom(rows).triggers[0]).toMatchObject({ samples: 101, exceededCpu: 1, status: "warn", reason: "cpu-exceeded-cpu-observed" });
  });
  it("reports small-N triggers without a headroom verdict", () => {
    expect(headroom(scheduledRows("0 8 * * *", 3, 500_000)).triggers[0]).toMatchObject({
      samples: 3, p99Us: 500_000, status: "insufficient-samples", reason: "insufficient-samples",
    });
    expect(headroom(scheduledRows("0 8 * * *", 1, 240_000_000)).triggers[0]).toMatchObject({
      samples: 1, p99Ratio: 240_000_000 / 300_000_000, status: "insufficient-samples", reason: "insufficient-samples",
    });
    expect(headroom(scheduledRows("0 8 * * *", 1, 1_000_000, "exceededCpu")).triggers[0]).toMatchObject({
      samples: 1, exceededCpu: 1, status: "warn", reason: "cpu-exceeded-cpu-observed",
    });
  });
  it("never reports an aggregate ok while a trigger has no headroom verdict", () => {
    expect(headroom(scheduledRows("55 */2 * * *", 12, 1_000_000)).status).toBe("unavailable");
    expect(headroom(scheduledRows("0 8 * * *", 20, 1_000_000)).status).toBe("ok");
  });
  it("never reports ok for partial or unclassifiable CPU evidence", () => {
    expect(headroom(scheduledRows("16 * * * *", 50, 1_000_000), false).triggers[0]).toMatchObject({ samples: 50, status: "unavailable", reason: "scheduled-source-incomplete" });
    expect(headroom([]).triggers[0]).toMatchObject({ samples: 0, p99Us: null, status: "unavailable", reason: "scheduled-rows-absent" });
    expect(headroom(scheduledRows("every hour", 50, 1000)).triggers[0]).toMatchObject({ cpuClass: null, limitUs: null, p99Ratio: null, status: "unavailable", reason: "cpu-class-unknown" });
  });
  it("compares the highest sampled role/day memory p99 with the isolate limit", () => {
    const memory = (memoryP99: number | null, queryComplete = true) => buildCapacityHeadroom({
      roleDays: [roleDay("heavy", memoryP99, queryComplete), roleDay("public", null)], scheduled: [],
    }).memory[0]!;
    expect(memory(1048576)).toMatchObject({ p99Bytes: 1048576, limitBytes: WORKER_CAPACITY_POLICY.memoryLimitBytes, status: "ok", reason: null });
    expect(memory(Math.floor(0.7 * WORKER_CAPACITY_POLICY.memoryLimitBytes))).toMatchObject({ status: "ok" });
    expect(memory(90 * 1048576)).toMatchObject({ status: "warn", reason: "memory-p99-over-warn-threshold" });
    expect(memory(null)).toMatchObject({ p99Bytes: null, p99Ratio: null, status: "unavailable", reason: "memory-p99-unavailable" });
    expect(memory(90 * 1048576, false)).toMatchObject({ p99Bytes: null, status: "unavailable" });
    expect(memory(90 * 1048576).basis).toBe("max-of-cloudflare-sampled-role-day-p99");
  });
  it("keeps memory unavailable when one expected role/day read failed", () => {
    const capacity = buildCapacityHeadroom({
      roleDays: [
        { ...roleDay("heavy", null, false), from: "2026-10-13T00:00:00Z", to: "2026-10-14T00:00:00Z" },
        roleDay("heavy", 1048576),
        roleDay("public", 1048576),
      ],
      scheduled: [],
    });
    expect(capacity.memory[0]).toMatchObject({
      p99Bytes: 1048576, status: "unavailable", reason: "role-day-source-incomplete",
    });
  });
  it("keeps a warning visible when a sibling role/day read failed", () => {
    const capacity = buildCapacityHeadroom({
      roleDays: [
        { ...roleDay("heavy", null, false), from: "2026-10-13T00:00:00Z", to: "2026-10-14T00:00:00Z" },
        roleDay("heavy", 90 * 1048576),
        roleDay("public", 1048576),
      ],
      scheduled: [],
    });
    expect(capacity.memory[0]).toMatchObject({ status: "warn", reason: "memory-p99-over-warn-threshold" });
  });
  it("renders unavailable evidence instead of a zero statistic", () => {
    const markdown = renderCapacityMarkdown(buildCapacityHeadroom({
      roleDays: [roleDay("heavy", null), roleDay("public", null)],
      scheduled: [{ workerRole: "heavy", rows: [], complete: false }],
    }), reportWindow);
    expect(markdown).toContain("| Role | Cron trigger |");
    expect(markdown).toContain("| heavy | all triggers | unknown | 0 | unavailable | unavailable | unavailable | unavailable | unavailable | 0 | unavailable (scheduled-source-incomplete) |");
    expect(markdown).not.toContain("0.00");
  });
  it("retains the capacity verdict and its summary with the other evidence files", async () => {
    const report = await capture([adaptive()]);
    expect(report.outputFiles).toContain("capacity.md");
    expect(report.capacity.triggers.map((row) => row.cron)).toContain("16 * * * *");
    expect(renderWorkerMemoryMarkdown(report)).toContain(`Capacity headroom: **${report.capacity.status}**`);
    const dir = await mkdtemp(join(tmpdir(), "worker-memory-capacity-"));
    try {
      await writeWorkerMemoryReport(report, dir);
      const summary = await readFile(join(dir, "capacity.md"), "utf8");
      expect(summary).toContain("## Worker capacity headroom");
      expect(summary).toContain("| heavy | 16 * * * * | hourly-or-longer |");
      expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).capacity).toEqual(report.capacity);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(["warn", "ok", "unavailable"] as const)("maps a %s verdict onto the issue decision", async (status) => {
    const report = await capture([adaptive()]);
    report.capacity.status = status;
    report.window = { ...report.window, mode: "default" };
    const root = await mkdtemp(join(tmpdir(), "worker-memory-capacity-verdict-"));
    try {
      await writeWorkerMemoryReport(report, join(root, "worker-memory"));
      expect(runWorkflowDecision("Capacity headroom", root, { EVENT_NAME: "schedule" }).stdout).toBe(status);
      expect(runWorkflowDecision("Capacity headroom", root, { EVENT_NAME: "workflow_dispatch" }).stdout).toBe("report-only");
      report.window = { ...report.window, mode: "explicit" };
      await writeWorkerMemoryReport(report, join(root, "worker-memory"));
      expect(runWorkflowDecision("Capacity headroom", root, { EVENT_NAME: "schedule" }).stdout).toBe("report-only");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("memory operator and evidence-retaining workflow", () => {
  it("exits 1 after retaining reports on runtime unavailability and exits 2 for usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "worker-memory-cli-"));
    const env = { ...process.env };
    delete env.CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN;
    delete env.CLOUDFLARE_ACCOUNT_ID;
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/maintenance/monitor-worker-memory.ts"), "--from", from, "--to", to, "--out-dir", dir], { env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(1);
      expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).verdict.collectionIncomplete).toBe(true);
      const invalid = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/maintenance/monitor-worker-memory.ts"), "--unknown"], { env, encoding: "utf8" });
      expect(invalid.status).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(["default", "explicit"] as const)("gates stale %s coverage in the workflow without calling it incomplete", async (mode) => {
    const args = parseWorkerMemoryArgs(mode === "default" ? [] : ["--from", from, "--to", to], now);
    const report = await collectWorkerMemory({ ...options(), ...args, fetchImpl: emptyFetch() });
    report.verdict = evaluateMemoryObservation(report, new Date(Date.parse(report.window.to) + 8100_001));
    const root = await mkdtemp(join(tmpdir(), "worker-memory-verdict-"));
    try {
      await writeWorkerMemoryReport(report, join(root, "worker-memory"));
      const result = runWorkflowVerdict("Collection incomplete", root, mode === "default" ? "failure" : "success");
      expect(result.status, result.stderr).toBe(mode === "default" ? 1 : 0);
      expect(result.stderr).not.toContain("collection-incomplete");
      if (mode === "default") expect(result.stderr).toContain("::error::coverage-stale;");
      else expect(result.stderr).toBe("");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("includes only alert-window heavy lanes in the heavy-kill annotation", async () => {
    const report = await capture([adaptive()]);
    const kill = report.exceededMemory.groups[0]!;
    report.exceededMemory.groups.unshift(
      { ...kill, workerRole: "public", lane: { ...kill.lane!, cron: "public-lane" } },
      { ...kill, adaptive: { ...kill.adaptive, dimensions: { ...kill.adaptive.dimensions, datetime: "2026-10-13T00:00:00Z" } }, lane: { ...kill.lane!, cron: "old-lane" } },
    );
    const root = await mkdtemp(join(tmpdir(), "worker-memory-annotation-"));
    try {
      await writeWorkerMemoryReport(report, join(root, "worker-memory"));
      const result = runWorkflowVerdict("Heavy kill observed", root, "failure");
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("lane=16 * * * * schedule=halfHourlyChartsOffset correlation=unique-singleton requests=1");
      expect(result.stderr).not.toContain("public-lane");
      expect(result.stderr).not.toContain("old-lane");
      const collection = runWorkflowVerdict("Collection incomplete", root, "failure");
      expect(collection.status, collection.stderr).toBe(0);
      kill.lane!.cron = "bad::lane\n%0A::error::injected";
      await writeWorkerMemoryReport(report, join(root, "worker-memory"));
      const sanitized = runWorkflowVerdict("Heavy kill observed", root, "failure");
      expect(sanitized.stderr).toContain("lane=bad: :lane %250A: :error: :injected");
      expect(sanitized.stderr.match(/::error::/g)).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("uploads retained evidence before distinct always-running incident verdicts", () => {
    const workflow = parseYaml(readFileSync(".github/workflows/worker-memory-monitor.yml", "utf8"));
    const steps = workflow.jobs.memory.steps;
    const collection = steps.findIndex((step: { id?: string }) => step.id === "collect");
    const upload = steps.findIndex((step: { uses?: string }) => step.uses?.startsWith("actions/upload-artifact@"));
    const capacity = steps.findIndex((step: { name?: string }) => step.name === "Capacity headroom");
    const heavy = steps.findIndex((step: { name?: string }) => step.name === "Heavy kill observed");
    const incomplete = steps.findIndex((step: { name?: string }) => step.name === "Collection incomplete");
    expect(steps[collection]["continue-on-error"]).toBe(true);
    expect(upload).toBeGreaterThan(collection);
    expect(capacity).toBeGreaterThan(upload);
    expect(heavy).toBeGreaterThan(capacity);
    expect(incomplete).toBeGreaterThan(heavy);
    for (const index of [upload, capacity, heavy, incomplete]) expect(steps[index].if).toContain("always()");
    expect(steps[upload].with["retention-days"]).toBe(30);
    expect(steps[upload].with.path).toContain("capacity.md");
    expect(steps[capacity].env?.EVENT_NAME).toBe("${{ github.event_name }}");
    expect(steps[capacity].run).toContain(">> \"$GITHUB_STEP_SUMMARY\"");
    expect(workflow.jobs.memory.permissions).toMatchObject({ contents: "read", issues: "write" });
    expect(workflow.permissions.issues).toBeUndefined();
    for (const [index, step] of steps.entries()) if (index !== collection) expect(step.env?.CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN).toBeUndefined();
    expect(workflow.jobs.memory.if).toContain("refs/heads/main");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });
});
