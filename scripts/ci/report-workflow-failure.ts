#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { runDirectCli } from "../lib/cli-args.mjs";

export interface WorkflowIssue {
  number: number;
  state: "open" | "closed";
  body: string | null;
  html_url: string;
  pull_request?: unknown;
}
export interface WorkflowStep {
  name: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}
export interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: WorkflowStep[];
}
export interface GitHubClient {
  listIssues(): Promise<WorkflowIssue[]>;
  listJobs(): Promise<WorkflowJob[]>;
  jobLog(jobId: number): Promise<string>;
  createIssue(title: string, body: string): Promise<WorkflowIssue>;
  updateIssue(number: number, patch: { state?: "open" | "closed"; body?: string }): Promise<void>;
  comment(number: number, body: string): Promise<void>;
}
export interface WorkflowReport {
  workflowFile: string;
  workflowName: string;
  runUrl: string;
  runNumber: number;
  runAttempt: number;
  ref: string;
  event: string;
  needs: Record<string, { result: string; outputs?: Record<string, string> }>;
  jobNames: Record<string, string>;
  allowedSkips: string[];
}

function workflowMarker(file: string): string {
  return `<!-- pharos-workflow:${encodeURIComponent(file)} -->`;
}
function incidentMarker(file: string, job: string, step: string): string {
  return `<!-- pharos-workflow-incident:v1:${encodeURIComponent(file)}:${encodeURIComponent(job)}:${encodeURIComponent(step)} -->`;
}
function sequence(report: WorkflowReport): string {
  return `<!-- pharos-workflow-run:${report.runNumber}:${report.runAttempt} -->`;
}
function newerThanReport(issue: WorkflowIssue, report: WorkflowReport): boolean {
  const match = issue.body?.match(/<!-- pharos-workflow-run:(\d+):(\d+) -->/);
  return !!match && (Number(match[1]) > report.runNumber
    || (Number(match[1]) === report.runNumber && Number(match[2]) > report.runAttempt));
}
function safeText(text: string): string {
  return text.replaceAll("```", "'''").replaceAll("@", "＠");
}

