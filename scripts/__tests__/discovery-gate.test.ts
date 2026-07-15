import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GITLEAKS_LINUX_X64_TARBALL_SHA256, GITLEAKS_VERSION, runGitleaks } from "../ci/run-gitleaks.mjs";
import { checkWorkerPackage } from "../ci/check-worker-package.mjs";
import { buildDiscoveryPlan } from "../lib/discovery-gate.mjs";
import {
  collectDiscoveryChangedFiles,
  collectDiscoveryEnvironment,
  compareDiscoverySnapshots,
} from "../lib/discovery-evidence.mjs";
import { runGeneratedArtifacts } from "../maintenance/run-generated-artifacts.mjs";
import {
  executeDiscoveryGraph,
  runMergeGateDiscovery,
  selectResumeNodes,
} from "../maintenance/run-merge-gate-discovery.mjs";
import { runValidatePrebuild } from "../maintenance/run-validate-prebuild.mjs";
import { testEnv } from "../test-utils/ci-script-test-helpers";

function descriptor(id: string, command: string, phase: number, dependsOn: string[] = []) {
  return {
    blocking: true,
    command,
    dependsOn,
    failedDependencyPolicy: "block",
    id,
    lane: "test",
    order: phase * 10,
    phase,
    reason: "test",
    rerun: command,
  };
}

const matchingEnvironment = {
  architecture: "x64",
  bootstrap: { cleanInstallEquivalent: true, complete: true, missing: [], outputCount: 1 },
  browsers: { chromium: true, firefox: true },
  fingerprint: "environment-fingerprint",
  install: { consistentWithLockfile: true, lockfileSha256: "lock", snapshotSha256: "install" },
  node: { actual: "24.16.0", exactMatch: true, expected: "24.16.0" },
  operatingSystem: "linux",
  publicConfig: { hash: "public", keyCount: 0, profile: "offline" },
};

const stableSnapshot = {
  clean: true,
  fileHashes: { "docs/testing.md": "hash" },
  fingerprint: "snapshot-fingerprint",
  head: "abc123",
  statusHash: "status",
};

