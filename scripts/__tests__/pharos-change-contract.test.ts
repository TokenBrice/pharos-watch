import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPermissionRequestHookOutput,
  buildPostToolUseHookOutput,
  buildPreToolUseHookOutput,
  buildSessionStartContext,
  buildSessionStartHookOutput,
  buildStopHookOutput,
  buildUserPromptSubmitHookOutput,
  classifyChangedFiles,
  classifyUserPrompt,
  findChangedSinceBaseline,
  findSessionChangedFiles,
  formatContract,
  formatContractMarkdown,
  normalizeChangedFiles,
} from "../pharos-change-contract.mjs";
import { findExistingComment, upsertPrComment } from "../upsert-github-pr-comment.mjs";

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

    expect(contract.families.map((family) => family.id)).toContain("stablecoin-registry");
    expect(contract.docsToRead).toContain("docs/stablecoin-data.md");
    expect(contract.checks).toContain("npm run check:stablecoin-data");
    expect(contract.hardRules).toContain("Do not add manual supply overrides.");
    expect(contract.deploy.pagesImpact).toBe(true);
    expect(contract.deploy.workerImpact).toBe(true);
  });

  it("routes scheduled Worker changes to cron docs and guardrails", () => {
    const contract = classifyChangedFiles(["worker/src/cron/sync-yield-data.ts"]);

    expect(contract.families.map((family) => family.id)).toContain("worker-cron");
    expect(contract.docsToRead).toContain("docs/worker-and-api-limits.md");
    expect(contract.checks).toContain("npm run check:cron-sync");
    expect(contract.checks).toContain("npm run check:cron-connections");
    expect(contract.hardRules).toContain("Cron jobs share Cloudflare's per-trigger 6-connection pool.");
  });

  it("routes repo-local Codex config changes to agent process guidance", () => {
    const contract = classifyChangedFiles([".codex/config.toml", "scripts/pharos-change-contract.mjs"]);

    expect(contract.families.map((family) => family.id)).toContain("agent-hooks-process");
    expect(contract.docsToRead).toContain("docs/process/agent-artifacts.md");
    expect(contract.checks).toContain("focused hook/script tests");
  });
});

describe("session delta helpers", () => {
  it("keeps only files that changed after the session baseline", () => {
    expect(findChangedSinceBaseline({
      ".codex/config.toml": "same",
      ".claude/settings.json": "new",
      "docs/scripts.md": "absent",
      "scripts/pharos-change-contract.mjs": "after",
    }, {
      ".codex/config.toml": "same",
      "docs/scripts.md": "before",
      "scripts/pharos-change-contract.mjs": "before",
    })).toEqual([
      ".claude/settings.json",
      "docs/scripts.md",
      "scripts/pharos-change-contract.mjs",
    ]);
  });

  it("keeps unchanged pre-session dirty files out of the active session delta", () => {
    const fingerprints: Record<string, string> = {
      "docs/scripts.md": "baseline-dirty",
      "scripts/pharos-change-contract.mjs": "new-session-change",
    };

    expect(findSessionChangedFiles([
      "docs/scripts.md",
      "scripts/pharos-change-contract.mjs",
    ], {
      "docs/scripts.md": "baseline-dirty",
    }, {
      buildFingerprints: (files) => Object.fromEntries(files.map((file) => [file, fingerprints[file]])),
    })).toEqual(["scripts/pharos-change-contract.mjs"]);
  });

  it("includes pre-session dirty files when their current dirty fingerprint changes", () => {
    expect(findSessionChangedFiles(["docs/scripts.md"], {
      "docs/scripts.md": "baseline-dirty",
    }, {
      buildFingerprints: () => ({ "docs/scripts.md": "modified-after-baseline" }),
    })).toEqual(["docs/scripts.md"]);
  });

  it("does not report a pre-session dirty file after it is restored clean", () => {
    expect(findSessionChangedFiles(["scripts/pharos-change-contract.mjs"], {
      "docs/scripts.md": "baseline-dirty",
    }, {
      buildFingerprints: () => ({ "scripts/pharos-change-contract.mjs": "new-session-change" }),
    })).toEqual(["scripts/pharos-change-contract.mjs"]);
  });
});

