import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  createGitHubClient,
  firstActionableError,
  reportWorkflowFailure,
  sendOpsAlert,
  type GitHubClient,
  type WorkflowReport,
  type WorkflowIssue,
  type WorkflowJob,
} from "../ci/report-workflow-failure";

function fixture() {
  const issues: WorkflowIssue[] = [];
  const jobs: WorkflowJob[] = [
    { id: 10, name: "full-static", conclusion: "failure", steps: [{ name: "Typed lint", conclusion: "failure" }] },
  ];
  const github: GitHubClient = {
    listIssues: vi.fn(async () => issues.map((issue) => ({ ...issue }))),
    listJobs: vi.fn(async () => jobs),
    latestGreenRun: vi.fn(async () => null),
    jobLog: vi.fn(async () => "2026-10-08T04:00:00Z Error: unsupported lint glob\nfunctions/**/*.tsx"),
    createIssue: vi.fn(async (_title: string, body: string) => {
      const issue = { number: issues.length + 1, state: "open" as const, body, html_url: `https://github.com/org/repo/issues/${issues.length + 1}` };
      issues.push(issue);
      return issue;
    }),
    updateIssue: vi.fn(async (number, patch) => { Object.assign(issues.find((issue) => issue.number === number)!, patch); }),
    comment: vi.fn(async () => {}),
  };
  const report: WorkflowReport = {
    workflowFile: "nightly-validation.yml", workflowName: "Nightly Validation",
    runUrl: "https://github.com/org/repo/actions/runs/100/attempts/1", runNumber: 10, runAttempt: 1,
    ref: "refs/heads/main", event: "schedule", needs: { "full-static": { result: "failure" } }, jobNames: {}, allowedSkips: [],
  };
  return { github, report, issues, jobs, alert: vi.fn(async () => {}) };
}

afterEach(() => vi.unstubAllGlobals());