describe("discovery target planning", () => {
  it("selects the focused docs-only PR path plus Gitleaks", () => {
    const plan = buildDiscoveryPlan({ changedFiles: ["docs/testing.md"], target: "pr" });
    const ids = plan.selected.map((item) => item.id);

    expect(ids).toContain("docs:verified-links");
    expect(ids).toContain("docs:agent-doc-sync");
    expect(ids).toContain("security:gitleaks-range");
    expect(ids).not.toContain("tests:noncritical-1");
    expect(ids).not.toContain("pages:build");
  });

  it("matches PR classifier semantics for test-only and publishable Pages changes", () => {
    const testOnly = buildDiscoveryPlan({ changedFiles: ["src/lib/example.test.ts"], target: "pr" });
    const publishable = buildDiscoveryPlan({ changedFiles: ["src/app/page.tsx"], target: "pr" });

    expect(testOnly.selected.map((item) => item.id)).not.toContain("pages:build");
    expect(testOnly.selected.map((item) => item.id)).toContain("tests:noncritical-1");
    expect(publishable.selected.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "pages:build",
        "pages:feature-flags",
        "pages:seo",
        "pages:phishing-signatures",
        "pages:classifier-copy",
      ]),
    );
  });

  it.each([
    {
      absent: ["worker:typecheck"],
      files: ["docs/architecture.md"],
      name: "public docs",
      present: ["pages:build", "tests:noncritical-1"],
    },
    {
      absent: ["pages:build"],
      files: ["worker/src/index.ts"],
      name: "Worker source",
      present: ["worker:typecheck", "tests:noncritical-1"],
    },
    {
      absent: ["pages:build"],
      files: ["worker/src/lib/example.test.ts"],
      name: "Worker tests",
      present: ["worker:typecheck", "tests:noncritical-1"],
    },
    {
      absent: [],
      files: ["shared/lib/classification.ts"],
      name: "shared runtime",
      present: ["pages:build", "worker:typecheck"],
    },
    {
      absent: ["pages:build"],
      files: ["worker/migrations/9999_test.sql"],
      name: "migration",
      present: ["worker:typecheck", "prebuild:check-migrations"],
    },
    {
      absent: [],
      files: ["scripts/lib/command-runner.mjs"],
      name: "validation infrastructure",
      present: ["pages:build", "worker:typecheck"],
    },
  ])("covers the $name PR fixture", ({ absent, files, present }) => {
    const ids = buildDiscoveryPlan({ changedFiles: files, target: "pr" }).selected.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["security:gitleaks-range", ...present]));
    for (const id of absent) expect(ids).not.toContain(id);
  });

  it("falls back to the full classifier when the base is unusable", () => {
    const plan = buildDiscoveryPlan({ changedFiles: [], forceFullDeploy: true, target: "pr" });
    expect(plan.selected.map((item) => item.id)).toEqual(
      expect.arrayContaining(["pages:build", "worker:typecheck", "security:gitleaks-range"]),
    );
  });

  it("adds release checks and keeps maintenance advisories nonblocking", () => {
    const release = buildDiscoveryPlan({ changedFiles: ["shared/lib/classification.ts"], target: "release" });
    const maintenance = buildDiscoveryPlan({ changedFiles: ["shared/lib/classification.ts"], target: "maintenance" });

    expect(release.selected.map((item) => item.id)).toEqual(
      expect.arrayContaining(["pages:build-size", "pages:build-attribution", "worker:package"]),
    );
    expect(maintenance.selected).toContainEqual(
      expect.objectContaining({ blocking: false, id: "prebuild:agent-infra" }),
    );
    expect(maintenance.omitted.map((item) => item.id)).toEqual(
      expect.arrayContaining(["external:d1-migrations", "external:cloudflare-deploy"]),
    );
  });

  it("never selects Pages-output advisories for Worker-only maintenance", () => {
    const plan = buildDiscoveryPlan({ changedFiles: ["worker/src/index.ts"], target: "maintenance" });
    const selectedIds = plan.selected.map((item) => item.id);

    expect(selectedIds).not.toEqual(
      expect.arrayContaining([
        "pages:build-size",
        "pages:build-attribution",
        "maintenance:check-build-size",
        "maintenance:check-build-attribution",
        "maintenance:test-a11y",
      ]),
    );
    expect(selectedIds).toContain("worker:smoke");
  });

  it("accounts explicitly for applicable manual and Worker smoke omissions", () => {
    const plan = buildDiscoveryPlan({
      changedFiles: ["src/app/page.tsx", "worker/src/index.ts"],
      target: "pr",
    });
    const omittedIds = plan.omitted.map((item) => item.id);

    expect(omittedIds).toEqual(
      expect.arrayContaining([
        "maintenance:test-a11y",
        "maintenance:check-redemption-coverage-audit",
        "maintenance:check-world-map",
        "worker:smoke",
      ]),
    );
  });

  it("keeps local-gate-only checks explicit", () => {
    const plan = buildDiscoveryPlan({
      changedFiles: ["src/app/page.tsx", "worker/src/lib/telegram.ts"],
      target: "local-gate",
    });
    expect(plan.selected).toContainEqual(expect.objectContaining({ blocking: true, id: "prebuild:agent-infra" }));
    expect(plan.selected.map((item) => item.id)).toContain("pages:smoke");
    expect(plan.selected.map((item) => item.id)).toContain("local-gate:telegram-load");
    expect(plan.omitted).toContainEqual(expect.objectContaining({ id: "security:gitleaks-range" }));
  });
});

