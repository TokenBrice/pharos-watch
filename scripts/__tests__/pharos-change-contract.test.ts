import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPermissionRequestHookOutput,
  buildPreToolUseHookOutput,
  buildSessionStartContext,
  buildSessionStartHookOutput,
  classifyChangedFiles,
  formatContract,
  getHookHarness,
  normalizeChangedFiles,
} from "../ci/pharos-change-contract.ts";

function requireBlockingReason(output: unknown): string {
  if (typeof output !== "object" || output === null || !("reason" in output) || typeof output.reason !== "string") {
    throw new Error("Expected a blocking hook output with a reason");
  }

  return output.reason;
}

type HookMode = "pre-tool-use" | "permission-request" | "session-start";

function runHookCliProcess(
  hook: HookMode,
  input = "",
  env: NodeJS.ProcessEnv = process.env,
  extraArgs: readonly string[] = [],
) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(process.cwd(), "scripts/ci/pharos-change-contract.ts"), `--hook=${hook}`, ...extraArgs],
    { cwd: process.cwd(), encoding: "utf8", env, input },
  );
  return {
    ...result,
    stderr: String(result.stderr ?? ""),
    stdout: String(result.stdout ?? ""),
  };
}

function runHookCli(hook: HookMode, input = ""): unknown {
  return JSON.parse(runHookCliProcess(hook, input).stdout);
}

function runContractCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(process.cwd(), "scripts/ci/pharos-change-contract.ts"), ...args],
    { cwd: process.cwd(), encoding: "utf8", env },
  );
  return {
    ...result,
    stderr: String(result.stderr ?? ""),
    stdout: String(result.stdout ?? ""),
  };
}

function docKeys(contract: { docs: Array<{ anchor?: string; path: string }> }): string[] {
  return contract.docs.map((doc) => doc.anchor ? `${doc.path}#${doc.anchor}` : doc.path);
}

