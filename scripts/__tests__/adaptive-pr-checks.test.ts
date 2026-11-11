import { describe, expect, it, vi } from "vitest";
import { PATH_FAMILIES } from "../lib/doc-ownership-registry.mts";

import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import { collectStagedFiles } from "../lib/changed-files.mts";
import { ALWAYS_RUN_TEST_FILES, parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import {
  createPrStaticLeafCommand,
  buildPrStaticCheckPlan,
  partitionPrStaticCheckPlan,
  runPrStaticChecks,
  STRUCTURAL_CHECKS,
} from "../maintenance/run-pr-static-checks.ts";
import { selectCheckableArtifactIds, selectGeneratedArtifacts } from "../lib/automation-registry.mjs";
import { withTempRepo } from "./helpers/test-state";
import { classifyChangedFiles } from "../ci/classify-deploy-changes.ts";
import { buildPrCheckPlan, createLaneCommand } from "../maintenance/run-pr-checks.ts";

const names = (commands: readonly { name: string }[]) => commands.map((command) => command.name);
const staticNames = (files: readonly string[], options?: Parameters<typeof buildPrStaticCheckPlan>[1]) =>
  names(buildPrStaticCheckPlan(files, options).commands);

describe("PR dataset integrity selection", () => {
  it.each(["public/_redirects", "scripts/maintenance/generate-runbook-index.ts", "docs/testing.md"])(
    "selects dataset integrity for %s", (file) => {
      for (const group of [undefined, "guards", "compile"] as const) {
        const command = buildPrStaticCheckPlan([file], { group }).commands
          .find(({ name }) => name === "check:generated-artifacts");
        expect(command?.args?.includes("--integrity-only") ?? false)
          .toBe(group !== "compile" && file === "public/_redirects");
      }
    },
  );
});

describe("adaptive PR checks", () => {
  it("selects the homepage health-copy guard only for authored homepage surfaces", () => {
    for (const file of [
      "src/app/page.tsx",
      "src/components/homepage/home-alt-hero.tsx",
      "src/components/home-alt-mini-cards/peg-health-card.tsx",
    ]) expect(staticNames([file]), file).toContain("check:homepage-health-copy");
    for (const file of [
      "src/components/stablecoin-directory/stablecoin-table.tsx",
      "src/components/homepage/home-section-error-boundary.tsx",
    ]) expect(staticNames([file]), file).not.toContain("check:homepage-health-copy");
  });

  it("selects doc sync for selector-only and required-only owners without depending on context mode", () => {
    const originalLength = PATH_FAMILIES.length;
    const family = {
      id: "selector-only", label: "Selector-only owner", risk: "low" as const,
      sourceGlobs: ["reading-owner.fixture"], tier: "specific" as const,
      docs: [], background: [], checks: [], hardRules: [], scopedContext: [],
    };
    PATH_FAMILIES.push({ ...family, reading: [{ sources: ["reading-owner.fixture"],
      contract: [{ path: "docs/testing.md", anchor: "ci-pipeline" }] }] });
    try {
      expect(staticNames(["reading-owner.fixture"])).toContain("check:doc-sync");
      PATH_FAMILIES.splice(originalLength, 1, { ...family, required: [{ path: "docs/testing.md", anchor: "ci-pipeline" }] });
      expect(staticNames(["reading-owner.fixture"])).toContain("check:doc-sync");
    } finally {
      PATH_FAMILIES.splice(originalLength);
    }
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

  it("selects an artifact when a registered source is staged for deletion", () => {
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args.includes("--cached") ? "shared/lib/safety-score-v9/formula.ts\0" : "",
    );
    const stagedFiles = collectStagedFiles({ cwd: "/repo", execFile: execFile as never });
    expect(selectChangedGeneratedArtifactIds(stagedFiles)).toContain("safety-score-v9-evaluation-build");
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMRD", "-z"],
      { cwd: "/repo", encoding: "utf8" },
    );
  });

  it("keeps ignored bootstrap projections out of automatic PR drift checks", () => {
    const files = ["scripts/maintenance/generate-postman-collection.ts", "shared/data/stablecoins/coins/usdc-circle.json"];
    const changed = selectChangedGeneratedArtifactIds(files);
    expect(changed).toEqual(expect.arrayContaining(["postman", "stablecoin-catalog"]));
    const automatic = selectCheckableArtifactIds(changed);
    expect(automatic).not.toContain("postman");
    expect(automatic).not.toContain("stablecoin-catalog");
    expect(buildPrStaticCheckPlan(files).commands.find((command) => command.name === "check:generated-artifacts")?.args)
      .toEqual(automatic.length ? [`--only=${automatic.join(",")}`, ...(automatic.includes("public-datasets") ? ["--integrity-only"] : [])] : undefined);
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
    expect(staticNames([path])).toContain("check:dependency-audit");
    expect(staticNames([path], { group: "guards" }))
      .toContain("check:dependency-audit");
    expect(staticNames([path], { group: "compile" }))
      .not.toContain("check:dependency-audit");
  });

  it("keeps both dependency audits because neither covers the other", () => {
    const names = staticNames(["package.json"], { group: "guards" });
    expect(names).toEqual(expect.arrayContaining(["audit:deps", "check:dependency-audit"]));
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
    const changedFiles = [
      "worker/src/lib/safety-score-v9/extension.ts",
      "src/lib/classification.ts",
      "docs/editorial-style.md",
    ];
    const compile = buildPrStaticCheckPlan(changedFiles, { group: "compile" });
    expect(names(compile.commands)).toEqual([
      "lint:changed", "typecheck", "typecheck:worker",
    ]);
    const partition = partitionPrStaticCheckPlan(compile.commands);
    expect(names(partition.parallel)).toEqual(["typecheck", "typecheck:worker"]);
    expect(names(partition.sequential)).toEqual(["lint:changed"]);

    const guards = buildPrStaticCheckPlan(changedFiles, { group: "guards" });
    expect(names(guards.commands)).toEqual(expect.arrayContaining([
      "check:env-contract",
      "check:critical-coverage-completeness", "check:structural", "check:generated-artifacts",
      "check:cron-connections", "check:migrations", "check:sql-safety",
      "check:worker-config", "check:worker-package",
    ]));
    expect(names(partitionPrStaticCheckPlan(guards.commands).parallel)).toEqual([
      "check:generated-artifacts", "check:structural", "check:unused-code",
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
      .toEqual(names(expected).sort());
    const report = JSON.parse(stdout.write.mock.calls.map(([chunk]) => chunk).join(""));
    expect(report.lanes.map((lane: { id: string }) => lane.id)).toEqual(names(expected));
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

  it("moves the shared mixed-PR docs checks into guards with one doc-sync owner", () => {
    const files = ["README.md", "src/app/page.tsx"];
    const guards = buildPrStaticCheckPlan(files, { group: "guards" }).commands;
    const docs = guards.filter((command) => command.manifestCommand);
    expect(docs.map((command) => createPrStaticLeafCommand(command, []).args)).toEqual([
      ["run", "check:verified-doc-links"],
      ["run", "check:doc-sync"],
      ["exec", "--", "vitest", "run", "scripts/__tests__/doc-ownership-registry.test.ts", "scripts/__tests__/pharos-change-contract.test.ts"],
    ]);
    expect(guards.filter((command) => command.name === "check:doc-sync")).toHaveLength(1);
    expect(buildPrStaticCheckPlan(files, { group: "compile" }).commands.some((command) => command.manifestCommand)).toBe(false);
    const sourceOnly = buildPrStaticCheckPlan(["src/app/page.tsx"], { group: "guards" }).commands;
    expect(sourceOnly.filter((command) => command.name === "check:doc-sync")).toHaveLength(1);
    expect(sourceOnly.some((command) => command.manifestCommand)).toBe(false);
    expect(buildPrStaticCheckPlan(["docs/editorial-style.md"]).commands.some((command) => command.manifestCommand)).toBe(false);
  });


  it.each([
    "worker/src/lib/full-stablecoin-catalog.ts",
    "worker/src/lib/safety-score-v9/candidate.ts",
    "worker/src/lib/safety-score-v9/extension.ts",
    "worker/src/lib/safety-score-v9/fact-set.ts",
  ])("guards the evaluation manifest for offline runtime input %s at the CI head, not per commit", (path) => {
    // The Wave-1 near-miss: a worker-only commit touching a manifest-pinned V9
    // source left the evaluation-build manifest stale and passed the PR gate.
    // The manifest is regenerated once per integration head; CI prepare's
    // bootstrap tracked-output assertion fails a stale head instead.
    const plan = buildPrStaticCheckPlan([path]);
    const artifactCommand = plan.commands.find(
      (command): command is { name: string; args: string[] } =>
        command.name === "check:generated-artifacts" && "args" in command,
    );
    expect(plan.classification.pagesChanged).toBe(false);
    expect(artifactCommand?.args[0] ?? "").not.toContain("safety-score-v9-evaluation-build");
    expect(selectGeneratedArtifacts({ bootstrap: true, check: true }).map((artifact) => artifact.id))
      .toContain("safety-score-v9-evaluation-build");
  });

  it("selects structural checks for production and validation surfaces", () => {
    for (const path of [
      "src/lib/feature-flags.ts",
      "worker/src/cron/sync-stablecoins.ts",
      "scripts/ci/check-provider-resilience.ts",
      ".github/workflows/nightly-validation.yml",
    ]) {
      expect(staticNames([path])).toContain("check:structural");
    }
  });

  it("retains cron topology validation without duplicating its cron-sync evaluator", () => {
    const names = staticNames(["worker/src/cron/sync-stablecoins.ts"]);
    expect(names).toContain("check:cron-connections");
    expect(names).not.toContain("check:cron-sync");
  });

  it.each([
    "src/app/api/page.tsx", "src/app/funding/page.tsx", "src/app/pharoswatchbot/page.tsx",
    "src/components/funding/funding-chart.tsx", "scripts/ci/check-sensitive-page-copy.ts",
  ])("selects sensitive copy validation for %s", (path) => {
    expect(staticNames([path])).toContain("check:sensitive-page-copy");
  });

  it("runs unused-code as a parallel PR guard without widening the structural roster", () => {
    expect(STRUCTURAL_CHECKS).not.toContain("check:unused-code");
    expect(STRUCTURAL_CHECKS).not.toContain("check:sensitive-page-copy");
    const guards = buildPrStaticCheckPlan(["src/app/page.tsx"], { group: "guards" }).commands;
    expect(names(guards)).toContain("check:unused-code");
    expect(names(partitionPrStaticCheckPlan(guards).parallel)).toContain("check:unused-code");
    expect(names(guards)).not.toContain("check:sensitive-page-copy");
    expect(staticNames(["docs/testing.md"]))
      .not.toContain("check:unused-code");
  });

  it.each([
    ["src/app/page.tsx", true],
    ["shared/lib/classification.ts", true],
    ["functions/selector-snapshot/[[path]].ts", true],
    ["scripts/ci/check-provider-resilience.ts", true],
    ["next-env.d.ts", true],
    ["package.json", true],
    ["package-lock.json", true],
    ["tsconfig.typecheck.json", true],
    ["next.config.ts", true],
    ["src/types/global.d.ts", true],
    ["src/generated/schema.ts", true],
    ["docs/testing.md", false],
    ["worker/src/cron/sync-stablecoins.ts", false],
    ["src/lib/example.test.ts", false],
    ["worker/src/cron/__tests__/x.test.ts", false],
  ])("selects root typecheck only for inputs tsconfig.typecheck.json can observe: %s -> %s", (path, expected) => {
    const compile = staticNames([path], { group: "compile" });
    expect(compile.includes("typecheck")).toBe(expected);
  });

  // Nightly tier: PR coverage retained by scripts/__tests__/adaptive-pr-checks.test.ts
  // "selects root typecheck for an imported script module only the program
  // compiles" (below) drives the same program-membership branch over a fixture
  // program, and every typed-root change still selects root typecheck in the
  // compile lane. These rows build the whole real root typecheck program
  // (`allowJs` closure over ~2,300 files, seconds of work) only to read which
  // `.mjs` modules it reaches — the full-corpus sweep the PR gate cannot afford.
  it.each([
    // `allowJs` pulls the imported registry modules into the program; no
    // include glob matches them, so only program membership can select them.
    ["scripts/lib/cli-argv-policy.mjs", true],
    ["scripts/maintenance/report-build-size.mjs", true],
    ["scripts/ci/check-seo-static.mjs", false],
  ])("selects root typecheck for an .mjs module only the real program reaches: %s -> %s", { tags: ["nightly"] }, (path, expected) => {
    const compile = staticNames([path], { group: "compile" });
    expect(compile.includes("typecheck")).toBe(expected);
  });

  it("selects root typecheck for an imported script module only the program compiles", () => {
    withTempRepo("pharos-static-typecheck", {
      "tsconfig.typecheck.json": JSON.stringify({
        compilerOptions: { allowJs: true },
        include: ["src/**/*.ts"],
      }),
      "src/keep.ts": 'import "./helper.mjs";\nexport {};\n',
      "src/helper.mjs": "export const helper = true;\n",
      "src/unreferenced.mjs": "export const other = true;\n",
    }, (cwd) => {
      const compile = (file: string) =>
        staticNames([file], { cwd, group: "compile" });
      expect(compile("src/helper.mjs")).toContain("typecheck");
      expect(compile("src/unreferenced.mjs")).not.toContain("typecheck");
    });
  });

  it("runs root typecheck when the tsconfig cannot be read", () => {
    withTempRepo("pharos-static-typecheck", {
      "tsconfig.typecheck.json": "{ not json",
      "src/keep.ts": "export {};",
    }, (cwd) => {
      expect(staticNames(["docs/testing.md"], { cwd, group: "compile" })).toContain("typecheck");
      expect(staticNames(["src/keep.ts"], { cwd, group: "compile" })).toContain("typecheck");
    });
  });

  it("skips root typecheck for a known non-typechecked change set", () => {
    withTempRepo("pharos-static-typecheck", {
      "tsconfig.typecheck.json": JSON.stringify({ include: ["src/**/*.ts"] }),
      "src/keep.ts": "export {};",
    }, (cwd) => {
      expect(staticNames(["src/keep.ts"], { cwd, group: "compile" })).toContain("typecheck");
      expect(staticNames(["docs/testing.md", "src/keep.test.ts"], { cwd, group: "compile" })).not.toContain("typecheck");
    });
  });

  it("runs full-repository lint when the boundary policy changes", () => {
    const names = staticNames(["eslint.config.mjs"], { group: "compile" });
    expect(names).toContain("lint");
    expect(names).not.toContain("lint:changed");
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
    expect(staticNames(changedFiles))
      .not.toContain("check:structural");
    expect(staticNames([...changedFiles, "worker/src/cron/sync-stablecoins.ts"])).toContain("check:structural");
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
      "check:agent-skills",
    ]);
  });

  it.each([[], [0, 7, 8], [0, 1, 2, 3, 4, 5, 6, 7, 8]].map((failedIndexes) => ({ failedIndexes })))(
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
      expect(maxActive).toBe(3);
      expect(code).toBe(failedIndexes.length === 0 ? 0 : 1);
      for (const [index, name] of STRUCTURAL_CHECKS.entries()) {
        expect(output.join("")).toContain(failedIndexes.includes(index)
          ? `${name}: npm run ${name} failed (exit ${index + 1}).`
          : `${name}: passed`);
      }
      expect(output.join("")).toContain(`${STRUCTURAL_CHECKS.length - failedIndexes.length}/${STRUCTURAL_CHECKS.length} guards passed.`);
    },
  );

  it.each([
    ["1", 1],
    ["2", 2],
    ["9", 9],
    ["0", 3],
    ["not-a-number", 3],
  ])("honours PHAROS_STRUCTURAL_CONCURRENCY=%s with %i active guards", async (value, expected) => {
    let active = 0;
    let maxActive = 0;
    const code = await runPrStaticChecks({
      argv: ["--structural"],
      env: { ...process.env, PHAROS_STRUCTURAL_CONCURRENCY: value },
      stdout: { write: () => true },
      runCommandImpl: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(maxActive).toBe(expected);
  });

  it("reports every structural outcome in declaration order even when later guards finish first", async () => {
    const output: string[] = [];
    const code = await runPrStaticChecks({
      argv: ["--structural"],
      env: { ...process.env, PHAROS_STRUCTURAL_CONCURRENCY: "3" },
      stdout: { write: (text: string) => { output.push(text); return true; } },
      runCommandImpl: async (command) => {
        let remaining = STRUCTURAL_CHECKS.length - STRUCTURAL_CHECKS.findIndex((name) => name === command.scriptName);
        while (remaining-- > 0) await Promise.resolve();
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(output.slice(-(STRUCTURAL_CHECKS.length + 1))).toEqual([
      ...STRUCTURAL_CHECKS.map((name) => `[check:structural] ${name}: passed\n`),
      `[check:structural] ${STRUCTURAL_CHECKS.length}/${STRUCTURAL_CHECKS.length} guards passed.\n`,
    ]);
  });

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
    expect(runCommandImpl).toHaveBeenCalledTimes(STRUCTURAL_CHECKS.length);
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

describe("local prepare selection", () => {
  it.each([
    [[], false], [["docs/testing.md"], false], [["scripts/__tests__/example.test.ts"], false],
    [["shared/lib/safety-score-v9/formula.ts"], true],
    [["worker/src/lib/safety-score-v9/fact-set.ts"], true],
    [["shared/data/safety-score-v9/evaluation-build-manifest-v1.ts"], true],
  ] as const)("selects read-only prepare leaves for %j (manifest: %s)", (files, manifest) => {
    const plan = buildPrCheckPlan(files, classifyChangedFiles(files), { withPages: false });
    expect(plan.slice(0, 3)).toEqual(["test-corpus-budget", "incident-review-keys", "new-asset-evidence-packet"]);
    expect(plan.indexOf("safety-score-v9-evaluation-build")).toBe(manifest ? 3 : -1);
    expect(selectCheckableArtifactIds(selectChangedGeneratedArtifactIds(files)))
      .not.toContain("safety-score-v9-evaluation-build");
  });

  it("forwards frozen refs only to prepare range consumers, without test filters or repair flags", () => {
    const base = "b".repeat(40), head = "a".repeat(40);
    const context = { base: "moving-base", resolvedBaseSha: base, head, forwardedTestArgs: ["--testNamePattern=one"] };
    for (const lane of ["test-corpus-budget", "new-asset-evidence-packet"] as const) {
      expect(createLaneCommand(lane, context).args).toEqual(["run", `check:${lane}`, "--", `--base=${base}`, `--head=${head}`]);
    }
    for (const [lane, args] of [
      ["incident-review-keys", ["run", "check:incident-review-keys"]],
      ["safety-score-v9-evaluation-build", ["run", "check:generated-artifacts", "--", "--only=safety-score-v9-evaluation-build"]],
    ] as const) expect(createLaneCommand(lane, context).args).toEqual(args);
  });
});
