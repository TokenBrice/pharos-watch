import { describe, expect, it, vi } from "vitest";

import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { ALWAYS_RUN_TEST_FILES, parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import {
  createPrStaticLeafCommand,
  buildPrStaticCheckPlan,
  partitionPrStaticCheckPlan,
  runPrStaticChecks,
  STRUCTURAL_CHECKS,
} from "../maintenance/run-pr-static-checks.ts";
describe("adaptive PR checks", () => {
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

  // Ordinary internal docs do not select a checkable artifact; generated output
  // paths such as the API reference still require their owning freshness check.
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
    const full = buildPrStaticCheckPlan(changedFiles);
    const compile = buildPrStaticCheckPlan(changedFiles, { group: "compile" });
    const guards = buildPrStaticCheckPlan(changedFiles, { group: "guards" });
    expect([...compile.commands, ...guards.commands].sort((left, right) => left.name.localeCompare(right.name)))
      .toEqual([...full.commands].sort((left, right) => left.name.localeCompare(right.name)));
    expect(compile.classification).toEqual(full.classification);
    expect(guards.classification).toEqual(full.classification);
    expect(guards.commands.some((guard) => compile.commands.some((command) => command.name === guard.name)))
      .toBe(false);
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
      "check:env-contract", "check:shared-types-imports",
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
    const runCommandImpl = vi.fn(async (_command: { scriptName: string }, _env?: Record<string, string>) => ({ status: 0, aborted: false, output: "" }));
    await expect(runPrStaticChecks({
      argv: ["--json", `--group=${group}`, "--base=HEAD", "--head=HEAD"],
      env: process.env,
      runCommandImpl,
      stderr,
      stdout,
    })).resolves.toBe(0);
    const expected = buildPrStaticCheckPlan([], { group }).commands;
    expect(runCommandImpl.mock.calls.map(([command]) => command.scriptName).sort())
      .toEqual(expected.map((command) => command.name).sort());
    const report = JSON.parse(stdout.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(report.lanes.map((lane: { id: string }) => lane.id)).toEqual(expected.map((command) => command.name));
    if (group === "compile") {
      expect(runCommandImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          scriptName: "lint:changed", args: ["run", "lint:changed", "--", "--base=HEAD", "--head=HEAD"],
        }),
        { ...process.env, PR_BASE_SHA: "HEAD", PR_HEAD_SHA: "HEAD" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } else {
      expect(runCommandImpl).toHaveBeenCalledWith(
        expect.objectContaining({ scriptName: "check:critical-coverage-completeness" }),
        { ...process.env, PR_BASE_SHA: "HEAD", PR_HEAD_SHA: "HEAD" },
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

  it("moves all five mixed-PR docs checks into guards with one doc-sync owner", () => {
    const files = ["README.md", "src/app/page.tsx"];
    const guards = buildPrStaticCheckPlan(files, { group: "guards" }).commands;
    const docs = guards.filter((command) => command.manifestCommand);
    expect(docs.map((command) => createPrStaticLeafCommand(command, []).args)).toEqual([
      ["run", "check:verified-doc-links"],
      ["run", "check:doc-source-paths"],
      ["run", "check:doc-sync"],
      ["exec", "--", "vitest", "run", "scripts/__tests__/doc-ownership-registry.test.ts"],
      ["run", "check:generated-artifacts", "--", "--only=agents-doc"],
    ]);
    expect(guards.filter((command) => command.name === "check:doc-sync")).toHaveLength(1);
    expect(buildPrStaticCheckPlan(files, { group: "compile" }).commands.some((command) => command.manifestCommand)).toBe(false);
    const sourceOnly = buildPrStaticCheckPlan(["src/app/page.tsx"], { group: "guards" }).commands;
    expect(sourceOnly.filter((command) => command.name === "check:doc-sync")).toHaveLength(1);
    expect(sourceOnly.some((command) => command.manifestCommand)).toBe(false);
    expect(buildPrStaticCheckPlan(["docs/editorial-style.md"]).commands.some((command) => command.manifestCommand)).toBe(false);
  });

  it("does not run the agents mirror checker twice when docs also select generated artifacts", () => {
    const guards = buildPrStaticCheckPlan(["CLAUDE.md", "src/app/page.tsx"], { group: "guards" }).commands;
    expect(guards.filter((command) => command.name === "agents-doc-artifact")).toHaveLength(1);
    expect(guards.find((command) => command.name === "check:generated-artifacts")?.args?.join(",") ?? "")
      .not.toContain("agents-doc");
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

  it("does not select structural checks for test-only changes", () => {
    const changedFiles = [
      "worker/src/cron/__tests__/sync-stablecoins.test.ts",
      "src/lib/example.test.ts",
      "scripts/test-utils/example.ts",
      "worker/src/test-helpers/example.ts",
      "src/lib/__mocks__/example.ts",
      "scripts/fixtures/example.json",
    ];
    expect(buildPrStaticCheckPlan(changedFiles).commands.map((command) => command.name))
      .not.toContain("check:structural");
    expect(buildPrStaticCheckPlan([...changedFiles, "worker/src/cron/sync-stablecoins.ts"])
      .commands.map((command) => command.name)).toContain("check:structural");
  });

  it("retains every structural guard in order", () => {
    expect(STRUCTURAL_CHECKS).toEqual([
      "check:provider-resilience",
      "check:fetch-body-timeouts",
      "check:runtime-reachability",
      "check:architecture-boundaries",
      "check:script-entrypoints",
      "check:cli-args-policy",
      "check:dependency-review-gaps",
      "check:editorial-content",
      "check:unused-code",
      "check:sensitive-page-copy",
      "check:agent-skills",
    ]);
  });

  it.each([[], [0, 7, 10], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]].map((failedIndexes) => ({ failedIndexes })))(
    "collects every structural outcome sequentially when failures occur at $failedIndexes",
    async ({ failedIndexes }) => {
      const calls: string[] = [];
      const output: string[] = [];
      let active = 0;
      let maxActive = 0;
      const code = await runPrStaticChecks({
        argv: ["--structural"],
        stdout: { write: (text: string) => { output.push(text); return true; } },
        runCommandImpl: async (command) => {
          const index = calls.length;
          calls.push(command.scriptName);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return failedIndexes.includes(index) ? index + 1 : 0;
        },
      });
      expect(calls).toEqual(STRUCTURAL_CHECKS);
      expect(maxActive).toBe(1);
      expect(code).toBe(failedIndexes.length === 0 ? 0 : 1);
      for (const [index, name] of STRUCTURAL_CHECKS.entries()) {
        expect(output.join("")).toContain(failedIndexes.includes(index)
          ? `${name}: npm run ${name} failed (exit ${index + 1}).`
          : `${name}: passed`);
      }
      expect(output.join("")).toContain(`${11 - failedIndexes.length}/11 guards passed.`);
    },
  );

  it("continues structural checks after a thrown command failure", async () => {
    const output: string[] = [];
    const runCommandImpl = vi.fn()
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValue(0);
    expect(await runPrStaticChecks({
      argv: ["--structural"],
      runCommandImpl,
      stdout: { write: (text: string) => { output.push(text); return true; } },
    })).toBe(1);
    expect(runCommandImpl).toHaveBeenCalledTimes(11);
    expect(output.join("")).toContain("check:provider-resilience: npm run check:provider-resilience failed (exit 1).");
    expect(output.join("")).toContain("check:agent-skills: passed");
  });

  it("rejects range or output options in structural-only mode before executing guards", async () => {
    const runCommandImpl = vi.fn();
    await expect(runPrStaticChecks({
      argv: ["--structural", "--json"],
      runCommandImpl,
    })).rejects.toThrow("--structural cannot be combined");
    expect(runCommandImpl).not.toHaveBeenCalled();
  });
});