function withSqlFixture<T>(sql: string, callback: (path: string) => T): T {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "pharos-change-contract-sql-"));
  const sqlPath = join(fixtureRoot, "query.sql");
  writeFileSync(sqlPath, sql);
  try {
    return callback(sqlPath);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

describe("normalizeChangedFiles", () => {
  it("normalizes path separators, blanks, and duplicates", () => {
    expect(normalizeChangedFiles(["worker\\src\\cron\\sync.ts", "", "worker/src/cron/sync.ts"])).toEqual([
      "worker/src/cron/sync.ts",
    ]);
  });
});

describe("classifyChangedFiles", () => {
  it("routes stablecoin registry changes to data docs", () => {
    const contract = classifyChangedFiles(["shared/data/stablecoins/coins/example-usd.json"]);

    expect(contract.mappings.map((mapping: { id: string }) => mapping.id)).toContain("stablecoin-registry");
    expect(docKeys(contract)).toContain("docs/stablecoin-data.md");
    expect(contract.checks).toContain("npm run check:stablecoin-data");
    // wording is owner-editable in docs/doc-ownership.json (it was reworded by
    // 38dbd97cf), so pin the invariant rather than the sentence.
    expect(contract.hardRules.some((rule: string) => /supply overrides?\b/i.test(rule))).toBe(true);
    expect(contract.deploy.pagesImpact).toBe(true);
    expect(contract.deploy.workerImpact).toBe(true);
  });

  it("routes scheduled Worker changes to cron docs and guardrails", () => {
    const contract = classifyChangedFiles(["worker/src/cron/sync-yield-data.ts"]);

    expect(contract.mappings.map((mapping: { id: string }) => mapping.id)).toContain("worker-cron");
    expect(contract.background.map((doc) => doc.path)).toContain("docs/worker-and-api-limits.md");
    expect(contract.hardRules.some((rule: string) => /six-connection trigger budget/.test(rule))).toBe(true);
    expect(contract.checks).toContain("npm run check:cron-sync");
    expect(contract.checks).toContain("npm run check:cron-connections");

  });
  it("routes blog publishing changes to the frontend contract", () => {
    const contract = classifyChangedFiles(["src/data/blog/posts/example.md"]);

    expect(contract.mappings.map((mapping: { id: string }) => mapping.id)).toContain("frontend-routes");
    expect(docKeys(contract)).toContain("docs/architecture.md#frontend-runtime-and-seo-surface");

  });
  it("routes Telegram delivery changes to the unified Telegram contract", () => {
    const contract = classifyChangedFiles([
      "worker/src/lib/telegram/mini-app-auth.ts",
      "shared/lib/telegram-delivery-policy.ts",
    ]);

    expect(contract.mappings.map((mapping: { id: string }) => mapping.id)).toContain("telegram");
    expect(docKeys(contract)).toContain("docs/telegram-alerts.md#dispatch");

  });
  it("routes feedback verification changes to the Worker API contract", () => {
    const contract = classifyChangedFiles(["worker/src/api/feedback/verification.ts"]);

    expect(contract.mappings.map((mapping: { id: string }) => mapping.id)).toContain("worker-api-auth");
    expect(docKeys(contract)).toContain("docs/api-endpoint-authoring.md");

  });
  it("routes repo-local agent config changes to agent process guidance", () => {
    const contract = classifyChangedFiles([
      ".codex/config.toml",
      ".claude/settings.json",
      "scripts/ci/pharos-change-contract.ts",
    ]);
    expect(contract.checks).toContain("npm run check:generated-artifacts -- --only=agents-doc");
    expect(contract.mappings.map((mapping: { id: string }) => mapping.id)).toContain("agent-hooks-process");
    expect(docKeys(contract)).toContain("docs/process/agent-artifacts.md");
    expect(docKeys(contract)).not.toContain("CLAUDE.md");
  });
  it("includes docs, warnings, and deploy impact in text output", () => {
    const contract = classifyChangedFiles(["worker/migrations/0123_example.sql"]);
    const text = formatContract(contract);

    expect(text).toContain("D1 schema or migration");
    expect(text).toContain("npm run check:migrations");
    expect(text).toContain("D1 migrations are applied before the new Worker is live");
    expect(text).toContain("Scoped context:\n- worker/migrations/AGENTS.md\n- worker/AGENTS.md");
    expect(text).toContain("Also relevant:");
    expect(text).toContain("Deploy impact:");
  });

  it("adds the planned-file next step only for working-tree output", () => {
    const explicit = formatContract(classifyChangedFiles(["src/app/page.tsx"]));
    const workingTree = formatContract({
      ...classifyChangedFiles(["src/app/page.tsx"]),
      source: "working tree",
    });

    expect(explicit).not.toContain("Next: npm run agent:route -- --file <path> for planned files");
    expect(workingTree).toMatch(/Next: npm run agent:route -- --file <path> for planned files$/);
  });
});

describe("representative --file routing", () => {
  function route(file: string) {
    return classifyChangedFiles([file]);
  }

  it("routes a screener component through the shared frontend route contract", () => {
    const contract = route("src/components/screener/screener-table.tsx");
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("frontend-routes");
    expect(docKeys(contract)).toContain("docs/architecture.md#frontend-runtime-and-seo-surface");
    expect(docKeys(contract).length).toBeLessThanOrEqual(3);
    expect(contract.checks).toContain("npm run typecheck");
  });

  it("routes the yield cron to the shared cron contract", () => {
    const contract = route("worker/src/cron/yield-coverage-audit.ts");
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("worker-cron");
    expect(docKeys(contract).slice(0, 3)).toEqual([
      "docs/process/cron-trigger-policy.md",
      "docs/worker-infrastructure.md#module-initialization",
      "docs/process/agent-start-here.md",
    ]);
    expect(contract.scopedContext.slice(0, 2)).toEqual([
      "worker/src/cron/AGENTS.md",
      "worker/AGENTS.md",
    ]);
    expect(contract.checks).toContain("npm run check:cron-sync");
  });

  it("routes a coin record to the addition procedure and scoped context", () => {
    const contract = route("shared/data/stablecoins/coins/usdc-circle.json");
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("stablecoin-registry");
    expect(docKeys(contract)).toContain("docs/process/adding-a-stablecoin.md#source-of-truth");
    expect(contract.scopedContext).toEqual([
      "shared/data/stablecoins/AGENTS.md",
      "shared/AGENTS.md",
    ]);
    expect(contract.checks).toContain("npm run check:stablecoin-data");
  });

  it("routes the digest safety-map type contract to the V9 publication owner", () => {
    const contract = route("shared/types/digest-safety-map-contract.ts");
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("safety-score-v9");
    expect(docKeys(contract)).toContain("docs/digest-pipeline.md#generation");
    expect(docKeys(contract)).toContain("docs/safety-score-map.md");
    expect(contract.checks).toContain("npm run check:doc-sync");
  });

  it("routes the homepage entrypoint through the shared frontend route contract", () => {
    const contract = route("src/app/page.tsx");
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("frontend-routes");
    expect(docKeys(contract)).toContain("docs/architecture.md#frontend-runtime-and-seo-surface");
    expect(docKeys(contract).length).toBeLessThanOrEqual(3);
    expect(contract.checks).toContain("npm run typecheck");
  });

  it("routes the depeg route and its owned modules to the depeg page contract", () => {
    const clientContract = route("src/app/depeg/client.tsx");
    expect(clientContract.mappings.map((mapping) => mapping.id)).toContain("depeg-page");
    expect(docKeys(clientContract)).toContain("docs/depeg-page.md");

    // Route-owned components live outside src/app/depeg/, so the mapping has to
    // reach them too or a hero/board change silently loses its contract.
    const heroContract = route("src/components/depeg-outlook-hero.tsx");
    expect(heroContract.mappings.map((mapping) => mapping.id)).toContain("depeg-page");
    expect(docKeys(heroContract)).toContain("docs/depeg-page.md");

    // The disclosure-gated reviewer fetch contract lives in this hook, not in
    // the client, so it has to route to the same owner.
    const hookContract = route("src/hooks/use-depeg-resolver-surfaces.ts");
    expect(hookContract.mappings.map((mapping) => mapping.id)).toContain("depeg-page");
    expect(docKeys(hookContract)).toContain("docs/depeg-page.md");
  });

  it("routes Next configuration to frontend and deployment owners", () => {
    const contract = route("next.config.ts");
    expect(contract.mappings.map((mapping) => mapping.id)).toEqual(
      expect.arrayContaining(["frontend-routes", "validation-ci-policy"]),
    );
    expect(docKeys(contract)).toContain("docs/deployment-process.md#ci-deploy-sequence");
  });

  it.each([
    "scripts/maintenance/run-focused-checks.ts",
    "scripts/maintenance/build-annotation-candidates.ts",
    "scripts/__tests__/pharos-change-contract.test.ts",
  ])("keeps ordinary script reads bounded for %s", (file) => {
    const contract = route(file);
    expect(contract.mappings.map((mapping) => mapping.id)).toEqual(["scripts-tooling"]);
    expect(docKeys(contract)).toEqual([
      "docs/scripts.md#operator-cli-contract",
      "docs/testing.md#smallest-adequate-check-per-area",
      "docs/process/agent-start-here.md",
    ]);
    expect(contract.scopedContext).toContain("scripts/AGENTS.md");
  });

  it.each([
    ".github/workflows/pages-release.yml",
    "scripts/ci/classify-deploy-changes.ts",
    "scripts/lib/automation-registry.mjs",
    "scripts/lib/deploy-impact.mts",
    "scripts/lib/pr-lanes.mts",
    "scripts/maintenance/run-pr-static-checks.ts",
    "scripts/maintenance/refresh-pages-release-data.ts",
    "scripts/maintenance/run-generated-artifacts.ts",
    "scripts/maintenance/prepare-workspace.ts",
  ])("preserves CI and deployment ownership for %s", (file) => {
    const contract = route(file);
    expect(contract.mappings.find((mapping) => mapping.id === "validation-ci-policy")?.risk).toBe("high");
    expect(docKeys(contract)).toContain("docs/testing.md#ci-pipeline");
    expect(docKeys(contract)).toContain("docs/deployment-process.md#ci-deploy-sequence");
    expect(contract.background.map((doc) => doc.path)).toContain("docs/process/feature-flags.md");
    expect(contract.checks).toContain("npx vitest run scripts/__tests__");
    expect(contract.checks).toContain("npm run check:generated-artifacts");
  });

  it("routes Telegram API ingress to the unified Telegram contract", () => {
    const contract = route("worker/src/api/telegram-webhook.ts");
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("telegram");
    expect(docKeys(contract)).toContain("docs/telegram-architecture.md#1-ingress");
    expect(docKeys(contract)).toContain("docs/telegram-alerts.md#dispatch");
    expect(docKeys(contract)).toContain("docs/telegram-mini-app.md");
    expect(contract.checks).toContain("npm run typecheck");
  });

  it("routes Telegram command handlers to the unified Telegram contract", () => {
    const contract = route("worker/src/api/webhook-commands/subscribe.ts");
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("telegram");
    expect(docKeys(contract)).toContain("docs/telegram-alerts.md#commands");
    expect(docKeys(contract)).toContain("docs/telegram-architecture.md#1-ingress");
    expect(contract.checks).toContain("npm run typecheck");
  });

  it("keeps dynamic guidance out of Read first", () => {
    const result = runContractCli(["--file", "worker/src/cron/sync-yield-data.ts"]);
    expect(result.stdout).toContain("Read first:");
    expect(result.stdout).not.toContain("specific methodology doc");
    expect(result.stdout).not.toContain("matching entries under");
    expect(result.stdout).not.toContain("matched route-specific doc");
  });

  it.each([
    "shared/data/stablecoins/coins/usdc-circle.json",
    "worker/src/api/feedback/verification.ts",
    "shared/data/safety-score-v9/historical-fixtures-v1.json",
  ])("keeps one source path to at most six Read first entries: %s", (file) => {
    expect(route(file).docs.length).toBeLessThanOrEqual(6);
  });

  it("keeps every tracked source path to at most six Read first entries", () => {
    const sourceRoots = ["src/", "shared/", "worker/", "functions/", "scripts/", "docs/", ".github/"];
    const trackedSources = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter((file) => file && sourceRoots.some((root) => file.startsWith(root)))
      .sort();
    const representatives = new Map<string, string>();
    for (const file of trackedSources) {
      const parts = file.split("/");
      const directory = parts.slice(0, Math.min(3, parts.length - 1)).join("/");
      representatives.set(directory, representatives.get(directory) ?? file);
    }
    const overLimit = [...representatives.values()]
      .map((file) => ({ count: classifyChangedFiles([file]).docs.length, file }))
      .filter(({ count }) => count > 6);

    expect(overLimit).toEqual([]);
  });
});

describe("scoped AGENTS.md discovery", () => {
  it.each([
    ["src/AGENTS.md", ["src/AGENTS.md"]],
    ["src/app/page.tsx", ["src/app/AGENTS.md", "src/AGENTS.md"]],
    ["src/components/screener/screener-table.tsx", ["src/components/AGENTS.md", "src/AGENTS.md"]],
    ["shared/AGENTS.md", ["shared/AGENTS.md"]],
    ["shared/data/stablecoins/coins/usdc-circle.json", ["shared/data/stablecoins/AGENTS.md", "shared/AGENTS.md"]],
    ["shared/data/safety-score-v9/historical-fixtures-v1.json", ["shared/data/safety-score-v9/AGENTS.md", "shared/AGENTS.md"]],
    ["worker/AGENTS.md", ["worker/AGENTS.md"]],
    ["worker/src/cron/yield-coverage-audit.ts", ["worker/src/cron/AGENTS.md", "worker/AGENTS.md"]],
    ["worker/migrations/0001_initial.sql", ["worker/migrations/AGENTS.md", "worker/AGENTS.md"]],
    ["functions/_middleware.ts", ["functions/AGENTS.md"]],
    ["scripts/ci/pharos-change-contract.ts", ["scripts/AGENTS.md"]],
    [".github/workflows/pull-request-checks.yml", [".github/workflows/AGENTS.md"]],
  ])("discovers nearest context for %s", (file, expected) => {
    expect(classifyChangedFiles([file]).scopedContext).toEqual(expected);
  });
});

describe("CLI path and source selection", () => {
  it("normalizes absolute and ./ explicit paths before routing", () => {
    const absolute = runContractCli(["--file", resolve(process.cwd(), "src/app/page.tsx"), "--json"]);
    const dotSlash = runContractCli(["--file", "./src/app/page.tsx", "--json"]);
    const absoluteContract = JSON.parse(absolute.stdout);
    const dotSlashContract = JSON.parse(dotSlash.stdout);

    expect(absolute.status).toBe(0);
    expect(dotSlash.status).toBe(0);
    expect(absoluteContract.changedFiles).toEqual(["src/app/page.tsx"]);
    expect(dotSlashContract.changedFiles).toEqual(absoluteContract.changedFiles);
    expect(dotSlashContract.mappings).toEqual(absoluteContract.mappings);
  });

  it("rejects explicit paths outside the repository with exit 2", () => {
    const result = runContractCli(["--file", resolve(process.cwd(), "..", "outside-pharos-change-contract.ts")]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("error: explicit path resolves outside repository");
  });

  it("rejects relative explicit paths that escape the repository with exit 2", () => {
    const result = runContractCli(["--file", "../outside-pharos-change-contract.ts"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("error: explicit path resolves outside repository");
  });

  it("rejects Windows drive paths on every host with exit 2", () => {
    const result = runContractCli(["--file", String.raw`C:\outside\x.ts`]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("error: explicit path resolves outside repository");
  });

  it("rejects an existing repository symlink that targets outside the repository", ({ skip }) => {
    const repositoryFixture = mkdtempSync(join(process.cwd(), ".pharos-change-contract-"));
    const outsideFixture = mkdtempSync(join(tmpdir(), "pharos-change-contract-outside-"));
    const outsideFile = join(outsideFixture, "outside.ts");
    const linkPath = join(repositoryFixture, "outside-link.ts");

    try {
      writeFileSync(outsideFile, "export const outside = true;\n");
      try {
        symlinkSync(outsideFile, linkPath);
      } catch {
        skip();
        return;
      }

      const result = runContractCli(["--file", linkPath]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("error: explicit path resolves outside repository");
    } finally {
      rmSync(repositoryFixture, { force: true, recursive: true });
      rmSync(outsideFixture, { force: true, recursive: true });
    }
  });

  it("accepts an existing repository symlink that targets an in-repository file", ({ skip }) => {
    const repositoryFixture = mkdtempSync(join(process.cwd(), ".pharos-change-contract-"));
    const linkPath = join(repositoryFixture, "in-repo-link.tsx");
    const targetPath = resolve(process.cwd(), "src/app/page.tsx");

    try {
      try {
        symlinkSync(targetPath, linkPath);
      } catch {
        skip();
        return;
      }

      const result = runContractCli(["--file", linkPath, "--json"]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).changedFiles).toEqual([
        `${repositoryFixture.slice(process.cwd().length + 1).replaceAll("\\", "/")}/in-repo-link.tsx`,
      ]);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(repositoryFixture, { force: true, recursive: true });
    }
  });

  it("warns for missing planned files and suppresses it with --new-file", () => {
    const plannedPath = "src/app/__planned-change-contract-file__.tsx";
    const warning = runContractCli(["--file", plannedPath, "--json"]);
    const suppressed = runContractCli(["--file", plannedPath, "--new-file", "--json"]);

    expect(warning.status).toBe(0);
    expect(warning.stderr.trim()).toBe(
      `warning: ${plannedPath} does not exist (routing as a planned new file)`,
    );
    expect(suppressed.status).toBe(0);
    expect(suppressed.stderr).toBe("");
  });

  it("lets --staged take precedence over an environment range and reports the source", () => {
    const env = {
      ...process.env,
      PHAROS_CHANGE_CONTRACT_BASE_REF: "HEAD",
      PHAROS_CHANGE_CONTRACT_HEAD_REF: "HEAD",
    };
    const range = runContractCli(["--json"], env);
    const staged = runContractCli(["--staged", "--json"], env);
    const explicit = runContractCli(["--file", "./src/app/page.tsx", "--staged", "--json"], env);

    expect(JSON.parse(range.stdout).source).toBe("base/head range");
    expect(JSON.parse(staged.stdout).source).toBe("staged index");
    expect(staged.status).toBe(0);
    expect(runContractCli(["--staged"], env).stdout).toContain("Source: staged index");
    expect(JSON.parse(explicit.stdout).source).toBe("explicit files");
  });
});

describe("Codex hook outputs", () => {
  it("emits the compact two-line startup context for an empty tree", () => {
    const contract = classifyChangedFiles([]);
    const context = buildSessionStartContext(contract);

    expect(context.split("\n")).toEqual([
      "Pharos change contract — explicit files (0 files) — deploy: pages=n, worker=n",
      "Route a planned path: npm run agent:route -- --file <path>",
    ]);
    expect(buildSessionStartHookOutput(contract)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
      },
    });
  });

  it("emits bounded read and scoped-context lines for a routed file", () => {
    const context = buildSessionStartContext(classifyChangedFiles(["src/app/page.tsx"]));

    expect(context.split("\n")).toEqual([
      "Pharos change contract — explicit files (1 files) — deploy: pages=y, worker=n",
      "Read first: docs/architecture.md#frontend-runtime-and-seo-surface, docs/process/agent-start-here.md",
      "Scoped context: src/app/AGENTS.md, src/AGENTS.md",
      "Focused checks: npm run lint:changed, npm run typecheck, npx vitest run src",
      "Route a planned path: npm run agent:route -- --file <path>",
    ]);
    expect(context).not.toContain("Hints:");
    expect(context).not.toContain("Core rules:");
  });

  it("keeps the cron contract ahead of its runtime fallback", () => {
    const context = buildSessionStartContext(
      classifyChangedFiles(["worker/src/cron/yield-coverage-audit.ts"]),
    );

    expect(context).toContain(
      "Read first: docs/process/cron-trigger-policy.md, docs/worker-infrastructure.md#module-initialization, docs/process/agent-start-here.md",
    );
    expect(context).toContain(
      "Focused checks: npm run lint:changed, npm run typecheck:worker, npm run check:cron-sync, npm run check:cron-connections",
    );
  });

  it("emits no decision for an allowed PermissionRequest", () => {
    expect(
      buildPermissionRequestHookOutput({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
    ).toEqual({});
  });

  it("does not throw for empty hook stdin", () => {
    expect(runHookCli("pre-tool-use")).toEqual({});
  });
});

describe("hook harness classification", () => {
  it("recognizes a Claude-shaped payload before shared session metadata", () => {
    expect(getHookHarness({
      session_id: "claude-session",
      transcript_path: "/tmp/claude-transcript.jsonl",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
    })).toBe("claude");
  });

  it("recognizes a Codex-specific payload", () => {
    expect(getHookHarness({
      session_id: "codex-session",
      cwd: process.cwd(),
      model: "codex",
      hookEventName: "PermissionRequest",
      toolName: "Bash",
      toolInput: { command: "git status" },
    })).toBe("codex");
  });

  it("does not infer a harness from ambiguous shared metadata", () => {
    expect(getHookHarness({
      session_id: "session",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: process.cwd(),
    })).toBe("unknown");
  });
});

describe("hard-block hook outputs", () => {
  it.each([
    { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" } },
    { tool_name: "exec_command", tool_input: { cmd: "git reset --hard HEAD" } },
    { toolName: "exec_command", toolInput: { cmd: "git reset --hard HEAD" } },
    { tool: "exec_command", arguments: { cmd: "git reset --hard HEAD" } },
    { cmd: "git reset --hard HEAD" },
  ])("inspects shell command fields across supported hook payloads: %j", (input) => {
    expect(buildPreToolUseHookOutput(input)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(buildPermissionRequestHookOutput(input)).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "deny" } },
    });
  });

  it("allows a read-only exec_command cmd payload", () => {
    const input = { tool_name: "exec_command", tool_input: { cmd: "git status --short" } };
    expect(buildPreToolUseHookOutput(input)).toEqual({});
    expect(buildPermissionRequestHookOutput(input)).toEqual({});
  });

  it("blocks destructive git reset commands", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "git reset --hard HEAD",
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("git reset --hard");
  });

  it("allows git pushes that bypass only the advisory local gate", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "git push --no-verify origin main",
      },
    });

    expect(output).toEqual({});
  });

  it("allows git pushes with repeated -C global options when only --no-verify is present", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "git -C /tmp -C /repo push --no-verify origin main",
      },
    });

    expect(output).toEqual({});
  });

  it("blocks git subcommands after git global flags", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "git --no-pager reset --hard HEAD",
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("git reset --hard");
  });

  it("blocks raw production deploy commands", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "cd worker && npx --no-install wrangler versions deploy 00000000-0000-0000-0000-000000000000@100",
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("Raw production deploy commands");
  });

  it("blocks raw production deploy commands inside shell eval wrappers", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: 'bash -lc "cd worker && npx --no-install wrangler pages deploy out"',
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("opaque shell construct around a guarded command; run it directly");
  });

  it("blocks remote D1 mutation commands", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote",
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("Remote D1 mutation commands");
  });

  it("allows searches that mention deploy and remote D1 commands", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command:
          'rg -n "wrangler deploy|wrangler pages deploy|wrangler d1 migrations apply stablecoin-db --remote" docs scripts',
      },
    });

    expect(output).toEqual({});
  });

  it("allows patch payloads that mention deploy commands", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: docs/example.md",
          "@@",
          "+Do not run `wrangler deploy`; use the release workflow.",
          "*** End Patch",
        ].join("\n"),
      },
    });

    expect(output).toEqual({});
  });

  it("blocks deploy commands appended after apply_patch heredocs", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: [
          "apply_patch <<'PATCH'",
          "*** Begin Patch",
          "*** Update File: docs/example.md",
          "@@",
          "+Do not run `wrangler deploy`; use the release workflow.",
          "*** End Patch",
          "PATCH",
          "npx --no-install wrangler pages deploy out",
        ].join("\n"),
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("Raw production deploy commands");
  });

  it("blocks remote D1 mutations appended after apply_patch heredocs", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: [
          "apply_patch <<'PATCH'",
          "*** Begin Patch",
          "*** Update File: docs/example.md",
          "@@",
          "+Mention wrangler d1 execute stablecoin-db --remote without executing it.",
          "*** End Patch",
          "PATCH",
          "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
        ].join("\n"),
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("Remote D1 mutation commands");
  });

  it("blocks protected redirection writes appended after apply_patch heredocs", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: [
          "apply_patch <<'PATCH'",
          "*** Begin Patch",
          "*** Update File: docs/example.md",
          "@@",
          "+Document .env.local without writing it.",
          "*** End Patch",
          "PATCH",
          "echo TOKEN=value > .env.local",
        ].join("\n"),
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("environment files");
  });

  it("still blocks protected paths when patch payloads arrive as commands", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: ["*** Begin Patch", "*** Add File: .env.local", "+TOKEN=value", "*** End Patch"].join("\n"),
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("environment files");
  });

  it("allows heredoc scripts that only quote blocked commands", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: [
          "node - <<'NODE'",
          "console.log('wrangler pages deploy');",
          "console.log('wrangler d1 execute stablecoin-db --remote --command \"delete from cache\"');",
          "NODE",
        ].join("\n"),
      },
    });

    expect(output).toEqual({});
  });

  it("allows help output for deploy-shaped commands", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "npx --no-install wrangler pages deploy --help",
      },
    });

    expect(output).toEqual({});
  });

  it("blocks direct env file writes", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        content: "TOKEN=value",
        file_path: ".env.local",
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("environment files");
  });

  it("blocks obvious destructive migration SQL", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        patch: [
          "*** Begin Patch",
          "*** Update File: worker/migrations/9999_example.sql",
          "@@",
          "+DROP TABLE stablecoin_snapshots;",
          "*** End Patch",
        ].join("\n"),
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("destructive migration SQL");
  });

  it("denies production permission requests", () => {
    const output = buildPermissionRequestHookOutput({
      tool_input: {
        command: "npx wrangler versions deploy",
      },
    });

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: expect.stringContaining("Production deploy permission is denied"),
        },
      },
    });
  });

  it("denies remote D1 mutation permission requests", () => {
    const output = buildPermissionRequestHookOutput({
      tool_input: {
        command: "npx wrangler d1 execute stablecoin-db --remote --command 'update prices set value = 1'",
      },
    });

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: expect.stringContaining("Remote D1 mutation permission is denied"),
        },
      },
    });
  });
});

