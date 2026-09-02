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
  normalizeChangedFiles,
} from "../ci/pharos-change-contract.ts";

function requireBlockingReason(output: unknown): string {
  if (typeof output !== "object" || output === null || !("reason" in output) || typeof output.reason !== "string") {
    throw new Error("Expected a blocking hook output with a reason");
  }

  return output.reason;
}

function runHookCli(hook: "pre-tool-use" | "permission-request", input = ""): unknown {
  return JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", resolve(process.cwd(), "scripts/ci/pharos-change-contract.ts"), `--hook=${hook}`], {
      encoding: "utf8",
      input,
    }),
  );
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

describe("normalizeChangedFiles", () => {
  it("normalizes path separators, blanks, and duplicates", () => {
    expect(normalizeChangedFiles(["worker\\src\\cron\\sync.ts", "", "worker/src/cron/sync.ts"])).toEqual([
      "worker/src/cron/sync.ts",
    ]);
  });
});

describe("classifyChangedFiles", () => {
  it("routes stablecoin registry changes to data docs and checks", () => {
    const contract = classifyChangedFiles(["shared/data/stablecoins/coins/example-usd.json"]);

    expect(contract.families.map((family: { id: string }) => family.id)).toContain("stablecoin-registry");
    expect(contract.docsToRead).toContain("docs/stablecoin-data.md");
    expect(contract.checks).toContain("npm run check:stablecoin-data");
    // The family's supply-override hard rule must reach the contract. Its exact
    // wording is owner-editable in docs/doc-ownership.json (it was reworded by
    // 38dbd97cf), so pin the invariant rather than the sentence.
    expect(contract.hardRules.some((rule: string) => /supply overrides?\b/i.test(rule))).toBe(true);
    expect(contract.deploy.pagesImpact).toBe(true);
    expect(contract.deploy.workerImpact).toBe(true);
  });

  it("routes scheduled Worker changes to cron docs and guardrails", () => {
    const contract = classifyChangedFiles(["worker/src/cron/sync-yield-data.ts"]);

    expect(contract.families.map((family: { id: string }) => family.id)).toContain("worker-cron");
    expect(contract.docsToRead).toContain("docs/worker-and-api-limits.md");
    expect(contract.checks).toContain("npm run check:cron-sync");
    expect(contract.checks).toContain("npm run check:cron-connections");
    expect(contract.hardRules).toContain("Cron jobs share Cloudflare's per-trigger 6-connection pool.");
  });

  it("routes blog publishing changes to the editorial process and its focused suites", () => {
    const contract = classifyChangedFiles(["src/data/blog/posts/example.md"]);

    expect(contract.families.map((family: { id: string }) => family.id)).toContain("editorial-publishing");
    expect(contract.docsToRead).toContain("docs/process/blog-publishing.md");
    expect(contract.checks).toContain(
      "npx vitest run src/data/blog src/app/feed src/app/__tests__/sitemap-frozen.test.ts",
    );
  });

  it("routes Telegram auth and delivery changes to Telegram contracts and runbooks", () => {
    const contract = classifyChangedFiles([
      "worker/src/lib/telegram-mini-app-auth.ts",
      "shared/lib/telegram-delivery-policy.ts",
    ]);

    expect(contract.families.map((family: { id: string }) => family.id)).toContain("telegram");
    expect(contract.docsToRead).toContain("docs/telegram-mini-app.md");
    expect(contract.docsToRead).toContain("docs/telegram-alerts.md");
  });

  it("routes feedback verification changes to the feedback contract", () => {
    const contract = classifyChangedFiles(["worker/src/api/feedback/verification.ts"]);

    expect(contract.families.map((family: { id: string }) => family.id)).toContain("feedback");
    expect(contract.docsToRead).toContain("docs/feedback-pipeline.md");
  });

  it("routes repo-local agent config changes to agent process guidance", () => {
    const contract = classifyChangedFiles([
      ".codex/config.toml",
      ".claude/settings.json",
      "scripts/ci/pharos-change-contract.ts",
    ]);

    expect(contract.families.map((family: { id: string }) => family.id)).toContain("agent-hooks-process");
    expect(contract.docsToRead).toContain("docs/process/agent-artifacts.md");
    expect(contract.checks).toContain("focused hook/script tests");
  });
});

describe("formatContract", () => {
  it("includes docs, checks, warnings, and deploy impact in text output", () => {
    const contract = classifyChangedFiles(["worker/migrations/0123_example.sql"]);
    const text = formatContract(contract);

    expect(text).toContain("D1 schema or migration");
    expect(text).toContain("npm run check:migrations");
    expect(text).toContain("D1 migrations are applied before the new Worker is live");
    expect(text).toContain("Deploy impact:");
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
    expect(dotSlashContract.families).toEqual(absoluteContract.families);
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
  it("injects concise startup context when there is no current diff", () => {
    const contract = classifyChangedFiles([]);

    expect(buildSessionStartContext(contract)).toContain("docs/agent-task-router.md");
    expect(buildSessionStartHookOutput(contract)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
      },
    });
  });

  it("emits no decision for an allowed Codex-shaped PreToolUse Bash payload", () => {
    expect(
      buildPreToolUseHookOutput({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
    ).toEqual({});
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

describe("hard-block hook outputs", () => {
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
    expect(requireBlockingReason(output)).toContain("Raw production deploy commands");
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
