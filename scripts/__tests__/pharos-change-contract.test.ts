import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPermissionRequestHookOutput,
  buildPreToolUseHookOutput,
  buildSessionStartContext,
  buildSessionStartHookOutput,
  classifyChangedFiles,
  formatContract,
  formatContractMarkdown,
  normalizeChangedFiles,
} from "../ci/pharos-change-contract.mjs";
import { findExistingComment, parseNextLink, upsertPrComment } from "../ci/upsert-github-pr-comment.mjs";

function requireBlockingReason(output: unknown): string {
  if (typeof output !== "object" || output === null || !("reason" in output) || typeof output.reason !== "string") {
    throw new Error("Expected a blocking hook output with a reason");
  }

  return output.reason;
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
    expect(contract.hardRules).toContain("Do not add manual supply overrides.");
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

  it("routes repo-local agent config changes to agent process guidance", () => {
    const contract = classifyChangedFiles([
      ".codex/config.toml",
      ".claude/settings.json",
      "scripts/ci/pharos-change-contract.mjs",
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

  it("renders a stable Markdown PR comment body", () => {
    const contract = classifyChangedFiles(["shared/data/stablecoins/coins/example-usd.json"]);
    const markdown = formatContractMarkdown(contract);

    expect(markdown).toContain("<!-- pharos-change-contract -->");
    expect(markdown).toContain("### Pharos Change Contract");
    expect(markdown).toContain("| Stablecoin metadata or registry | high |");
    expect(markdown).toContain("npm run check:stablecoin-data");
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

  it("blocks git pushes that bypass the merge gate", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "git push --no-verify origin main",
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("pre-push merge gate");
  });

  it("blocks git pushes with repeated -C global options", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "git -C /tmp -C /repo push --no-verify origin main",
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(requireBlockingReason(output)).toContain("pre-push merge gate");
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

    expect(output).toEqual({ continue: true });
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

    expect(output).toEqual({ continue: true });
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

    expect(output).toEqual({ continue: true });
  });

  it("allows help output for deploy-shaped commands", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: {
        command: "npx --no-install wrangler pages deploy --help",
      },
    });

    expect(output).toEqual({ continue: true });
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
    expect(existsSync(resolve(process.cwd(), ".codex/config.toml"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), ".codex/hooks.json"))).toBe(false);
  });
});

describe("repo Claude hook config", () => {
  it("wires only SessionStart and the PreToolUse guards", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), ".claude/settings.json"), "utf8"));

    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("--hook=session-start");
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain("--hook=pre-tool-use");
    expect(config.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(config.hooks.PreToolUse[1].hooks[0].command).toContain("--hook=pre-tool-use");

    expect(config.hooks.UserPromptSubmit).toBeUndefined();
    expect(config.hooks.PostToolUse).toBeUndefined();
    expect(config.hooks.PostToolBatch).toBeUndefined();
  });
});

describe("upsert GitHub PR comment", () => {
  it("parses the rel=next URL from a Link header", () => {
    const header =
      '<https://api.github.com/repos/o/r/issues/1/comments?page=2>; rel="next", ' +
      '<https://api.github.com/repos/o/r/issues/1/comments?page=5>; rel="last"';
    expect(parseNextLink(header)).toBe("https://api.github.com/repos/o/r/issues/1/comments?page=2");
    expect(parseNextLink('<https://x>; rel="last"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });

  it("follows Link pagination to find a marker comment beyond the first page", async () => {
    const page2Url = "https://api.github.com/repos/owner/repo/issues/12/comments?page=2";
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/issues/12/comments?per_page=100")) {
        return new Response(JSON.stringify([{ id: 1, body: "noise" }]), {
          headers: { link: `<${page2Url}>; rel="next"` },
        });
      }
      if (url === page2Url) {
        return new Response(JSON.stringify([{ id: 77, body: "<!-- pharos-change-contract --> old" }]));
      }
      return new Response(JSON.stringify({ id: 77 }));
    };

    await expect(
      upsertPrComment(
        {
          body: "<!-- pharos-change-contract -->\nbody",
          prNumber: "12",
          repo: "owner/repo",
          token: "token",
        },
        { fetchImpl },
      ),
    ).resolves.toEqual({ action: "updated", commentId: 77 });

    expect(calls).toContain(page2Url);
  });

  it("finds the most recent marker comment", () => {
    expect(
      findExistingComment([
        { id: 1, body: "<!-- pharos-change-contract --> old" },
        { id: 2, body: "other" },
        { id: 3, body: "<!-- pharos-change-contract --> new" },
      ])?.id,
    ).toBe(3);
  });

  it("patches an existing marker comment", async () => {
    const calls: Array<{ body?: string; method?: string; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        body: typeof init?.body === "string" ? init.body : undefined,
        method: init?.method,
        url,
      });
      if (url.endsWith("/issues/12/comments?per_page=100")) {
        return new Response(JSON.stringify([{ id: 44, body: "<!-- pharos-change-contract --> old" }]));
      }
      return new Response(JSON.stringify({ id: 44 }));
    };

    await expect(
      upsertPrComment(
        {
          body: "<!-- pharos-change-contract -->\nbody",
          prNumber: "12",
          repo: "owner/repo",
          token: "token",
        },
        { fetchImpl },
      ),
    ).resolves.toEqual({ action: "updated", commentId: 44 });

    expect(calls.at(-1)).toMatchObject({
      body: JSON.stringify({ body: "<!-- pharos-change-contract -->\nbody" }),
      method: "PATCH",
      url: "https://api.github.com/repos/owner/repo/issues/comments/44",
    });
  });

  it("skips comment upserts when the GitHub token cannot write comments", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          message: "Resource not accessible by integration",
          status: "403",
        }),
        { status: 403 },
      );

    await expect(
      upsertPrComment(
        {
          body: "<!-- pharos-change-contract -->\nbody",
          prNumber: "12",
          repo: "owner/repo",
          token: "token",
        },
        { fetchImpl },
      ),
    ).resolves.toEqual({ action: "skipped", reason: "forbidden" });
  });
});