describe("W2.7 opaque shell guards", () => {
  const blockedOpaqueCommands = [
    ["command substitution", "echo $(git reset --hard HEAD)"],
    ["backticks", "echo `git clean -fd`"],
    ["eval", "eval 'wrangler d1 execute stablecoin-db --remote --command \"delete from cache\"'"],
    ["sh -c", "sh -c 'git reset --hard HEAD'"],
    ["bash -c", "bash -c 'wrangler deploy'"],
    ["zsh -c", "zsh -c 'worker/migrations/0240_guard.sql'"],
    ["pipe to sh", "printf guarded | sh -c 'git clean -fd'"],
    ["background separator", "echo ready & wrangler deploy"],
    ["xargs sh", "printf guarded | xargs sh -c 'git reset --hard HEAD'"],
  ] as const;

  it.each(blockedOpaqueCommands)("blocks a guarded %s construct", (_label, command) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });

    expect(requireBlockingReason(output)).toContain("opaque shell construct around a guarded command; run it directly");
  });

  const allowedOpaqueCommands = [
    ["command substitution", "echo $(git rev-parse HEAD)"],
    ["backticks", "echo `git status --short`"],
    ["eval", "eval 'git status --short'"],
    ["sh -c", "sh -c 'git status --short'"],
    ["bash -c", "bash -c 'git status --short'"],
    ["zsh -c", "zsh -c 'git status --short'"],
    ["pipe to sh", "printf status | sh"],
    ["background separator", "git status --short & echo done"],
    ["xargs sh", "printf status | xargs sh"],
    ["background keyword argument", "echo ready & echo deploy"],
    ["URL keyword argument", "curl https://x/deploy &"],
    ["quoted keyword argument", "echo \"git reset --hard\" > notes.txt"],
    ["unrelated git subcommand", "git log --oneline & sleep 1"],
  ] as const;

  it.each(allowedOpaqueCommands)("allows an unguarded %s construct", (_label, command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });
});

