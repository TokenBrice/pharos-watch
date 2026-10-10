import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { selectLintableFiles } from "../ci/run-changed-eslint.ts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { ALWAYS_RUN_TEST_FILES, parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import {
  buildPrStaticCheckPlan,
  hasOwnedDocsImpact,
  partitionPrStaticCheckPlan,
  runPrStaticChecks,
} from "../maintenance/run-pr-static-checks.ts";
import { runPrChecks } from "../maintenance/run-pr-checks.ts";

describe("adaptive PR checks", () => {
  it("rejects staged selection before running a range-based static gate", async () => {
    const runCommandImpl = vi.fn(async () => 0);
    await expect(runPrStaticChecks({ argv: ["--staged"], runCommandImpl }))
      .rejects.toThrow(/requires a --base\/--head range/);
    expect(runCommandImpl).not.toHaveBeenCalled();
  });

  it("emits the stable check:pr JSON envelope through the adaptive harness", async () => {
    const stdout = { write: vi.fn<(chunk: string) => unknown>() };
    const stderr = { write: vi.fn<(chunk: string) => unknown>() };
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const runCommandImpl = vi.fn(async (command: { cmd: string }) => {
      if (command.cmd.startsWith("git rev-parse")) return { status: 0, aborted: false, output: `${headSha}\n` };
      if (command.cmd.startsWith("git show")) return { status: 0, aborted: false, output: "0\n" };
      return { status: 0, aborted: false, output: "" };
    });

    await expect(runPrChecks(["--json", "--base=HEAD", "--head=HEAD", "--no-fetch"], { NODE_ENV: "test" }, {
      repoRoot: resolve(import.meta.dirname, "../.."),
      inspectCheckout: () => ({ headSha, requestedHeadSha: headSha, mergeBase: headSha, treeClean: true }),
      now: () => 0,
      runCommandImpl: runCommandImpl as never,
      stderr,
      stdout,
      runtimeVersions: () => ({ node: "24.16.0", npm: "11.13.0" }),
      runSecrets: async () => ({ ok: true, exitCode: 0, summary: "Trusted scan clean." }),
      writeReceipt: vi.fn(() => ""),
    })).resolves.toBe(0);

    const report = JSON.parse(stdout.write.mock.calls.map(([chunk]) => chunk).join("")) as Record<string, unknown>;
    expect(report).toMatchObject({
      base: headSha,
      head: headSha,
      changedFiles: [],
      status: "passed",
      durationMs: expect.any(Number),
    });
    expect(report.classification).toEqual(expect.objectContaining({ docsOnly: false }));
    expect(report.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "classifier-smoke",
        command: expect.any(String),
        status: "passed",
        durationMs: expect.any(Number),
        failureTail: "",
      }),
    ]));
    expect(stderr.write.mock.calls.map(([chunk]) => chunk).join("")).not.toContain("{\"base\"");
  });

  it("emits the stable check:pr:static JSON envelope", async () => {
    const stdout = { write: vi.fn<(chunk: string) => unknown>() };
    const stderr = { write: vi.fn<(chunk: string) => unknown>() };
    const runCommandImpl = vi.fn(async () => ({ status: 0, aborted: false, output: "" }));

    await expect(runPrStaticChecks({
      argv: ["--json", "--base=HEAD", "--head=HEAD"],
      env: { NODE_ENV: "test" },
      runCommandImpl: runCommandImpl as never,
      stderr,
      stdout,
    })).resolves.toBe(0);

    const report = JSON.parse(stdout.write.mock.calls.map(([chunk]) => chunk).join("")) as Record<string, unknown>;
    expect(report).toMatchObject({
      base: "HEAD",
      head: "HEAD",
      changedFiles: [],
      status: "passed",
      durationMs: expect.any(Number),
    });
    expect(report.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "lint:changed",
        status: "passed",
        durationMs: expect.any(Number),
        failureTail: "",
      }),
    ]));
    expect(stderr.write.mock.calls.map(([chunk]) => chunk).join("")).not.toContain("{\"base\"");
  });

  it("parses diff arguments without swallowing downstream options", () => {
    expect(parseChangedFileArgs(["--base=abc", "--head", "def", "--shard=1/2"], { NODE_ENV: "test" })).toEqual({
      base: "abc",
      head: "def",
      rest: ["--shard=1/2"],
      staged: false,
    });
  });

  it("collects normalized unique changed files", () => {
    const execFile = vi.fn(() => "src/a.ts\0src/a.ts\0docs/testing.md\0");
    expect(collectChangedFiles({ base: "a", head: "b", execFile: execFile as never })).toEqual([
      "docs/testing.md",
      "src/a.ts",
    ]);
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", "a...b"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("limits ESLint to changed source files that still exist", () => {
    expect(
      selectLintableFiles(["docs/a.md", "src/a.ts", "src/deleted.ts", "worker/a.mjs"], {
        exists: (path) => path !== "src/deleted.ts",
      }),
    ).toEqual(["src/a.ts", "worker/a.mjs"]);
  });

  it("unions changed Vitest files with the critical contract set", () => {
    const listed = parseVitestFileList("[node] src/a.test.ts\n[worker] worker/a.spec.ts\n");
    expect(selectPrTestFiles(listed, ["src/critical.test.ts"], [], new Map(), () => true)).toEqual([
      "src/a.test.ts",
      "src/critical.test.ts",
      "worker/a.spec.ts",
    ]);
  });

  it("always selects global invariants for unrelated source changes", () => {
    const selected = selectPrTestFiles(["src/components/unrelated-source.test.ts"], undefined, [], undefined, () => true);

    expect(selected).toEqual(
      expect.arrayContaining([
        "src/lib/__tests__/reserve-coinid-validation.test.ts",
        "scripts/ci/check-architecture-boundaries.test.ts",
        "src/components/unrelated-source.test.ts",
      ]),
    );
  });

  it("keeps unique required contracts including real OG rendering for dependency changes", () => {
    expect(new Set(ALWAYS_RUN_TEST_FILES).size).toBe(ALWAYS_RUN_TEST_FILES.length);
    for (const source of ["worker/package.json", "package-lock.json", "worker/src/api/og.tsx"]) {
      expect(selectPrTestFiles([], undefined, [source])).toEqual(expect.arrayContaining([
        "scripts/__tests__/og-worker-runtime.test.ts",
        "src/lib/__tests__/reserve-coinid-validation.test.ts",
        "scripts/ci/check-architecture-boundaries.test.ts",
      ]));
    }
  });

  it("fails closed when a mandatory contract disappears but drops deleted graph tests", () => {
    const mandatory = "src/mandatory.test.ts";
    expect(() => selectPrTestFiles([], [mandatory], [], new Map(), () => false)).toThrow(mandatory);
    expect(selectPrTestFiles(["src/deleted.test.ts"], [mandatory], [], new Map(), (path) => path.endsWith(mandatory)))
      .toEqual([mandatory]);
    expect(() => selectPrTestFiles([], [], [], new Map(), () => true)).toThrow(/Empty/);
  });

  it("selects importing owners for changed critical source files", () => {
    const selected = selectPrTestFiles([], ALWAYS_RUN_TEST_FILES, ["worker/src/lib/auth.ts"]);

    expect(selected).toContain("worker/src/lib/__tests__/auth.test.ts");
  });

  it("selects impacted generated artifacts and downstream dependants", () => {
    const registry = [
      { id: "catalog", sourcePaths: ["data/**"] },
      { id: "index", sourcePaths: ["scripts/index.ts"], dependsOn: ["catalog"] },
      { id: "other", sourcePaths: ["other/**"] },
    ] as never;
    expect(selectChangedGeneratedArtifactIds(["data/coin.json"], registry)).toEqual(["catalog", "index"]);
    expect(selectChangedGeneratedArtifactIds(["generated/catalog.json"], [
      { id: "catalog", sourcePaths: ["data/**"], outputPaths: ["generated/*.json"] },
      { id: "index", sourcePaths: ["scripts/index.ts"], dependsOn: ["catalog"] },
    ])).toEqual(["catalog", "index"]);
  });

  it("selects the API reference for output-only generated documentation edits", () => {
    expect(selectChangedGeneratedArtifactIds(["docs/api-reference.md"])).toContain("api-reference");
  });

  // Ordinary internal docs do not select a checkable artifact; generated output
  // paths such as the API reference still require their owning freshness check.
  it("keeps docs-only PRs on the small static baseline", () => {
    expect(buildPrStaticCheckPlan(["docs/testing.md"]).commands.map((command) => command.name)).toEqual([
      "lint:changed",
      "check:table-primitives",
      "typecheck",
      "check:env-contract",
      "check:shared-types-imports",
      "check:critical-coverage-completeness",
    ]);
  });

  it.each([
    "package.json",
    "package-lock.json",
    ".npmrc",
    "scripts/ci/verify-dependency-audit.ts",
    "scripts/ci/dependency-audit-exceptions.json",
  ])("selects the full reviewed dependency audit for %s", (path) => {
    expect(buildPrStaticCheckPlan([path]).commands.map((command) => command.name)).toContain("check:dependency-audit");
    expect(buildPrStaticCheckPlan([path], { group: "guards" }).commands.map((command) => command.name))
      .toContain("check:dependency-audit");
    expect(buildPrStaticCheckPlan([path], { group: "compile" }).commands.map((command) => command.name))
      .not.toContain("check:dependency-audit");
  });

  it.each(["html", "json", "txt"])("selects stable capture validation for a changed %s fixture, never calendar age", (ext) => {
    const path = `worker/src/cron/reserve-adapters/__tests__/fixtures/capture.${ext}`;
    const names = buildPrStaticCheckPlan([path], { group: "guards" }).commands.map((command) => command.name);
    expect(names).toContain("check:html-fixture-metadata");
    expect(names).not.toContain("check:html-fixture-age");
    expect(buildPrStaticCheckPlan([path], { group: "compile" }).commands.map((command) => command.name))
      .not.toContain("check:html-fixture-metadata");
  });

  it("does not select scheduled-producer checks for unrelated changes", () => {
    const names = buildPrStaticCheckPlan(["docs/testing.md"]).commands.map((command) => command.name);
    expect(names).not.toContain("check:html-fixture-metadata");
    expect(names).not.toContain("check:dependency-audit");
  });

  it("selects doc-sync when a changed source has an owning documentation mapping", () => {
    expect(hasOwnedDocsImpact(["shared/lib/classification.ts"])).toBe(true);
    expect(buildPrStaticCheckPlan(["shared/lib/classification.ts"]).commands.map((command) => command.name))
      .toContain("check:doc-sync");
  });

  it("skips the static lane's doc-sync copy only when the docs lane owns it", () => {
    const changedFiles = ["docs/testing.md", "shared/lib/classification.ts"];
    const composed = buildPrStaticCheckPlan(changedFiles, { skipDocSync: true }).commands.map(
      (command) => command.name,
    );
    expect(composed).not.toContain("check:doc-sync");
    // Standalone semantics are unchanged: the same diff without the
    // composition flag still validates source-owned docs here.
    const standalone = buildPrStaticCheckPlan(changedFiles).commands.map((command) => command.name);
    expect(standalone).toContain("check:doc-sync");
  });

  it.each([
    [],
    ["docs/testing.md"],
    ["docs/editorial-style.md"],
    ["package.json", "package-lock.json"],
    ["src/app/page.tsx", "shared/lib/classification.ts"],
    ["worker/src/lib/safety-score-v9/extension.ts"],
    ["worker/src/cron/__tests__/x.test.ts"],
    ["worker/src/cron/x.ts", "worker/src/cron/__tests__/x.test.ts"],
    ["scripts/ci/check-provider-resilience.ts"],
  ].map((changedFiles) => ({ changedFiles })))("partitions the unchanged static plan for $changedFiles into disjoint compile and guards groups", ({ changedFiles }) => {
    for (const skipDocSync of [false, true]) {
      const full = buildPrStaticCheckPlan(changedFiles, { skipDocSync });
      const compile = buildPrStaticCheckPlan(changedFiles, { skipDocSync, group: "compile" });
      const guards = buildPrStaticCheckPlan(changedFiles, { skipDocSync, group: "guards" });
      expect([...compile.commands, ...guards.commands].sort((left, right) => left.name.localeCompare(right.name)))
        .toEqual([...full.commands].sort((left, right) => left.name.localeCompare(right.name)));
      expect(compile.classification).toEqual(full.classification);
      expect(guards.classification).toEqual(full.classification);
      expect(guards.commands.some((guard) => compile.commands.some((command) => command.name === guard.name)))
        .toBe(false);
    }
  });

  it("keeps both compilers concurrent while moving every non-compile check to guards", () => {
    const changedFiles = ["worker/src/lib/safety-score-v9/extension.ts", "docs/editorial-style.md"];
    const compile = buildPrStaticCheckPlan(changedFiles, { group: "compile" });
    expect(compile.commands.map((command) => command.name)).toEqual([
      "lint:changed", "typecheck", "typecheck:worker",
    ]);
    const partition = partitionPrStaticCheckPlan(compile.commands);
    expect(partition.parallel.map((command) => command.name)).toEqual(["typecheck", "typecheck:worker"]);
    expect(partition.sequential.map((command) => command.name)).toEqual(["lint:changed"]);

    const guards = buildPrStaticCheckPlan(changedFiles, { group: "guards" });
    expect(guards.commands.map((command) => command.name)).toEqual(expect.arrayContaining([
      "check:table-primitives", "check:env-contract", "check:shared-types-imports",
      "check:critical-coverage-completeness", "check:structural", "check:generated-artifacts",
      "check:cron-connections", "check:cron-sync", "check:migrations", "check:sql-safety",
      "check:worker-config", "check:worker-package",
    ]));
    expect(partitionPrStaticCheckPlan(guards.commands).parallel.map((command) => command.name)).toEqual([
      "check:structural", "check:generated-artifacts",
    ]);
  });

  it.each(["compile", "guards"] as const)("executes only the %s group with unchanged range arguments", async (group) => {
    const stdout = { write: vi.fn<(chunk: string) => unknown>() };
    const stderr = { write: vi.fn<(chunk: string) => unknown>() };
    const runCommandImpl = vi.fn(async (_command: { scriptName: string }) => ({ status: 0, aborted: false, output: "" }));
    await expect(runPrStaticChecks({
      argv: ["--json", `--group=${group}`, "--skip-doc-sync", "--base=HEAD", "--head=HEAD"],
      env: process.env,
      runCommandImpl,
      stderr,
      stdout,
    })).resolves.toBe(0);
    const expected = buildPrStaticCheckPlan([], { group, skipDocSync: true }).commands;
    expect(runCommandImpl.mock.calls.map(([command]) => command.scriptName).sort())
      .toEqual(expected.map((command) => command.name).sort());
    const report = JSON.parse(stdout.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(report.lanes.map((lane: { id: string }) => lane.id)).toEqual(expected.map((command) => command.name));
    if (group === "compile") {
      expect(runCommandImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          scriptName: "lint:changed", args: ["run", "lint:changed", "--", "--base=HEAD", "--head=HEAD"],
        }),
        process.env,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    }
  });

  it.each(["", "all", "typo"])("rejects unsupported static group %j before running checks", async (group) => {
    const runCommandImpl = vi.fn(async () => ({ status: 0, aborted: false }));
    await expect(runPrStaticChecks({
      argv: [`--group=${group}`, "--base=HEAD", "--head=HEAD"],
      runCommandImpl,
    })).rejects.toThrow(/Unknown --group value.*Expected compile or guards/);
    expect(runCommandImpl).not.toHaveBeenCalled();
  });

  it("accepts --skip-doc-sync as a composition-only static runner option", async () => {
    const stdout = { write: vi.fn<(chunk: string) => unknown>() };
    const stderr = { write: vi.fn<(chunk: string) => unknown>() };
    const runCommandImpl = vi.fn(async () => ({ status: 0, aborted: false, output: "" }));

    await expect(runPrStaticChecks({
      argv: ["--json", "--skip-doc-sync", "--base=HEAD", "--head=HEAD"],
      env: process.env,
      runCommandImpl: runCommandImpl as never,
      stderr,
      stdout,
    })).resolves.toBe(0);

    expect(stderr.write.mock.calls.map(([chunk]) => chunk).join("")).toContain(
      "doc-sync owned by the docs lane",
    );

    await expect(runPrStaticChecks({
      argv: ["--bogus-flag", "--base=HEAD", "--head=HEAD"],
      env: process.env,
      runCommandImpl: runCommandImpl as never,
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    })).rejects.toThrow("Unknown option");
  });

  it("runs the critical-coverage completeness guard for every non-doc PR path", () => {
    expect(buildPrStaticCheckPlan(["worker/src/lib/auth.ts"]).commands.map((command) => command.name)).toContain(
      "check:critical-coverage-completeness",
    );
  });

  it("runs typechecks, structural checks, and generated verification in the bounded parallel phase", () => {
    const { commands } = buildPrStaticCheckPlan([
      "worker/src/lib/safety-score-v9/extension.ts",
      "docs/editorial-style.md",
    ]);
    const partition = partitionPrStaticCheckPlan(commands);

    expect(partition.parallel.map((command) => command.name)).toEqual(
      expect.arrayContaining([
        "typecheck",
        "typecheck:worker",
        "check:structural",
        "check:generated-artifacts",
      ]),
    );
    expect(partition.sequential.map((command) => command.name)).toContain("check:worker-package");
  });

  it("packages Worker changes in the adaptive PR lane", () => {
    expect(buildPrStaticCheckPlan(["worker/src/index.ts"]).commands.map((command) => command.name)).toContain(
      "check:worker-package",
    );
  });

  it.each([
    "worker/src/lib/full-stablecoin-catalog.ts",
    "worker/src/lib/safety-score-v9/candidate.ts",
    "worker/src/lib/safety-score-v9/extension.ts",
    "worker/src/lib/safety-score-v9/fact-set.ts",
  ])("checks the evaluation manifest for offline runtime input %s even without Pages changes", (path) => {
    // The Wave-1 near-miss: a worker-only commit touching a manifest-pinned V9
    // source left the evaluation-build manifest stale and passed the PR gate.
    const plan = buildPrStaticCheckPlan([path]);
    const artifactCommand = plan.commands.find(
      (command): command is { name: string; args: string[] } =>
        command.name === "check:generated-artifacts" && "args" in command,
    );
    expect(plan.classification.pagesChanged).toBe(false);
    expect(artifactCommand?.args[0]).toContain("safety-score-v9-evaluation-build");
  });

  it("checks the editorial-style artifact for its docs source", () => {
    const plan = buildPrStaticCheckPlan(["docs/editorial-style.md"]);
    const artifactCommand = plan.commands.find(
      (command): command is { name: string; args: string[] } =>
        command.name === "check:generated-artifacts" && "args" in command,
    );

    expect(plan.classification.docsOnly).toBe(false);
    expect(artifactCommand?.args[0]).toContain("editorial-style");
  });

  it("selects structural checks for production and validation surfaces", () => {
    for (const path of [
      "src/lib/feature-flags.ts",
      "worker/src/cron/sync-stablecoins.ts",
      "scripts/ci/check-provider-resilience.ts",
      ".github/workflows/nightly-validation.yml",
    ]) {
      expect(buildPrStaticCheckPlan([path]).commands.map((command) => command.name)).toContain("check:structural");
    }
  });
  it("uses only the lightweight structural checks for test-only changes", () => {
    const names = buildPrStaticCheckPlan(["worker/src/cron/__tests__/x.test.ts"]).commands.map(
      (command) => command.name,
    );
    expect(names.filter((name) => ["check:structural", "check:clone-ratchet", "check:cron-console-usage"].includes(name))).toEqual([
      "check:clone-ratchet",
      "check:cron-console-usage",
    ]);
  });

  it("keeps the full structural chain when production and test paths are mixed", () => {
    const names = buildPrStaticCheckPlan([
      "worker/src/cron/__tests__/x.test.ts",
      "worker/src/cron/x.ts",
    ]).commands.map((command) => command.name);
    expect(names).toContain("check:structural");
    expect(names).not.toContain("check:clone-ratchet");
    expect(names).not.toContain("check:cron-console-usage");
  });

  it("keeps the full structural chain for scripts CI sources", () => {
    const names = buildPrStaticCheckPlan(["scripts/ci/foo.ts"]).commands.map((command) => command.name);
    expect(names).toContain("check:structural");
    expect(names).not.toContain("check:clone-ratchet");
    expect(names).not.toContain("check:cron-console-usage");
  });
});