describe("workflow incident lifecycle", () => {
  it("opens a stable workflow+job+step incident and alerts once on the first failure", async () => {
    const f = fixture();
    expect(await reportWorkflowFailure(f.report, f.github, f.alert)).toMatchObject({ opened: 1, alerted: true });
    expect(f.github.createIssue).toHaveBeenCalledOnce();
    expect(f.issues[0].body).toContain("pharos-workflow-incident:v1:nightly-validation.yml:full-static:Typed%20lint");
    expect(f.issues[0].body).toContain("Error: unsupported lint glob");
    expect(f.alert).toHaveBeenCalledOnce();
  });

  it("comments and updates, rather than creating or alerting, on repeats", async () => {
    const f = fixture();
    await reportWorkflowFailure(f.report, f.github, f.alert);
    f.report.runNumber++;
    f.report.runUrl = "https://github.com/org/repo/actions/runs/101/attempts/1";
    expect(await reportWorkflowFailure(f.report, f.github, f.alert)).toMatchObject({ opened: 0, repeated: 1, alerted: false });
    expect(f.github.createIssue).toHaveBeenCalledOnce();
    expect(f.github.comment).toHaveBeenLastCalledWith(1, expect.stringContaining(f.report.runUrl));
    expect(f.github.comment).toHaveBeenLastCalledWith(1, expect.stringContaining("unsupported lint glob"));
    expect(f.alert).toHaveBeenCalledOnce();
  });

  it("does not alert when another job starts failing while the workflow is already red", async () => {
    const f = fixture();
    await reportWorkflowFailure(f.report, f.github, f.alert);
    f.report.needs = { "full-static": { result: "success" }, tests: { result: "failure" } };
    f.jobs.push({ id: 11, name: "tests (2/2)", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] });
    expect(await reportWorkflowFailure(f.report, f.github, f.alert)).toMatchObject({ opened: 1, alerted: false });
    expect(f.issues).toHaveLength(2);
    expect(f.alert).toHaveBeenCalledOnce();
  });

  it("closes every workflow incident only after full mandatory recovery", async () => {
    const f = fixture();
    await reportWorkflowFailure(f.report, f.github, f.alert);
    f.report.needs = { "full-static": { result: "success" }, tests: { result: "cancelled" } };
    expect((await reportWorkflowFailure(f.report, f.github, f.alert)).closed).toBe(0);
    f.report.needs.tests.result = "skipped";
    expect((await reportWorkflowFailure(f.report, f.github, f.alert)).closed).toBe(0);
    f.report.needs.tests.result = "success";
    expect((await reportWorkflowFailure(f.report, f.github, f.alert)).closed).toBe(1);
    expect(f.issues[0].state).toBe("closed");
    expect(f.github.comment).toHaveBeenLastCalledWith(1, expect.stringContaining("Recovered:"));
    expect(f.alert).toHaveBeenCalledOnce();
  });

  it("reopens the same issue and alerts on a new green-to-red transition", async () => {
    const f = fixture();
    await reportWorkflowFailure(f.report, f.github, f.alert);
    f.report.needs["full-static"].result = "success";
    await reportWorkflowFailure(f.report, f.github, f.alert);
    f.report.needs["full-static"].result = "failure";
    expect(await reportWorkflowFailure(f.report, f.github, f.alert)).toMatchObject({ opened: 1, alerted: true });
    expect(f.github.createIssue).toHaveBeenCalledOnce();
    expect(f.issues[0].state).toBe("open");
    expect(f.alert).toHaveBeenCalledTimes(2);
  });

  it("accepts only explicitly unselected skips, not cancellation or all-skipped runs", async () => {
    const f = fixture();
    await reportWorkflowFailure(f.report, f.github, f.alert);
    f.report.needs = { "full-static": { result: "success" }, render: { result: "skipped" } };
    f.report.allowedSkips = ["render"];
    expect((await reportWorkflowFailure(f.report, f.github, f.alert)).closed).toBe(1);
    f.report.needs["full-static"].result = "skipped";
    f.report.allowedSkips.push("full-static");
    expect((await reportWorkflowFailure(f.report, f.github, f.alert)).closed).toBe(0);
  });

  it.each(["pull_request", "pull_request_target", "workflow_call"])("never mutates issues for %s", async (event) => {
    const f = fixture();
    expect((await reportWorkflowFailure({ ...f.report, event }, f.github, f.alert)).ignored).toBe(true);
    expect(f.github.listIssues).not.toHaveBeenCalled();
  });

  it("ignores non-main dispatch and stale overlapping runs", async () => {
    const f = fixture();
    expect((await reportWorkflowFailure({ ...f.report, ref: "refs/heads/feature" }, f.github, f.alert)).ignored).toBe(true);
    await reportWorkflowFailure(f.report, f.github, f.alert);
    f.report.runNumber--;
    f.report.needs["full-static"].result = "success";
    expect((await reportWorkflowFailure(f.report, f.github, f.alert)).ignored).toBe(true);
    expect(f.issues[0].state).toBe("open");
  });

  it("ignores an older red run after a newer green run completed without any incident history", async () => {
    const f = fixture();
    const green = { ...f.report, runNumber: 11, needs: { "full-static": { result: "success" } } };
    expect(await reportWorkflowFailure(green, f.github, f.alert)).toMatchObject({ opened: 0, ignored: false });
    expect(f.issues).toEqual([]);
    // GitHub persists the completed workflow independently of incident issues.
    vi.mocked(f.github.latestGreenRun).mockResolvedValue({
      run_number: green.runNumber, run_attempt: green.runAttempt, event: "schedule",
      head_branch: "main", conclusion: "success",
    });
    expect(await reportWorkflowFailure(f.report, f.github, f.alert)).toMatchObject({ opened: 0, ignored: true, alerted: false });
    expect(f.github.createIssue).not.toHaveBeenCalled();
    expect(f.github.updateIssue).not.toHaveBeenCalled();
    expect(f.github.comment).not.toHaveBeenCalled();
    expect(f.alert).not.toHaveBeenCalled();
  });

  it("ignores an older attempt after a green rerun, but reports failures newer than the last green", async () => {
    const f = fixture();
    vi.mocked(f.github.latestGreenRun).mockResolvedValue({
      run_number: f.report.runNumber, run_attempt: 2, event: "workflow_dispatch",
      head_branch: "main", conclusion: "success",
    });
    expect((await reportWorkflowFailure(f.report, f.github, f.alert)).ignored).toBe(true);
    f.report.runNumber++;
    expect(await reportWorkflowFailure(f.report, f.github, f.alert)).toMatchObject({ opened: 1, alerted: true, ignored: false });
  });

  it("matches named matrix and reusable workflow leaves and excludes advisory jobs", async () => {
    const f = fixture();
    f.report.needs = { "full-tests": { result: "failure" }, "pages-release": { result: "failure" } };
    f.report.jobNames = { "full-tests": "Full test suite" };
    f.jobs.push(
      { id: 11, name: "Full test suite (2/2)", conclusion: "failure", steps: [{ name: "Run suite", conclusion: "failure" }] },
      { id: 12, name: "pages-release / pages-release", conclusion: "failure", steps: [{ name: "Build export", conclusion: "failure" }] },
      { id: 13, name: "Node 26 advisory typecheck compatibility", conclusion: "failure" },
    );
    expect((await reportWorkflowFailure(f.report, f.github, f.alert)).opened).toBe(2);
    expect(f.issues.some((issue) => issue.body?.includes("Node 26"))).toBe(false);
    expect(f.alert).toHaveBeenCalledOnce();
  });

  it("retains a visible issue if logs or alert credentials are unavailable", async () => {
    const f = fixture();
    vi.mocked(f.github.jobLog).mockRejectedValue(new Error("logs expired"));
    await expect(reportWorkflowFailure(f.report, f.github, (message) => sendOpsAlert(message, undefined, undefined)))
      .rejects.toThrow("TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID");
    expect(f.issues).toHaveLength(1);
    expect(f.issues[0].body).toContain("Job log unavailable");
    expect(f.issues[0].body).toContain('"reason":"job-log-unavailable"');
    expect(f.issues[0].body).not.toContain("No actionable error line retained");
  });

  it("preserves unavailable log evidence on every failed step and on repeat comments", async () => {
    const f = fixture();
    f.jobs[0].steps!.push({ name: "Typecheck", conclusion: "failure" });
    vi.mocked(f.github.jobLog).mockRejectedValue(new Error("logs expired; private provider detail"));
    expect(await reportWorkflowFailure(f.report, f.github, f.alert)).toMatchObject({ opened: 2, alerted: true });
    for (const issue of f.issues) {
      const evidence = JSON.parse(issue.body!.match(/```json\n([^\n]+)\n```/)![1]);
      expect(evidence).toEqual({ status: "unavailable", reason: "job-log-unavailable" });
      expect(issue.body).toContain(f.report.runUrl);
      expect(issue.body).not.toContain("No actionable error line retained");
      expect(issue.body).not.toContain("private provider detail");
    }
    expect(f.alert).toHaveBeenCalledWith(expect.stringContaining("reason: job-log-unavailable"));
    f.report.runNumber++;
    f.report.runUrl = "https://github.com/org/repo/actions/runs/101/attempts/1";
    expect(await reportWorkflowFailure(f.report, f.github, f.alert)).toMatchObject({ repeated: 2, alerted: false });
    for (const [, comment] of vi.mocked(f.github.comment).mock.calls) {
      expect(comment).toContain('"reason":"job-log-unavailable"');
      expect(comment).toContain(f.report.runUrl);
      expect(comment).not.toContain("No actionable error line retained");
    }
  });

  it.each(["", "Process completed with exit code 1."])(
    "does not claim retrieved logs are unavailable when no actionable error was retained: %j",
    async (log) => {
      const f = fixture();
      vi.mocked(f.github.jobLog).mockResolvedValue(log);
      await reportWorkflowFailure(f.report, f.github, f.alert);
      expect(f.issues[0].body).toContain("No actionable error line retained");
      expect(f.issues[0].body).not.toContain("job-log-unavailable");
    },
  );

  it("records pre-step runner failure without inventing a log excerpt", async () => {
    const f = fixture();
    f.jobs.length = 0;
    await reportWorkflowFailure(f.report, f.github, f.alert);
    expect(f.issues[0].body).toContain("Job failed before a failed step was available");
  });
});