describe("UserPromptSubmit hook outputs", () => {
  it("routes stablecoin prompts to stablecoin docs and checks", () => {
    const route = classifyUserPrompt("add a stablecoin with contracts, reserves, and CoinGecko data");

    expect(route.families.map((family) => family.id)).toContain("stablecoin-registry");
    expect(route.docsToRead).toContain("docs/stablecoin-data.md");
    expect(route.checks).toContain("npm run check:stablecoin-data");
  });

  it("injects advisory context for matched prompts", () => {
    const output = buildUserPromptSubmitHookOutput({
      prompt: "Change a D1 migration and update a cron job",
    });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
      },
    });
    expect(output.hookSpecificOutput?.additionalContext).toContain("worker/migrations/MANIFEST.md");
    expect(output.hookSpecificOutput?.additionalContext).toContain("npm run check:cron-sync");
  });

  it("stays quiet for unrelated prompts", () => {
    expect(buildUserPromptSubmitHookOutput({ prompt: "what is the current branch?" })).toEqual({ continue: true });
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

  it("continues normally when Stop has no changed files", () => {
    expect(buildStopHookOutput(classifyChangedFiles([]))).toEqual({ continue: true });
  });

  it("continues normally when Stop has already continued once", () => {
    const contract = classifyChangedFiles(["worker/src/cron/sync-yield-data.ts"]);

    expect(buildStopHookOutput(contract, { stop_hook_active: true })).toEqual({ continue: true });
  });

  it("blocks finalization once when a changed-file contract needs attention", () => {
    const contract = classifyChangedFiles(["worker/src/cron/sync-yield-data.ts"]);
    const output = buildStopHookOutput(contract);

    expect(output).toMatchObject({ decision: "block" });
    expect(output.reason).toContain("Before finalizing this Pharos turn");
    expect(output.reason).toContain("npm run check:cron-sync");
  });

  it("does not block Stop or emit a reminder for low-risk-only changes", () => {
    const contract = classifyChangedFiles(["docs/scripts.md"]);
    expect(contract.families.every((family) => family.risk === "low")).toBe(true);

    expect(buildStopHookOutput(contract)).toEqual({ continue: true });
    expect(buildPostToolUseHookOutput(contract, {}, { dedupe: false })).toEqual({ continue: true });
  });

  it("injects PostToolUse reminders without auto-running checks", () => {
    const contract = classifyChangedFiles(["worker/src/cron/sync-yield-data.ts"]);
    const output = buildPostToolUseHookOutput(contract, {}, { dedupe: false });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
      },
    });
    expect(output.hookSpecificOutput?.additionalContext).toContain("npm run check:cron-sync");
    expect(output.hookSpecificOutput?.additionalContext).toContain("do not auto-run heavy checks");
  });

  it("dedupes PostToolBatch against a prior PostToolUse with the same contract", () => {
    const contract = classifyChangedFiles(["worker/src/cron/sync-yield-data.ts"]);
    const hookInput = { session_id: `dedupe-cross-event-${Date.now()}-${Math.random()}` };

    const firstUse = buildPostToolUseHookOutput(contract, hookInput, { eventName: "PostToolUse" });
    expect(firstUse.hookSpecificOutput?.hookEventName).toBe("PostToolUse");

    const followingBatch = buildPostToolUseHookOutput(contract, hookInput, { eventName: "PostToolBatch" });
    expect(followingBatch).toEqual({ continue: true });

    const repeatUse = buildPostToolUseHookOutput(contract, hookInput, { eventName: "PostToolUse" });
    expect(repeatUse).toEqual({ continue: true });
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
    expect(output.reason).toContain("git reset --hard");
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
    expect(output.reason).toContain("environment files");
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
    expect(output.reason).toContain("destructive migration SQL");
  });

  it("denies production permission requests", () => {
    const output = buildPermissionRequestHookOutput({
      tool_input: {
        command: "npx wrangler versions deploy",
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        permissionDecision: "deny",
      },
    });
    expect(output.reason).toContain("Production deploy permission is denied");
  });

  it("denies remote D1 mutation permission requests", () => {
    const output = buildPermissionRequestHookOutput({
      tool_input: {
        command: "npx wrangler d1 execute stablecoin-db --remote --command 'update prices set value = 1'",
      },
    });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        permissionDecision: "deny",
      },
    });
    expect(output.reason).toContain("Remote D1 mutation permission is denied");
  });
});