describe("W2.7 shell indirection guards", () => {
  const blockedIndirectionCommands = [
    "sh -c 'git \"$@\"' sh reset --hard",
    "g=git; $g reset --hard",
    "${GIT:-git} reset --hard",
    "command git reset --hard",
    "env git reset --hard",
    "exec git reset --hard",
    "nice git reset --hard",
    "nohup git reset --hard",
    "time git reset --hard",
  ] as const;

  it.each(blockedIndirectionCommands)("blocks %s", (command) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });

    expect(requireBlockingReason(output)).toMatch(/(?:git reset --hard|unresolved shell indirection|opaque shell construct)/);
  });

  const allowedIndirectionCommands = [
    "g=git; $g status --short",
    "${GIT:-git} status --short",
    "command git status --short",
    "env GIT=git git status --short",
    "exec git status --short",
    "nice git status --short",
    "nohup git status --short",
    "time git status --short",
    "sh -c 'git \"$@\"' sh status --short",
  ] as const;

  it.each(allowedIndirectionCommands)("allows an unguarded %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });
});

describe("W2.7 deploy wrappers and previews", () => {
  const blockedDeployWrappers = [
    "pnpm run deploy",
    "pnpm deploy",
    "yarn deploy",
    "bun run deploy",
    "bunx wrangler deploy",
    "npm exec wrangler deploy",
    "npx wrangler versions deploy",
    "pnpm exec wrangler deploy",
    "pnpm dlx wrangler deploy",
    "npm --silent run deploy",
    "npm run --silent deploy",
    "npm -w worker run deploy",
    "yarn workspace worker deploy",
  ] as const;

  it.each(blockedDeployWrappers)("blocks %s", (command) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });

    expect(requireBlockingReason(output)).toContain("Raw production deploy commands");
  });

  it.each([
    "pnpm run test",
    "yarn test",
    "bun run test",
    "npm exec eslint .",
    "pnpm -w worker run test",
    "npm -w worker run test",
    "yarn workspace worker test",
    "bun -C worker run test",
    "pnpm exec wrangler --help",
    "npm x wrangler --help",
  ] as const)(
    "allows a non-deploy package wrapper: %s",
    (command) => {
      expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
    },
  );

  const allowedPreviewCommands = [
    "git clean -fd --dry-run",
    "git clean -fd -n",
    "git clean -fdx --dry-run",
    "wrangler deploy --dry-run",
    "wrangler pages deploy --dry-run",
    "wrangler pages deploy --branch preview --dry-run",
    "wrangler deploy --help",
    "wrangler pages deploy -h",
  ] as const;

  it.each(allowedPreviewCommands)("allows the safe preview %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });

  it("keeps Pages branch deployment blocked without a dry-run", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: { command: "wrangler pages deploy --branch preview" },
    });

    expect(requireBlockingReason(output)).toContain("Raw production deploy commands");
  });
});