describe("composite action entrypoint", () => {
  it("executes the action's reporting command and refuses a non-main event without network mutation", () => {
    const action = parseYaml(readFileSync(".github/actions/report-workflow-failure/action.yml", "utf8"));
    const reportingStep = action.runs.steps.find((step: { run?: string }) => typeof step.run === "string");
    expect(reportingStep).toBeDefined();
    const run = spawnSync("bash", ["-e", "-o", "pipefail", "-c", reportingStep.run], {
      encoding: "utf8",
      env: {
        ...process.env, WORKFLOW_FILE: "nightly-validation.yml", GITHUB_WORKFLOW: "Nightly Validation",
        GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "org/repo", GITHUB_RUN_ID: "100",
        GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_NUMBER: "10", GITHUB_REF: "refs/heads/feature",
        GITHUB_EVENT_NAME: "pull_request", WORKFLOW_NEEDS: '{"full-static":{"result":"failure"}}',
        GH_TOKEN: "not-a-real-token", GITHUB_STEP_SUMMARY: "",
      },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ignored: true, alerted: false, opened: 0 });
  });
});

describe("incident provider boundaries", () => {
  it("extracts the first actionable command output after the Actions command group closes", () => {
    const log = "2026-10-08T04:00:00Z ##[group]Run npm test\ncommand\n##[endgroup]\nError: assertion mismatch\nexpected 4\n##[error]Process completed with exit code 1.\n##[group]Cleanup";
    expect(firstActionableError(log, "Run npm test")).toContain("assertion mismatch");
    expect(firstActionableError("##[error]Process completed with exit code 1.", "Test")).toContain("No actionable error");
  });

  it("scopes excerpts to each failed step's API timing rather than recycling earlier errors", () => {
    const log = [
      "2026-10-08T04:00:00Z Error: earlier lint failure",
      "2026-10-08T04:02:00Z ##[group]Run typecheck",
      "2026-10-08T04:02:00Z throw new Error('echoed script, not output')",
      "2026-10-08T04:02:00Z ##[endgroup]",
      "2026-10-08T04:02:01Z Error: later typecheck failure",
    ].join("\n");
    const excerpt = firstActionableError(log, "Typecheck", {
      started_at: "2026-10-08T04:02:00Z", completed_at: "2026-10-08T04:02:02Z",
    });
    expect(excerpt).toContain("later typecheck failure");
    expect(excerpt).not.toContain("earlier lint failure");
    expect(excerpt).not.toContain("echoed script");
  });

  it("uses the existing private Telegram destination and verifies Bot API acceptance", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    await sendOpsAlert("run failed", "bot-credential", "private-ops-chat");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botbot-credential/sendMessage");
    const options = vi.mocked(fetch).mock.calls[0][1];
    expect(JSON.parse(String(options?.body))).toMatchObject({ chat_id: "private-ops-chat", text: "run failed" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false })));
    await expect(sendOpsAlert("fail", "bot-credential", "private-ops-chat")).rejects.toThrow("rejected");
  });

  it.each([404, 410])("keeps unavailable job logs distinct from successful empty logs for HTTP %s", async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("logs unavailable", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubClient("org/repo", "123", "test-token");
    const f = fixture();
    f.github.jobLog = client.jobLog;
    await reportWorkflowFailure(f.report, f.github, f.alert);
    expect(f.issues[0].body).toContain('"status":"unavailable","reason":"job-log-unavailable"');
    expect(f.issues[0].body).not.toContain("No actionable error line retained");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/org/repo/actions/jobs/10/logs");
  });

  it("paginates issues and current jobs through read-only GitHub API requests", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })))))
      .mockResolvedValueOnce(new Response("[]"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] })));
    const client = createGitHubClient("org/repo", "123", "test-token");
    expect(await client.listIssues()).toHaveLength(100);
    expect(await client.listJobs()).toEqual([]);
    expect(fetchMock.mock.calls[1][0]).toContain("page=2");
    expect(fetchMock.mock.calls[2][0]).toContain("filter=latest");
  });

  it("uses completed successful main runs as the durable watermark and excludes non-main or PR runs", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: [
      { run_number: 14, run_attempt: 1, event: "pull_request", head_branch: "main", conclusion: "success" },
      { run_number: 13, run_attempt: 1, event: "workflow_dispatch", head_branch: "feature", conclusion: "success" },
      { run_number: 12, run_attempt: 1, event: "schedule", head_branch: "main", conclusion: "failure" },
      { run_number: 11, run_attempt: 2, event: "schedule", head_branch: "main", conclusion: "success" },
    ] })));
    const client = createGitHubClient("org/repo", "123", "test-token");
    expect(await client.latestGreenRun("nightly-validation.yml")).toMatchObject({ run_number: 11, run_attempt: 2 });
    const [url, options] = fetchMock.mock.calls[0];
    const requested = new URL(String(url));
    expect(requested.pathname).toBe("/repos/org/repo/actions/workflows/nightly-validation.yml/runs");
    expect(requested.searchParams.get("branch")).toBe("main");
    expect(requested.searchParams.get("status")).toBe("success");
    expect(options?.method).toBe("GET");
  });
});