describe("dependency-aware execution", () => {
  it("retains failures from every independent Pages consumer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const commands = [
      descriptor("pages:build", "build", 40),
      descriptor("pages:feature-flags", "feature", 50, ["pages:build"]),
      descriptor("pages:seo", "seo", 50, ["pages:build"]),
      descriptor("pages:phishing", "phishing", 50, ["pages:build"]),
    ];
    const results = await executeDiscoveryGraph({
      changedFiles: ["src/app/page.tsx"],
      descriptors: commands,
      env: testEnv(),
      maxParallel: 3,
      options: {},
      runCommandImpl: (command: string) => ({ status: command === "build" ? 0 : 5, aborted: false }),
    });

    expect(results.filter((result) => result.status === "failed").map((result) => result.id)).toEqual([
      "pages:feature-flags",
      "pages:seo",
      "pages:phishing",
    ]);
  });

  it("blocks every out consumer when the Pages producer fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const commands = [
      descriptor("pages:build", "build", 40),
      descriptor("pages:feature", "feature", 50, ["pages:build"]),
      descriptor("pages:seo", "seo", 50, ["pages:build"]),
      descriptor("pages:phishing", "phishing", 50, ["pages:build"]),
      descriptor("pages:classifier", "classifier", 50, ["pages:build"]),
    ];
    const results = await executeDiscoveryGraph({
      changedFiles: ["src/app/page.tsx"],
      descriptors: commands,
      env: testEnv(),
      maxParallel: 3,
      options: {},
      runCommandImpl: (command: string) => {
        calls.push(command);
        return { status: 7, aborted: false };
      },
    });

    expect(calls).toEqual(["build"]);
    expect(results.filter((result) => result.status === "blocked").map((result) => result.id)).toEqual([
      "pages:feature",
      "pages:seo",
      "pages:phishing",
      "pages:classifier",
    ]);
  });

  it("runs Pages consumers when the producer passed with inherited artifact taint", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const generated = {
      ...descriptor("generated:input", "generated", 20),
      failedDependencyPolicy: "taint",
    };
    const build = {
      ...descriptor("pages:build", "build", 40, ["generated:input"]),
      failedDependencyPolicy: "taint",
    };
    const consumer = descriptor("pages:seo", "seo", 50, ["pages:build"]);
    const calls: string[] = [];
    const results = await executeDiscoveryGraph({
      changedFiles: ["src/app/page.tsx"],
      descriptors: [generated, build, consumer],
      env: testEnv(),
      maxParallel: 3,
      options: {},
      runCommandImpl: (command: string) => {
        calls.push(command);
        return { status: command === "generated" ? 4 : 0, aborted: false };
      },
    });

    expect(calls).toEqual(["generated", "build", "seo"]);
    expect(results.find((result) => result.id === "pages:build")).toMatchObject({
      status: "tainted",
      taintedBy: ["generated:input"],
    });
    expect(results.find((result) => result.id === "pages:seo")).toMatchObject({
      status: "tainted",
      taintedBy: ["generated:input"],
    });
  });

  it("continues generated checks across phases and records dependency taint", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runGeneratedArtifacts({
      argv: ["--check", "--continue-on-error", "--only=stablecoin-prevalidated-registry,api-reference"],
      runCommandImpl: (command: string) => ({
        aborted: false,
        status:
          command.includes("stablecoin-per-coin") ||
          command.includes("openapi-spec") ||
          command.includes("api-reference")
            ? 4
            : 0,
      }),
    });

    expect(result.results.map((item) => item.id)).toEqual([
      "stablecoin-catalog",
      "openapi",
      "stablecoin-prevalidated-registry",
      "api-reference",
    ]);
    expect(result.failures).toHaveLength(3);
    expect(result.results.find((item) => item.id === "stablecoin-prevalidated-registry")).toMatchObject({
      statusLabel: "tainted",
      taintedBy: ["stablecoin-catalog"],
    });
    expect(result.results.find((item) => item.id === "api-reference")).toMatchObject({
      statusLabel: "failed",
      taintedBy: ["openapi"],
    });
  });

  it("runs the generated terminal phase after multiple leading prebuild failures", async () => {
    const calls: Array<{ options?: Record<string, unknown>; units: Array<{ commands: string[] }> }> = [];
    const result = await runValidatePrebuild({
      env: testEnv({ VALIDATE_PREBUILD_CONTINUE_ON_ERROR: "1" }),
      log: () => {},
      runExecutionUnits: (units, options) => {
        calls.push({ options, units });
        if (calls.length === 1) {
          return Promise.resolve({
            aborted: false,
            failedCmd: "first",
            failures: [{ failedCmd: "first" }, { failedCmd: "second" }],
            results: [{ id: "first" }, { id: "second" }],
            status: 3,
          });
        }
        return Promise.resolve({
          aborted: false,
          failedCmd: "generated",
          failures: [{ failedCmd: "generated" }],
          results: [{ id: "generated" }],
          status: 5,
        });
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].options).toMatchObject({
      continueOnError: true,
      getCommandEnv: expect.any(Function),
    });
    expect((calls[1].options?.getCommandEnv as () => Record<string, string>)()).toEqual({
      GENERATED_ARTIFACTS_CONTINUE_ON_ERROR: "1",
    });
    expect(result.status).toBe(3);
    expect(result.failures).toHaveLength(3);
  });
});

