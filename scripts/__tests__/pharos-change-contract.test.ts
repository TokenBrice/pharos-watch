import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPermissionRequestHookOutput,
  buildPreToolUseHookOutput,
  classifyChangedFiles,
  findShellCommandViolation,
} from "../ci/pharos-change-contract.ts";
import { PATH_FAMILIES } from "../lib/doc-ownership-registry.mts";
import { analyzeShellCommand } from "../lib/shell-command-analysis.ts";

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
    { cwd: process.cwd(), encoding: "utf8", env, input, timeout: 15_000 },
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

describe("representative --file routing", () => {
  function route(file: string) {
    return classifyChangedFiles([file]);
  }

  it("caps single-path guidance while preserving ranked overflow in background", () => {
    const originalLength = PATH_FAMILIES.length;
    const family = {
      background: [], checks: [], hardRules: [], hints: [], scopedContext: [],
      sourceGlobs: ["audit-overflow.fixture"], tier: "specific" as const,
    };
    PATH_FAMILIES.push(
      { ...family, id: "low", label: "A low", risk: "low", docs: [{ path: "low.md" }] },
      { ...family, id: "high", label: "Z high", risk: "high",
        docs: ["one.md", "two.md", "three.md", "four.md", "five.md", "six.md", "seven.md"].map((path) => ({ path })) },
    );
    try {
      const contract = route("audit-overflow.fixture");
      expect(docKeys(contract)).toEqual(["one.md", "two.md", "three.md", "four.md", "five.md", "six.md"]);
      expect(contract.background.slice(0, 2)).toEqual([{ path: "seven.md" }, { path: "low.md" }]);
      expect(contract.background.some((doc) => docKeys(contract).includes(doc.path))).toBe(false);
    } finally {
      PATH_FAMILIES.splice(originalLength);
    }
  });
});