describe("workflow reporting wiring", () => {
  const mandatory: Record<string, string[]> = {
    "nightly-validation.yml": ["full-static", "full-tests"],
    "weekly-validation.yml": ["audit", "html-fixture-age", "gitleaks", "all-critical-ratchet", "telegram-load", "compare-account-state", "dependency-coverage"],
    "dependency-scenarios-refresh.yml": ["scenarios"],
    "safety-map-refresh.yml": ["plan", "render"],
    "curation-expiry-sweep.yml": ["sweep"],
    "protocol-api-mechanism-refresh.yml": ["refresh"],
    "deploy-cloudflare.yml": ["plan", "deploy-worker", "pages-prepare", "pages-release", "post-deploy-acceptance"],
    "rebuild-pages.yml": ["pages-prepare", "pages-release"],
  };
  it.each(Object.entries(mandatory))("reports all mandatory jobs in %s", (file, jobs) => {
    const workflow = parseYaml(readFileSync(`.github/workflows/${file}`, "utf8"));
    const report = workflow.jobs["report-failures"];
    expect(report.needs).toEqual(jobs);
    expect(report.if).toContain("always()");
    expect(report.if).toContain("github.ref == 'refs/heads/main'");
    expect(report.if).toContain("github.event_name == 'schedule'");
    expect(report.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(report.permissions).toEqual({ contents: "read", actions: "read", issues: "write" });
    expect(workflow.permissions?.issues).toBeUndefined();
    const action = report.steps.find((step: { uses?: string }) => step.uses === "$/.github/actions/report-workflow-failure");
    expect(action.with["needs-json"]).toBe("${{ toJSON(needs) }}");
    expect(action.with["workflow-file"]).toBe(file);
    expect(action.with["telegram-bot-token"]).toBe("${{ secrets.TELEGRAM_BOT_TOKEN }}");
    expect(action.with["telegram-operator-chat-id"]).toBe("${{ secrets.TELEGRAM_OPERATOR_CHAT_ID }}");
    expect(report.concurrency["cancel-in-progress"]).toBe(false);
    for (const step of report.steps) expect(step.run).toBeUndefined();
  });

  it("passes expressions only through action env and keeps setup pinned and dependency-free", () => {
    const action = parseYaml(readFileSync(".github/actions/report-workflow-failure/action.yml", "utf8"));
    for (const step of action.runs.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      if (step.run) {
        expect(step.run).not.toContain("${{");
      }
    }
  });
});