describe("snapshot, resume, and CLI evidence", () => {
  it("classifies committed, staged, worktree, and untracked files as a union", () => {
    const execFile = (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key.includes("origin/main...HEAD")) return "src/app/page.tsx\n";
      if (key === "diff --name-only --cached") return "worker/src/index.ts\n";
      if (key === "diff --name-only") return "shared/lib/classification.ts\n";
      if (key === "ls-files --others --exclude-standard") return "scripts/new-check.mjs\n";
      return "";
    };
    const result = collectDiscoveryChangedFiles({ baseRef: "origin/main", execFile: execFile as never, headRef: "HEAD" });

    expect(result.sources).toEqual({
      committed: ["src/app/page.tsx"],
      staged: ["worker/src/index.ts"],
      untracked: ["scripts/new-check.mjs"],
      worktree: ["shared/lib/classification.ts"],
    });
    expect(result.union).toEqual([
      "scripts/new-check.mjs",
      "shared/lib/classification.ts",
      "src/app/page.tsx",
      "worker/src/index.ts",
    ]);
  });

  it("requests a full fallback when the committed range cannot be diffed", () => {
    const calls: string[] = [];
    const result = collectDiscoveryChangedFiles({
      baseRef: "missing",
      execFile: ((_command: string, args: string[]) => {
        calls.push(args.join(" "));
        if (args.includes("missing...HEAD")) throw new Error("missing ref");
        if (args.join(" ") === "diff --name-only") return "src/dirty.ts\n";
        return "";
      }) as never,
      headRef: "HEAD",
    });
    expect(result).toMatchObject({ fallbackFullDeploy: true, union: ["src/dirty.ts"] });
    expect(calls).toContain("diff --name-only");
  });

  it("marks changed snapshot inputs and uses conservative targeted resume", () => {
    expect(
      compareDiscoverySnapshots(
        { fileHashes: { "src/a.ts": "one" }, fingerprint: "one" },
        { fileHashes: { "src/a.ts": "two" }, fingerprint: "two" },
      ),
    ).toEqual({ changedPaths: ["src/a.ts"], moved: true });

    const plan = {
      omitted: [],
      selected: [
        descriptor("pages:build", "build", 40),
        descriptor("pages:seo", "seo", 50, ["pages:build"]),
        descriptor("tests:one", "tests", 40),
      ],
      target: "pr",
    };
    const resume = selectResumeNodes(
      plan,
      {
        changedFiles: { union: ["src/app/page.tsx"] },
        diagnosticOnly: true,
        environment: { fingerprint: "env" },
        outcome: "failed",
        plan: { fingerprint: "plan" },
        results: [{ id: "pages:seo", status: "blocked" }],
        snapshot: { start: { head: "head" } },
        target: "pr",
        version: 1,
      },
      {
        changedFiles: { union: ["src/app/page.tsx"] },
        environment: { fingerprint: "env" },
        planFingerprint: "plan",
        snapshot: { head: "new-head" },
      },
    );

    expect(resume.targeted).toBe(true);
    expect(resume.descriptors.map((item: { id: string }) => item.id)).toEqual(["pages:build", "pages:seo"]);
  });

  it("falls back to the full target when a prior report cannot support a targeted resume", () => {
    const plan = {
      omitted: [],
      selected: [descriptor("pages:build", "build", 40), descriptor("pages:seo", "seo", 50, ["pages:build"])],
      target: "pr",
    };
    const context = {
      changedFiles: { union: ["src/app/page.tsx"] },
      environment: { fingerprint: "env" },
      planFingerprint: "plan",
      snapshot: stableSnapshot,
    };
    const priorReport = {
      changedFiles: { union: ["src/app/page.tsx"] },
      diagnosticOnly: true,
      environment: { fingerprint: "env" },
      outcome: "dry-run",
      plan: { fingerprint: "plan" },
      results: [{ id: "pages:seo", status: "omitted" }],
      snapshot: { provisional: false },
      target: "pr",
      version: 1,
    };

    expect(selectResumeNodes(plan, priorReport, context)).toMatchObject({
      descriptors: plan.selected,
      targeted: false,
    });
  });

  it("writes the full summary before requesting one nonzero CLI exit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exits: number[] = [];
    const lifecycle: string[] = [];
    const reports: Array<{ results: Array<{ id: string; status: string }> }> = [];
    const execFile = (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key.includes("origin/main...HEAD")) return "docs/testing.md\n";
      if (key === "rev-parse HEAD") return "abc123\n";
      return "";
    };
    const result = await runMergeGateDiscovery({
      captureSnapshotImpl: () => stableSnapshot,
      collectEnvironmentImpl: () => matchingEnvironment,
      env: testEnv({ MERGE_GATE_NO_FETCH: "1" }),
      execFile,
      exit: (status) => {
        lifecycle.push("exit");
        exits.push(status);
      },
      runCommandImpl: (command: string) => ({
        aborted: false,
        status: command.includes("verified-doc-links") || command.includes("doc-source-paths") ? 8 : 0,
      }),
      writeReportImpl: (report) => {
        lifecycle.push("report");
        reports.push(report);
        return { fingerprintPath: "ignored", latestPath: "ignored" };
      },
    });

    expect(result.status).toBe(8);
    expect(exits).toEqual([8]);
    expect(lifecycle).toEqual(["report", "exit"]);
    expect(reports).toHaveLength(1);
    expect(reports[0].results.filter((item) => item.status === "failed").map((item) => item.id)).toEqual([
      "docs:verified-links",
      "docs:source-paths",
    ]);
  });

  it("reports public configuration only as a redacted hash", () => {
    const environment = collectDiscoveryEnvironment({
      env: testEnv({ MERGE_GATE_PRODUCTION_ENV: "1", NEXT_PUBLIC_GA_ID: "sensitive-value" }),
    });
    expect(JSON.stringify(environment)).not.toContain("sensitive-value");
    expect(environment.publicConfig).toMatchObject({ keyCount: 1, profile: "production" });
  });
});