describe("Codex hook outputs", () => {
  it("emits no decision for an allowed PermissionRequest", () => {
    expect(
      buildPermissionRequestHookOutput({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
    ).toEqual({});
  });
});

describe("shell command analysis", () => {
  it("provides one immutable command view to ordered policies", () => {
    const analysis = analyzeShellCommand(
      "git reset --hard HEAD && npx wrangler pages deploy out",
      process.cwd(),
    );

    expect(Object.isFrozen(analysis)).toBe(true);
    expect(Object.isFrozen(analysis.invocations)).toBe(true);
    expect(analysis.invocations.map((invocation) => invocation.name)).toEqual([
      "git",
      "wrangler",
    ]);
    expect(findShellCommandViolation(analysis)?.rule).toBe("git-destructive");
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

  function patchHeredocThen(mention: string, command: string): string {
    return [
      "apply_patch <<'PATCH'",
      "*** Begin Patch",
      "*** Update File: docs/example.md",
      "@@",
      `+${mention}`,
      "*** End Patch",
      "PATCH",
      command,
    ].join("\n");
  }

  it.each([
    ["destructive git reset", "git reset --hard HEAD", "git reset --hard"],
    ["git global flags", "git --no-pager reset --hard HEAD", "git reset --hard"],
    ["production deploy", "cd worker && npx --no-install wrangler versions deploy 00000000-0000-0000-0000-000000000000@100", "Raw production deploy commands"],
    ["heavy production deploy", "cd worker && npx --no-install wrangler deploy --config wrangler.heavy.toml", "Raw production deploy commands"],
    ["shell eval wrapper", 'bash -lc "cd worker && npx --no-install wrangler pages deploy out"', "opaque shell construct"],
    ["remote D1 mutation", "cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote", "Remote D1 mutation commands"],
    [
      "a deploy appended after an apply_patch heredoc",
      patchHeredocThen(
        "Do not run `wrangler deploy`; use the release workflow.",
        "npx --no-install wrangler pages deploy out",
      ),
      "Raw production deploy commands",
    ],
    [
      "a remote D1 mutation appended after an apply_patch heredoc",
      patchHeredocThen(
        "Mention wrangler d1 execute stablecoin-db --remote without executing it.",
        "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
      ),
      "Remote D1 mutation commands",
    ],
    [
      "a protected redirection appended after an apply_patch heredoc",
      patchHeredocThen("Document .env.local without writing it.", "echo TOKEN=value > .env.local"),
      "environment files",
    ],
    [
      "a patch payload that adds a protected path",
      ["*** Begin Patch", "*** Add File: .env.local", "+TOKEN=value", "*** End Patch"].join("\n"),
      "environment files",
    ],
    [
      "a guarded substitution hidden in a heredoc body",
      ["cat <<EOF", "$(npx wrangler d1 execute stablecoin-db --remote --command 'DELETE FROM cache')", "EOF"].join("\n"),
      "opaque shell construct",
    ],
    [
      "a guarded substitution in the first of two heredocs opened on one line",
      [
        "cat <<FIRST <<SECOND",
        "$(npx wrangler d1 execute stablecoin-db --remote --command 'DELETE FROM cache')",
        "FIRST",
        "benign",
        "SECOND",
      ].join("\n"),
      "opaque shell construct",
    ],
    [
      "a remote D1 mutation hidden behind a comment fake heredoc marker",
      [
        "cat <<EOF # <<FAKE",
        "benign",
        "EOF",
        "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
      ].join("\n"),
      "Remote D1 mutation commands",
    ],
    [
      "a remote D1 mutation hidden behind a quoted fake heredoc marker",
      [
        "cat <<EOF '<<FAKE'",
        "benign",
        "EOF",
        "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
      ].join("\n"),
      "Remote D1 mutation commands",
    ],
    [
      "a deploy hidden behind a comment fake heredoc marker",
      ["cat <<EOF # <<FAKE", "benign", "EOF", "npx --no-install wrangler pages deploy out"].join("\n"),
      "Raw production deploy commands",
    ],
    [
      "a guarded command hidden in an unterminated heredoc",
      [
        "cat <<EOF",
        "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
      ].join("\n"),
      "opaque shell construct",
    ],
  ])("blocks %s with its denial category", (_name, command, reason) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });
    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(requireBlockingReason(output)).toContain(reason);
  });

  it("denies fake-heredoc-marker-hidden mutations in both hook modes", () => {
    const command = [
      "cat <<EOF # <<FAKE",
      "benign",
      "EOF",
      "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
    ].join("\n");

    const preToolUse = buildPreToolUseHookOutput({ tool_input: { command } });
    expect(preToolUse).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(requireBlockingReason(preToolUse)).toContain("Remote D1 mutation commands");
    expect(buildPermissionRequestHookOutput({ tool_input: { command } })).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "deny" } },
    });
  });

  it.each([
    ["bypassing only the advisory local gate", "git push --no-verify origin main"],
    ["bypassing the advisory local gate behind -C flags", "git -C /tmp -C /repo push --no-verify origin main"],
    [
      "a search that mentions deploy and remote D1 commands",
      'rg -n "wrangler deploy|wrangler pages deploy|wrangler d1 migrations apply stablecoin-db --remote" docs scripts',
    ],
    [
      "a patch payload that only mentions deploy commands",
      [
        "*** Begin Patch",
        "*** Update File: docs/example.md",
        "@@",
        "+Do not run `wrangler deploy`; use the release workflow.",
        "*** End Patch",
      ].join("\n"),
    ],
    [
      "a heredoc script that only quotes blocked commands",
      [
        "node - <<'NODE'",
        "console.log('wrangler pages deploy');",
        "console.log('wrangler d1 execute stablecoin-db --remote --command \"delete from cache\"');",
        "NODE",
      ].join("\n"),
    ],
    ["help output for a deploy-shaped command", "npx --no-install wrangler pages deploy --help"],
  ])("allows %s", (_name, command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });

  it.each([
    {
      name: "a direct env file write",
      tool_input: { content: "TOKEN=value", file_path: ".env.local" },
      reason: "environment files",
    },
    {
      name: "destructive migration SQL",
      tool_input: {
        patch: [
          "*** Begin Patch",
          "*** Update File: worker/migrations/9999_example.sql",
          "@@",
          "+DROP TABLE stablecoin_snapshots;",
          "*** End Patch",
        ].join("\n"),
      },
      reason: "destructive migration SQL",
    },
  ])("blocks $name arriving without a command", ({ tool_input, reason }) => {
    const output = buildPreToolUseHookOutput({ tool_input });
    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(requireBlockingReason(output)).toContain(reason);
  });

  it.each([
    ["production deploys", "npx wrangler versions deploy", "Production deploy permission is denied"],
    [
      "remote D1 mutations",
      "npx wrangler d1 execute stablecoin-db --remote --command 'update prices set value = 1'",
      "Remote D1 mutation permission is denied",
    ],
  ])("denies %s as permission requests", (_name, command, message) => {
    expect(buildPermissionRequestHookOutput({ tool_input: { command } })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: expect.stringContaining(message),
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
    ["stdin-fed reset", "printf '%s\\n' 'git reset --hard HEAD' | sh"],
    ["stdin-fed deploy", "printf '%s\\n' 'wrangler pages deploy out' | sh"],
    ["stdin-fed remote D1 mutation", "printf '%s\\n' 'wrangler d1 execute stablecoin-db --remote --command \"DELETE FROM cache\"' | sh"],
    ["wrapped stdin shell", "printf '%s\\n' 'git reset --hard HEAD' | env CI=1 command sh"],
    ["wrapped stdin producer", "env CI=1 printf '%s\\n' 'git reset --hard HEAD' | nice -n 2 bash"],
    ["dash stdin shell", "echo 'git reset --hard HEAD' | /bin/dash"],
    ["multi-stage stdin pipeline", "printf '%s\\n' 'git reset --hard HEAD' | cat | exec sh"],
    ["opaque guarded stdin producer", "cat 'git reset --hard HEAD' | sh"],
    ["split printf script", "printf '%s %s\\n' git 'reset --hard HEAD' | sh"],
    ["nested stdin pipeline", "sh -c \"printf '%s\\\\n' 'git reset --hard HEAD' | env sh\""],
    ["background separator", "echo ready & wrangler deploy"],
    ["xargs sh", "printf guarded | xargs sh -c 'git reset --hard HEAD'"],
  ] as const;

  it.each(blockedOpaqueCommands)("blocks a guarded %s construct", (_label, command) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });

    expect(requireBlockingReason(output)).toContain("opaque shell construct around a guarded command; run it directly");
  });

  it.each([
    "printf '%s\\n' 'git reset --hard HEAD' | sh",
    "printf '%s\\n' 'wrangler pages deploy out' | sh",
    "printf '%s\\n' 'wrangler d1 execute stablecoin-db --remote --command \"DELETE FROM cache\"' | env sh",
  ])("denies guarded stdin scripts in permission requests: %s", (command) => {
    expect(buildPermissionRequestHookOutput({ tool_input: { command } })).toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: "deny", message: expect.stringContaining("opaque shell construct around a guarded command") },
      },
    });
  });

  const allowedOpaqueCommands = [
    ["command substitution", "echo $(git rev-parse HEAD)"],
    ["backticks", "echo `git status --short`"],
    ["eval", "eval 'git status --short'"],
    ["sh -c", "sh -c 'git status --short'"],
    ["bash -c", "bash -c 'git status --short'"],
    ["zsh -c", "zsh -c 'git status --short'"],
    ["pipe to sh", "printf status | sh"],
    ["wrapped stdin shell", "printf status | env CI=1 command sh"],
    ["stdin-fed read-only git", "printf '%s\\n' 'git status --short' | sh"],
    ["stdin-fed deployment help", "printf '%s\\n' 'wrangler deploy --help' | sh"],
    ["stdin-fed literal example", "printf '%s\\n' \"echo 'git reset --hard HEAD'\" | sh"],
    ["unrelated pipeline keyword", "echo 'git reset --hard HEAD'; printf status | sh"],
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

  const blockedVersionQualifiedDeploys = [
    "npx wrangler@4 deploy",
    "npx --yes wrangler@latest pages deploy out",
    "npx wrangler@^4.0.0 versions deploy 00000000-0000-0000-0000-000000000000@100",
    "bunx wrangler@4.20.0 deploy",
    "pnpm dlx wrangler@4 deploy",
    "pnpm exec wrangler@4 deploy",
    "npm exec wrangler@4 deploy",
    "npm x wrangler@4 pages deploy out",
    "pnpm dlx cf-tools@npm:wrangler deploy",
  ] as const;

  it.each(blockedVersionQualifiedDeploys)("blocks the version-qualified deploy %s", (command) => {
    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
      "Raw production deploy commands",
    );
  });

  const blockedVersionQualifiedRemoteD1 = [
    "npx wrangler@4 d1 execute stablecoin-db --remote --command 'delete from cache'",
    "bunx wrangler@4 d1 migrations apply stablecoin-db --remote",
    "pnpm dlx cf-tools@npm:wrangler d1 execute stablecoin-db --remote --command 'update prices set value = 1'",
  ] as const;

  it.each(blockedVersionQualifiedRemoteD1)("blocks the version-qualified remote D1 mutation %s", (command) => {
    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
      "Remote D1 mutation commands",
    );
  });

  it.each([
    "npx wrangler@4 d1 execute stablecoin-db --remote --command 'select 1'",
    "npx wrangler@4 deploy --dry-run",
    "npx wrangler@4 deploy --help",
    "npx wrangler@4 --version",
  ] as const)("allows the safe version-qualified invocation %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
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
    "WITH d AS (DELETE FROM t RETURNING *) SELECT count(*) FROM d",
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
  it.each([
    { cwd: "worker", tool_input: { command: "touch dist/missing.js" }, denied: true },
    { cwd: "worker", tool_input: { command: "touch dist/missing.js", workdir: "../agents" }, denied: false },
    { cwd: "agents", tool_input: { command: "touch dist/missing.js", workdir: "../worker" }, denied: true },
  ])("resolves write policy using session cwd and tool override: %j", ({ denied, ...input }) => {
    const output = buildPreToolUseHookOutput(input);
    if (denied) {
      expect(output).toMatchObject({ decision: "block", hookSpecificOutput: { permissionDecision: "deny" } });
      expect(requireBlockingReason(output)).toContain("build outputs");
    } else {
      expect(output).toEqual({});
    }
  });

  it("canonicalizes an innocuous symlink before checking a missing child write", () => {
    const root = mkdtempSync(join(process.cwd(), ".pharos-policy-"));
    try {
      // The alias reaches the repository root, whose missing build child is protected.
      symlinkSync(process.cwd(), join(root, "innocuous"), "dir");
      const input = { cwd: root, tool_input: { command: "touch innocuous/build/audit-missing/file.js" } };
      expect(buildPreToolUseHookOutput(input)).toMatchObject({
        decision: "block", hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(buildPreToolUseHookOutput({
        cwd: root, tool_input: { command: "touch innocuous/agents/audit-missing/file.js" },
      })).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
  it.each([
    ["empty", ""],
    ["truncated", '{"tool_name": "Bash", "tool_inp'],
    ["non-object", '"text"'],
    ["array", "[]"],
  ])("denies a %s payload in both enforcement modes", (_label, payload) => {
    const preToolUse = runHookCliProcess("pre-tool-use", payload);
    expect(preToolUse.status).toBe(2);
    expect(JSON.parse(preToolUse.stdout)).toMatchObject({
      decision: "block",
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(preToolUse.stderr).toContain("[rule:malformed-hook-input]");

    const permissionRequest = runHookCliProcess("permission-request", payload);
    expect(permissionRequest.status).toBe(2);
    expect(JSON.parse(permissionRequest.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

});

describe("hook diagnostics", () => {
  it.each(["symlink", "hardlink", "fifo"])("does not write or block on a diagnostic %s", (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-hook-diagnostics-link-"));
    const target = join(directory, "target");
    const diagnosticsPath = join(directory, "diagnostics");
    writeFileSync(target, "unchanged");
    try {
      if (kind === "symlink") symlinkSync(target, diagnosticsPath);
      else if (kind === "hardlink") linkSync(target, diagnosticsPath);
      else execFileSync("mkfifo", [diagnosticsPath]);
      const result = runHookCliProcess("pre-tool-use", "{}", {
        ...process.env, PHAROS_HOOK_DIAGNOSTICS: "1", PHAROS_HOOK_DIAGNOSTICS_FILE: diagnosticsPath,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("unchanged");
    } finally {
      rmSync(directory, { recursive: true, force: true });
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
    const secrets = ["SECRET_ARGUMENT_91", "SECRET_CONTENT_52", "SECRET_SESSION_73"];
    const command = `git reset --hard HEAD ${secrets[0]}`;

    try {
      const results = [
        runHookCliProcess(
          "pre-tool-use",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: secrets[2],
            tool_name: "Bash",
            tool_input: { command },
          }),
          env,
        ),
        runHookCliProcess(
          "permission-request",
          JSON.stringify({
            session_id: secrets[2],
            cwd: process.cwd(),
            model: "codex",
            hookEventName: "PermissionRequest",
            toolName: "Bash",
            toolInput: { command },
          }),
          env,
        ),
        runHookCliProcess("pre-tool-use", JSON.stringify({
          hook_event_name: "PreToolUse", tool_name: "Write",
          tool_input: { file_path: ".env.local", content: secrets[1] },
          session_id: secrets[2],
        }), env),
        runHookCliProcess("session-start", JSON.stringify({ hook_event_name: "SessionStart", session_id: secrets[2] }), env),
      ];
      const contents = readFileSync(diagnosticsPath, "utf8");
      const records = contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(results.every((result) => result.status === 0)).toBe(true);
      expect(records).toHaveLength(4);
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
        event: "PreToolUse", tool: "Write", decision: "deny", rule: "protected-write",
      });
      expect(records[3]).toMatchObject({
        harness: "unknown",
        event: "SessionStart",
        tool: null,
        decision: "none",
        rule: null,
      });
      expect(records[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(records[0].commandDigest).toMatch(/^[0-9a-f]{12}$/);
      expect(contents).not.toContain(command);
      for (const secret of secrets) expect(contents).not.toContain(secret);
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