describe("W2.7 remote D1 SQL policy", () => {
  const allowedReadOnlyCommands = [
    "npx wrangler d1 execute stablecoin-db --remote --command \"select 1\"",
    "npx wrangler d1 execute stablecoin-db --remote --command \"select 'update delete drop' from prices\"",
    `npx wrangler d1 execute stablecoin-db --remote --command "-- update
SELECT 1"`,
    `npx wrangler d1 execute stablecoin-db --remote --command "/* delete; drop */
SELECT 1"`,
    "npx wrangler d1 execute stablecoin-db --remote --command \"EXPLAIN UPDATE prices SET value = 1\"",
    "npx wrangler d1 execute stablecoin-db --remote --command \"PRAGMA table_info('prices')\"",
    "npx wrangler d1 execute stablecoin-db --remote --command \"WITH rows AS (SELECT 1) SELECT * FROM rows\"",
    "npx wrangler d1 execute stablecoin-db --remote --command \"SELECT 1; EXPLAIN QUERY PLAN SELECT 1\"",
  ] as const;

  it.each(allowedReadOnlyCommands)("allows read-only remote D1 SQL: %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });

  const blockedMutationCommands = [
    "INSERT INTO prices (value) VALUES (1)",
    "UPDATE prices SET value = 1",
    "DELETE FROM prices",
    "DROP TABLE prices",
    "ALTER TABLE prices ADD COLUMN note TEXT",
    "CREATE TABLE prices_copy (value INTEGER)",
    "TRUNCATE prices",
    "REPLACE INTO prices (id, value) VALUES (1, 1)",
    "PRAGMA foreign_keys = ON",
    "SELECT 1; DELETE FROM prices",
    "WITH rows AS (SELECT 1) DELETE FROM prices WHERE id IN (SELECT * FROM rows)",
    "-- comment mentioning SELECT\nUPDATE prices SET value = 1",
  ] as const;

  it.each(blockedMutationCommands)("blocks mutating remote D1 SQL: %s", (sql) => {
    const command = `npx wrangler d1 execute stablecoin-db --remote --command ${JSON.stringify(sql)}`;
    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
      "Remote D1 mutation commands",
    );
  });

  it("parses an existing remote D1 SQL file statement by statement", () => {
    withSqlFixture("-- delete\nSELECT 'update';", (sqlPath) => {
      const command = `npx wrangler d1 execute stablecoin-db --remote --file ${JSON.stringify(sqlPath)}`;
      expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
    });

    withSqlFixture("SELECT 1; DROP TABLE prices;", (sqlPath) => {
      const command = `npx wrangler d1 execute stablecoin-db --remote --file ${JSON.stringify(sqlPath)}`;
      expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
        "Remote D1 mutation commands",
      );
    });
  });

  it("blocks a remote D1 SQL file that cannot be inspected locally", () => {
    const missingRoot = mkdtempSync(join(tmpdir(), "pharos-change-contract-missing-sql-"));
    const missingPath = join(missingRoot, "missing.sql");
    rmSync(missingRoot, { force: true, recursive: true });
    const command = `npx wrangler d1 execute stablecoin-db --remote --file ${JSON.stringify(missingPath)}`;

    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
      "Remote D1 mutation commands",
    );
  });
});

