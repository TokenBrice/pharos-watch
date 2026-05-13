import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSessionStartContext,
  buildSessionStartHookOutput,
  buildStopHookOutput,
  classifyChangedFiles,
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
});

describe("repo Codex hook config", () => {
  it("enables SessionStart and Stop hooks through tracked repo config", () => {
    const config = readFileSync(resolve(process.cwd(), ".codex/config.toml"), "utf8");

    expect(config).toContain("codex_hooks = true");
    expect(config).toContain("[[hooks.SessionStart]]");
    expect(config).toContain("--hook=session-start");
    expect(config).toContain("[[hooks.Stop]]");
    expect(config).toContain("--hook=stop");
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
