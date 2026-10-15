import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { collectWorkerMemory, evaluateMemoryObservation, joinScheduledMemory, parseWorkerMemoryArgs, renderWorkerMemoryMarkdown, resolveWorkerMemoryWindow, writeWorkerMemoryReport } from "../monitor-worker-memory";
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
async function capture(rows: unknown[], scheduledRows: unknown[] = [scheduled]) {
  return collectWorkerMemory({ ...options(), fetchImpl: injectedFetch((query, variables) => {
    const isScheduled = query.includes("workersInvocationsScheduled");
    const selected = isScheduled ? scheduledRows : query.includes('status:"exceededMemory"') ? rows : [];
    return response(isScheduled ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", selected.filter((value) => {
      const row = value as { datetime?: string; dimensions?: { datetime: string; scriptName: string } };
      const datetime = row.datetime ?? row.dimensions?.datetime;
      return (!row.dimensions || row.dimensions.scriptName === variables.s) && (!isScheduled || variables.s === "stablecoin-heavy") && datetime !== undefined && Date.parse(datetime) >= Date.parse(variables.f) && Date.parse(datetime) < Date.parse(variables.t);
    }));
  }) });
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
    const result = joinScheduledMemory([row], [{ ...scheduled, cron: "52 * * * *", scheduledDatetime: "2026-10-14T00:52:37Z" }], "heavy")[0]!;
    expect(result.lane).toMatchObject({ expectedJob: "compute-safety-score-v9", jobBasis: "registry-plan", executionConfirmed: false, slotStartedAt: Date.parse("2026-10-14T00:52:00Z") / 1000 });
    expect(joinScheduledMemory([row], [{ ...scheduled, cron: "unknown" }], "heavy")[0]?.correlation).toBe("registry-unmapped");
    expect(joinScheduledMemory([row], [{ ...scheduled, cron: "10 * * * *" }], "heavy")[0]?.correlation).toBe("registry-owner-mismatch");
  });
  it("keeps the October 15 public DEX fixture report-only and unattributed without Scheduled evidence", async () => {
    const report = await collectWorkerMemory({ ...options(), from: "2026-10-15T00:00:00Z", to: "2026-10-16T00:00:00Z", now: new Date("2026-10-16T00:15:00Z"), fetchImpl: injectedFetch((query, variables) => response(query.includes("workersInvocationsScheduled") ? "workersInvocationsScheduled" : "workersInvocationsAdaptive", query.includes('status:"exceededMemory"') && variables.s === "stablecoin-api" && variables.f <= "2026-10-15T05:10:15Z" && variables.t > "2026-10-15T05:10:15Z" ? [fixtures.adaptive[1]] : [])) });
    expect(report.exceededMemory.groups).toHaveLength(1);
    expect(report.exceededMemory.groups[0]?.lane).toBeNull();
    expect(report.verdict).toMatchObject({ status: "observed-kills", heavyKillObserved: false, collectionIncomplete: false, exitCode: 0, knownPublicRequests: 1 });
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
  it("uses exact trailing-window and freshness boundaries without making historical events fresh", async () => {
    const report = await capture([adaptive()]);
    const boundary = new Date(Date.parse(report.window.to) + 8100_000);
    expect(evaluateMemoryObservation({ ...report, generatedAt: boundary.toISOString() }, boundary).collectionIncomplete).toBe(false);
    expect(evaluateMemoryObservation({ ...report, generatedAt: boundary.toISOString() }, new Date(boundary.getTime() + 1)).reasons).toContain("coverage-stale");
    const age = new Date(Date.parse(report.generatedAt) + 7200_000);
    expect(evaluateMemoryObservation({ ...report, window: { ...report.window, to: age.toISOString() } }, age).reasons).not.toContain("report-stale");
    expect(evaluateMemoryObservation(report, new Date(age.getTime() + 1)).reasons).toContain("report-stale");
    const event = Date.parse(scheduled.datetime);
    expect(evaluateMemoryObservation({ ...report, window: { ...report.window, to: new Date(event + 86400_000).toISOString() } }, now).heavyKillObserved).toBe(true);
    expect(evaluateMemoryObservation({ ...report, window: { ...report.window, to: new Date(event + 86400_000 + 1).toISOString() } }, now).heavyKillObserved).toBe(false);
  });
});

describe("memory operator and evidence-retaining workflow", () => {
  it("validates paired bounded timezone-qualified arguments before effects", () => {
    expect(parseWorkerMemoryArgs(["--help"], now)).toEqual({ help: true });
    expect(resolveWorkerMemoryWindow(undefined, undefined, now)).toEqual({ from: "2026-10-14T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" });
    for (const argv of [["--account-id", "x"], ["--from", from], ["--from", from, "--from", from, "--to", to], ["--from", "2026-10-14", "--to", to], ["--from", to, "--to", from], ["--from", "2026-10-12T00:00:00Z", "--to", to]]) expect(() => parseWorkerMemoryArgs(argv, now)).toThrow();
  });
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
  it("uploads retained evidence before distinct always-running incident verdicts", () => {
    const workflow = parseYaml(readFileSync(".github/workflows/worker-memory-monitor.yml", "utf8"));
    const steps = workflow.jobs.memory.steps;
    const collection = steps.findIndex((step: { id?: string }) => step.id === "collect");
    const upload = steps.findIndex((step: { uses?: string }) => step.uses?.startsWith("actions/upload-artifact@"));
    const heavy = steps.findIndex((step: { name?: string }) => step.name === "Heavy kill observed");
    const incomplete = steps.findIndex((step: { name?: string }) => step.name === "Collection incomplete");
    expect(steps[collection]["continue-on-error"]).toBe(true);
    expect(upload).toBeGreaterThan(collection);
    expect(heavy).toBeGreaterThan(upload);
    expect(incomplete).toBeGreaterThan(heavy);
    for (const index of [upload, heavy, incomplete]) expect(steps[index].if).toContain("always()");
    expect(steps[upload].with["retention-days"]).toBe(30);
    for (const [index, step] of steps.entries()) if (index !== collection) expect(step.env?.CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN).toBeUndefined();
    expect(workflow.jobs.memory.if).toContain("refs/heads/main");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });
});