describe("W2.7 protected command writes", () => {
  const blockedWrites = [
    ["rm", "rm -rf out/"],
    ["mv", "mv source .env.local"],
    ["cp destination", "cp source worker/dist/index.js"],
    ["touch", "touch worker/.dev.vars"],
    ["sed -i", "sed -i 's/x/y/' .git/config"],
    ["perl -i", "perl -i -pe 's/x/y/' .envrc"],
    ["truncate", "truncate -s 0 out/cache.bin"],
    [">|", "printf value >| .env.local"],
  ] as const;

  it.each(blockedWrites)("blocks protected %s writes", (_label, command) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(requireBlockingReason(output)).toMatch(/Direct writes to/);
  });

  const allowedWrites = [
    ["rm", "rm -rf agents/tmp"],
    ["mv", "mv source agents/tmp"],
    ["cp source", "cp .env.local agents/env-copy"],
    ["touch", "touch agents/marker"],
    ["sed -i", "sed -i 's/x/y/' agents/file.txt"],
    ["perl -i", "perl -i -pe 's/x/y/' agents/file.txt"],
    ["truncate", "truncate -s 0 agents/file.bin"],
    [">|", "printf value >| agents/file.txt"],
  ] as const;

  it.each(allowedWrites)("allows non-protected %s writes", (_label, command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });
});