describe("repo Codex hook config", () => {
  it("enables the tracked repo hook set", () => {
    const config = readFileSync(resolve(process.cwd(), ".codex/config.toml"), "utf8");

    expect(config).toContain("hooks = true");
    expect(config).not.toContain("codex_hooks");
    expect(config).toContain("[[hooks.SessionStart]]");
    expect(config).toContain("--hook=session-start");
    expect(config).toContain("[[hooks.UserPromptSubmit]]");
    expect(config).toContain("--hook=user-prompt-submit");
    expect(config).toContain("[[hooks.PreToolUse]]");
    expect(config).toContain("--hook=pre-tool-use");
    expect(config).toContain("[[hooks.PermissionRequest]]");
    expect(config).toContain("--hook=permission-request");
    expect(config).toContain("[[hooks.PostToolUse]]");
    expect(config).toContain("--hook=post-tool-use");
    expect(config).toContain("[[hooks.Stop]]");
    expect(config).toContain("--hook=stop");
    expect(config).toContain("[[hooks.PreToolUse.hooks]]");
    expect(config).toContain("type = \"command\"");
  });

  it("uses catch-all Codex tool matchers so native tool names are covered", () => {
    const config = readFileSync(resolve(process.cwd(), ".codex/config.toml"), "utf8");

    expect(config).not.toContain('matcher = "Bash|apply_patch|Edit|MultiEdit|Write"');
    expect(config).not.toContain('matcher = "Bash"');
    expect(config).toContain('matcher = ".*"');
  });
});

describe("repo Claude hook config", () => {
  it("enables Claude parity hooks and preserves the pre-push gate", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), ".claude/settings.json"), "utf8"));

    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("--hook=session-start");
    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--hook=user-prompt-submit");
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain("--hook=pre-tool-use");
    expect(config.hooks.PreToolUse[0].hooks[1].command).toContain(".claude/hooks/pre-push-gate.sh");
    expect(config.hooks.PostToolUse[0].hooks[0].command).toContain("--hook=post-tool-use");
    expect(config.hooks.PostToolBatch[0].hooks[0].command).toContain("--hook=post-tool-batch");
    expect(config.hooks.Stop[0].hooks[0].command).toContain("--hook=stop");
  });
});

describe("upsert GitHub PR comment", () => {
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
    const fetchImpl = async (url: string, init: { body?: string; method?: string } = {}) => {
      calls.push({ body: init.body, method: init.method, url });
      if (url.endsWith("/issues/12/comments?per_page=100")) {
        return new Response(JSON.stringify([{ id: 44, body: "<!-- pharos-change-contract --> old" }]));
      }
      return new Response(JSON.stringify({ id: 44 }));
    };

    await expect(
      upsertPrComment({
        body: "<!-- pharos-change-contract -->\nbody",
        prNumber: "12",
        repo: "owner/repo",
        token: "token",
      }, { fetchImpl }),
    ).resolves.toEqual({ action: "updated", commentId: 44 });

    expect(calls.at(-1)).toMatchObject({
      body: JSON.stringify({ body: "<!-- pharos-change-contract -->\nbody" }),
      method: "PATCH",
      url: "https://api.github.com/repos/owner/repo/issues/comments/44",
    });
  });
});