describe("release proof commands", () => {
  it("keeps the local Gitleaks pin and range flags aligned with the PR workflow", async () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/pull-request-checks.yml"), "utf8");
    expect(workflow).toContain(`GITLEAKS_VERSION: ${GITLEAKS_VERSION}`);
    expect(workflow).toContain(`GITLEAKS_TARBALL_SHA256: ${GITLEAKS_LINUX_X64_TARBALL_SHA256}`);

    const calls: Array<{ args: string[]; binary: string }> = [];
    const result = await runGitleaks({
      env: testEnv({ GITLEAKS_BASE_REF: "base", GITLEAKS_HEAD_REF: "head" }),
      ensureBinary: async () => "/cache/gitleaks",
      runBinary: (binary: string, args: string[]) => {
        calls.push({ args, binary });
        return { status: 0 };
      },
    });
    expect(result.status).toBe(0);
    expect(calls).toEqual([
      {
        args: ["git", "--no-banner", "--redact", "--exit-code", "1", "--log-opts=--no-merges base..head", "."],
        binary: "/cache/gitleaks",
      },
    ]);

    const worktreeCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    await runGitleaks({
      argv: ["--worktree"],
      buildWorktreeInput: () => Buffer.from("new secret candidates only"),
      ensureBinary: async () => "/cache/gitleaks",
      runBinary: (_binary: string, args: string[], options: Record<string, unknown>) => {
        worktreeCalls.push({ args, options });
        return { status: 0 };
      },
    });
    expect(worktreeCalls[0].args[0]).toBe("stdin");
    expect(worktreeCalls[0].options.input).toEqual(Buffer.from("new secret candidates only"));

    const fullHistoryCalls: string[][] = [];
    await runGitleaks({
      env: testEnv({ GITLEAKS_FULL_HISTORY: "1" }),
      ensureBinary: async () => "/cache/gitleaks",
      runBinary: (_binary: string, args: string[]) => {
        fullHistoryCalls.push(args);
        return { status: 0 };
      },
    });
    expect(fullHistoryCalls).toEqual([["git", "--no-banner", "--redact", "--exit-code", "1", "."]]);
  });

  it("builds the Worker with Wrangler dry-run and an ignored output directory", () => {
    const calls: Array<{ args: string[]; command: string; options: Record<string, unknown> }> = [];
    const result = checkWorkerPackage({
      run: (command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ args, command, options });
        return { status: 0 };
      },
    });
    expect(result.status).toBe(0);
    expect(calls[0].command).toBe("npx");
    expect(calls[0].args.slice(0, 4)).toEqual(["--no-install", "wrangler", "deploy", "--dry-run"]);
    expect(calls[0].args.join(" ")).toContain(".cache/merge-gate/discovery/worker-bundle");
    expect(calls[0].options.cwd).toBe(resolve(process.cwd(), "worker"));
  });
});