describe("W2.7 Python and Node one-line writes", () => {
  const blockedInlineWrites = [
    "python -c 'open(\".env.local\", \"w\").write(\"x\")'",
    "python3 -c 'open(\"worker/dist/index.js\", \"wb\").write(b\"x\")'",
    "node -e 'fs.writeFileSync(\"out/index.html\", data)'",
    "node --eval 'writeFile(\"worker/.dev.vars\", data)'",
  ] as const;

  it.each(blockedInlineWrites)("blocks an inline write to a protected path: %s", (command) => {
    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toMatch(
      /Direct writes to/,
    );
  });

  const allowedInlineCommands = [
    "python -c 'open(\".env.local\", \"r\").read()'",
    "python -c 'print(\".env.local\")'",
    "node -e 'console.log(\"out/index.html\")'",
    "node -e 'fs.writeFileSync(\"agents/index.html\", data)'",
  ] as const;

  it.each(allowedInlineCommands)("allows a non-writing or non-protected inline command: %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });
});

describe("W2.7 malformed hook payloads", () => {
  const hookModes = ["pre-tool-use", "permission-request", "session-start"] as const;
  const diagnostic = "pharos-change-contract: empty or malformed hook payload; no policy applied";

  it.each(hookModes)("returns no decision and logs for empty %s stdin", (hook) => {
    const result = runHookCliProcess(hook);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    expect(result.stderr.trim()).toBe(diagnostic);
  });

  it.each(hookModes)("returns no decision and logs for malformed %s stdin", (hook) => {
    const result = runHookCliProcess(hook, "{not-json");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    expect(result.stderr.trim()).toBe(diagnostic);
  });

  it("does not log for a valid empty hook object", () => {
    const result = runHookCliProcess("pre-tool-use", "{}");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    expect(result.stderr).toBe("");
  });
});

describe("hook diagnostics", () => {
  it("does not write diagnostics when disabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-hook-diagnostics-off-"));
    const diagnosticsPath = join(directory, "hook-diagnostics.jsonl");

    try {
      const result = runHookCliProcess(
        "pre-tool-use",
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" } }),
        {
          ...process.env,
          PHAROS_HOOK_DIAGNOSTICS: "0",
          PHAROS_HOOK_DIAGNOSTICS_FILE: diagnosticsPath,
        },
      );

      expect(result.status).toBe(0);
      expect(() => readFileSync(diagnosticsPath, "utf8")).toThrow();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("writes one secret-free record per hook invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-hook-diagnostics-on-"));
    const diagnosticsPath = join(directory, "hook-diagnostics.jsonl");
    const env = {
      ...process.env,
      PHAROS_HOOK_DIAGNOSTICS: "1",
      PHAROS_HOOK_DIAGNOSTICS_FILE: diagnosticsPath,
    };
    const command = "git reset --hard HEAD";

    try {
      const results = [
        runHookCliProcess(
          "pre-tool-use",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command },
          }),
          env,
        ),
        runHookCliProcess(
          "permission-request",
          JSON.stringify({
            session_id: "codex-session",
            cwd: process.cwd(),
            model: "codex",
            hookEventName: "PermissionRequest",
            toolName: "Bash",
            toolInput: { command },
          }),
          env,
        ),
        runHookCliProcess("session-start", JSON.stringify({ hook_event_name: "SessionStart" }), env),
      ];
      const contents = readFileSync(diagnosticsPath, "utf8");
      const records = contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(results.every((result) => result.status === 0)).toBe(true);
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({
        harness: "claude",
        event: "PreToolUse",
        tool: "Bash",
        decision: "deny",
        rule: "git-destructive",
        pathsProtected: 0,
      });
      expect(records[1]).toMatchObject({
        harness: "codex",
        event: "PermissionRequest",
        tool: "Bash",
        decision: "deny",
        rule: "git-destructive",
      });
      expect(records[2]).toMatchObject({
        harness: "unknown",
        event: "SessionStart",
        tool: null,
        decision: "none",
        rule: null,
      });
      expect(records[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(records[0].commandDigest).toMatch(/^[0-9a-f]{12}$/);
      expect(contents).not.toContain(command);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps the hook decision and exit status when diagnostics cannot be written", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-hook-diagnostics-failure-"));

    try {
      const result = runHookCliProcess(
        "pre-tool-use",
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" } }),
        {
          ...process.env,
          PHAROS_HOOK_DIAGNOSTICS: "1",
          PHAROS_HOOK_DIAGNOSTICS_FILE: directory,
        },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        decision: "block",
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("enables diagnostics with the CLI flag", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-hook-diagnostics-flag-"));
    const diagnosticsPath = join(directory, "hook-diagnostics.jsonl");

    try {
      const result = runHookCliProcess(
        "pre-tool-use",
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo ready" } }),
        {
          ...process.env,
          PHAROS_HOOK_DIAGNOSTICS: "0",
          PHAROS_HOOK_DIAGNOSTICS_FILE: diagnosticsPath,
        },
        ["--diagnostics"],
      );

      expect(result.status).toBe(0);
      expect(readFileSync(diagnosticsPath, "utf8").trim()).toContain('"decision":"allow"');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("W2.7 PermissionRequest parity", () => {
  it.each([
    ["git reset", "git reset --hard HEAD"],
    ["git clean", "git clean -fd"],
    ["protected command write", "rm .env.local"],
  ] as const)("denies %s through the full PreToolUse policy", (_label, command) => {
    const output = buildPermissionRequestHookOutput({ tool_input: { command } });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

  it("denies unsafe migration SQL through PermissionRequest", () => {
    const output = buildPermissionRequestHookOutput({
      tool_input: {
        file_path: "worker/migrations/9999_permission.sql",
        content: "DROP TABLE stablecoin_snapshots;",
      },
    });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

  it("denies opaque guarded commands through PermissionRequest", () => {
    const output = buildPermissionRequestHookOutput({
      tool_input: { command: "echo $(git reset --hard HEAD)" },
    });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: expect.stringContaining("opaque shell construct around a guarded command; run it directly"),
        },
      },
    });
  });

  it("keeps safe previews and read-only D1 requests allowed", () => {
    expect(
      buildPermissionRequestHookOutput({
        tool_input: { command: "git clean -fd --dry-run" },
      }),
    ).toEqual({});
    expect(
      buildPermissionRequestHookOutput({
        tool_input: { command: "npx wrangler d1 execute stablecoin-db --remote --command 'select 1'" },
      }),
    ).toEqual({});
  });
});

describe("repo Codex hook config", () => {
  it("keeps Codex hook configuration user-local instead of tracked", () => {
    const trackedConfig = execFileSync(
      "git",
      ["ls-files", "--", ".codex/config.toml", ".codex/hooks.json"],
      { encoding: "utf8" },
    ).trim();

    expect(trackedConfig).toBe("");
  });
});

describe("repo Claude hook config", () => {
  it("wires only SessionStart and the PreToolUse guards", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), ".claude/settings.json"), "utf8"));

    expect(config.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact|fork");
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("--hook=session-start");
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain("--hook=pre-tool-use");
    expect(config.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(config.hooks.PreToolUse[1].hooks[0].command).toContain("--hook=pre-tool-use");

    expect(config.hooks.UserPromptSubmit).toBeUndefined();
    expect(config.hooks.PostToolUse).toBeUndefined();
    expect(config.hooks.PostToolBatch).toBeUndefined();
  });
});