/** Prefer the first substantive error over the generic runner exit wrapper. */
export function firstActionableError(log: string, step: string, timing?: Pick<WorkflowStep, "started_at" | "completed_at">): string {
  const start = timing?.started_at ? Date.parse(timing.started_at) : NaN;
  const end = timing?.completed_at ? Date.parse(timing.completed_at) + 999 : NaN;
  let commandGroup = false;
  const lines = log.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)
    .filter((line) => {
      const timestamp = line.match(/^(\d{4}-\d\d-\d\dT\S+)\s+/)?.[1];
      if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
      if (!timestamp) return false;
      const time = Date.parse(timestamp);
      return time >= start && time <= end;
    })
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, ""))
    .filter((line) => {
      // Ignore echoed script/env source, not the real output after endgroup.
      if (line.includes("##[group]Run ")) { commandGroup = true; return false; }
      if (commandGroup) {
        if (line.includes("##[endgroup]")) commandGroup = false;
        return false;
      }
      return true;
    });
  const index = lines.findIndex((line) => /(?:##\[error\]|\berror\b|\bfail(?:ed|ure)?\b|exception|assertion|SQLITE_|ENOENT|unsupported|exceeded|timed? ?out|vulnerabilit|TS\d{4})/i.test(line)
    && !/Process completed with exit code|Error: Process completed|##\[group\]|^Run /i.test(line));
  if (index < 0) return `No actionable error line retained for step: ${step}. Inspect the linked job log.`;
  return safeText(lines.slice(index, index + 5).join("\n").slice(0, 1800));
}

/** Issue bodies are the durable transition state; serial reporting jobs prevent races. */
export async function reportWorkflowFailure(
  report: WorkflowReport,
  github: GitHubClient,
  alert: (message: string) => Promise<void>,
): Promise<{ opened: number; repeated: number; closed: number; alerted: boolean; ignored: boolean }> {
  const result = { opened: 0, repeated: 0, closed: 0, alerted: false, ignored: false };
  if (report.ref !== "refs/heads/main" || !["push", "schedule", "workflow_dispatch"].includes(report.event)) {
    return { ...result, ignored: true };
  }
  if (Object.keys(report.needs).length === 0) throw new Error("Reporting requires mandatory job results");
  const issues = (await github.listIssues()).filter((issue) => !issue.pull_request
    && issue.body?.includes(workflowMarker(report.workflowFile)));
  // An older overlapping run must not undo a newer incident/recovery decision.
  if (issues.some((issue) => newerThanReport(issue, report))) return { ...result, ignored: true };
  const open = issues.filter((issue) => issue.state === "open");
  const failedIds = Object.entries(report.needs).filter(([, job]) => job.result === "failure").map(([id]) => id);
  const green = Object.entries(report.needs).every(([id, job]) => job.result === "success"
    || (job.result === "skipped" && report.allowedSkips.includes(id)))
    && Object.values(report.needs).some((job) => job.result === "success");
  if (green) {
    for (const issue of open) {
      await github.comment(issue.number, `Recovered: all mandatory jobs are green (only explicitly unselected jobs skipped).\n\nRun: ${report.runUrl}`);
      await github.updateIssue(issue.number, { state: "closed", body: `${issue.body ?? ""}`.replace(/<!-- pharos-workflow-run:\d+:\d+ -->/, sequence(report)) });
      result.closed++;
    }
    return result;
  }
  // Cancellation and unexplained skips are not a green recovery or a new failure.
  if (failedIds.length === 0) return result;
  const jobs = await github.listJobs();
  const failures: { job: string; step: string; excerpt: string }[] = [];
  for (const id of failedIds) {
    const name = report.jobNames[id] ?? id;
    const leaves = jobs.filter((job) => job.conclusion === "failure"
      && (job.name === name || job.name.startsWith(`${name} (`) || job.name.startsWith(`${name} / `)));
    if (leaves.length === 0) {
      failures.push({ job: id, step: "job", excerpt: "Job failed before a failed step was available. Inspect the linked run for runner/setup evidence." });
      continue;
    }
    for (const job of leaves) {
      const steps = job.steps?.filter((step) => step.conclusion === "failure") ?? [];
      let log: string;
      try { log = await github.jobLog(job.id); }
      catch { log = ""; }
      const failingSteps: WorkflowStep[] = steps.length ? steps : [{ name: "job", conclusion: "failure" }];
      for (const step of failingSteps) {
        failures.push({ job: job.name, step: step.name, excerpt: firstActionableError(log, step.name, step) });
      }
    }
  }
  const links: string[] = [];
  for (const failure of failures) {
    const marker = incidentMarker(report.workflowFile, failure.job, failure.step);
    const existing = issues.find((issue) => issue.body?.includes(marker));
    const body = `${workflowMarker(report.workflowFile)}\n${marker}\n${sequence(report)}\n\n# Workflow failure\n\nWorkflow: ${safeText(report.workflowName)} (\`${report.workflowFile}\`)\nJob: ${safeText(failure.job)}\nStep: ${safeText(failure.step)}\nRun: ${report.runUrl}\n\nFirst actionable error excerpt:\n\n\`\`\`text\n${failure.excerpt}\n\`\`\`\n\nCloses automatically after the next fully green mandatory run on main. Runbook: docs/runbooks/workflow-incidents.md\n`;
    if (existing) {
      await github.comment(existing.number, `Failure ${existing.state === "closed" ? "recurred" : "repeated"}: ${report.runUrl}\n\nFirst actionable error excerpt:\n\n\`\`\`text\n${failure.excerpt}\n\`\`\``);
      await github.updateIssue(existing.number, { state: "open", body });
      if (existing.state === "open") result.repeated++;
      else result.opened++;
      links.push(existing.html_url);
    } else {
      const issue = await github.createIssue(`[CI failure] ${safeText(report.workflowName)} / ${safeText(failure.job)} / ${safeText(failure.step)}`.slice(0, 240), body);
      result.opened++;
      links.push(issue.html_url);
    }
  }
  if (open.length === 0) {
    await alert(`Pharos CI turned red: ${report.workflowName}\n${report.runUrl}\n${links.join("\n")}\n${failures[0]?.excerpt ?? ""}`);
    result.alerted = true;
  }
  return result;
}

export function createGitHubClient(repository: string, runId: string, token: string): GitHubClient {
  const base = `https://api.github.com/repos/${repository}`;
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} returned HTTP ${response.status}`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  async function pages<T>(path: string, field?: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const data = await request<T[] | Record<string, T[]>>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const batch = field ? (data as Record<string, T[]>)[field] : data as T[];
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }
  return {
    listIssues: () => pages<WorkflowIssue>("/issues?state=all"),
    // filter=latest retains successful jobs from prior attempts on failed-job reruns.
    listJobs: () => pages<WorkflowJob>(`/actions/runs/${runId}/jobs?filter=latest`, "jobs"),
    jobLog: async (id) => {
      const response = await fetch(`${base}/actions/jobs/${id}/logs`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`GitHub job log returned HTTP ${response.status}`);
      return await response.text();
    },
    createIssue: (title, body) => request<WorkflowIssue>("/issues", "POST", { title, body }),
    updateIssue: async (number, patch) => { await request(`/issues/${number}`, "PATCH", patch); },
    comment: async (number, body) => { await request(`/issues/${number}/comments`, "POST", { body }); },
  };
}

export async function sendOpsAlert(message: string, token: string | undefined, chatId: string | undefined): Promise<void> {
  if (!token?.trim() || !chatId?.trim()) {
    throw new Error("Ops alert blocked: provision existing TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID as GitHub Actions secrets; incident issues were recorded.");
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message.slice(0, 4000), link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(30_000),
  });
  // Never include the Bot API URL or response body, which may contain credentials.
  if (!response.ok) throw new Error(`Ops Telegram alert returned HTTP ${response.status}`);
  const payload = await response.json() as { ok?: boolean };
  if (payload.ok !== true) throw new Error("Ops Telegram alert was rejected");
}

runDirectCli(import.meta.url, async () => {
  const env = process.env;
  const required = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`${name} is required`);
    return value;
  };
  const workflowFile = required("WORKFLOW_FILE");
  const report: WorkflowReport = {
    workflowFile,
    workflowName: required("GITHUB_WORKFLOW"),
    runUrl: `${required("GITHUB_SERVER_URL")}/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}/attempts/${required("GITHUB_RUN_ATTEMPT")}`,
    runNumber: Number(required("GITHUB_RUN_NUMBER")),
    runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
    ref: required("GITHUB_REF"),
    event: required("GITHUB_EVENT_NAME"),
    needs: JSON.parse(required("WORKFLOW_NEEDS")),
    jobNames: JSON.parse(env.WORKFLOW_JOB_NAMES || "{}"),
    allowedSkips: (env.WORKFLOW_ALLOWED_SKIPS || "").split(",").map((id) => id.trim()).filter(Boolean),
  };
  const github = createGitHubClient(required("GITHUB_REPOSITORY"), required("GITHUB_RUN_ID"), required("GH_TOKEN"));
  const outcome = await reportWorkflowFailure(report, github, (message) => sendOpsAlert(message, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_OPERATOR_CHAT_ID));
  console.log(JSON.stringify(outcome));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Workflow incident lifecycle\n\n\`\`\`json\n${JSON.stringify(outcome, null, 2)}\n\`\`\`\n`);
}, { label: "report-workflow-failure" });
