import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCodexHookConfig, renderCodexHookConfig, runAgentHookSetup } from "../maintenance/setup-agent-hooks.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("agent hook setup", () => {
  it("keeps the Codex hook surface stateless and deterministic", () => {
    expect(Object.keys(buildCodexHookConfig().hooks).sort()).toEqual([
      "PermissionRequest",
      "PreToolUse",
      "SessionStart",
    ]);
    expect(renderCodexHookConfig()).toContain("pharos-change-contract.mjs");
    expect(renderCodexHookConfig()).not.toContain("PostToolUse");
    expect(renderCodexHookConfig()).not.toContain("Stop");
  });

  it("requires opt-in, then detects the installed config without rewriting it", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "pharos-agent-hooks-"));
    temporaryDirectories.push(directory);
    const hooksPath = resolve(directory, "hooks.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runAgentHookSetup({ hooksPath, install: false })).toBe(1);
    expect(runAgentHookSetup({ hooksPath, install: true })).toBe(0);
    expect(readFileSync(hooksPath, "utf8")).toBe(renderCodexHookConfig());
    expect(runAgentHookSetup({ hooksPath, install: false })).toBe(0);
  });
});

describe("agent release guidance", () => {
  it("stays aligned with the protected PR and single-deploy Worker release", () => {
    const root = process.cwd();
    const skillRoot = resolve(root, ".codex/skills");
    const guidance = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const files = [resolve(skillRoot, entry.name, "SKILL.md")];
        if (entry.name === "pharos-release-runner") {
          files.push(resolve(skillRoot, entry.name, "agents/openai.yaml"));
        }
        return files.map((path) => readFileSync(path, "utf8"));
      });

    for (const text of guidance) {
      expect(text).not.toContain("git push origin main");
      expect(text).not.toMatch(/pre-push hook[^.\n]*authoritative/i);
    }

    const deployGuard = readFileSync(resolve(root, "scripts/ci/guard-worker-deploy.mjs"), "utf8");
    expect(deployGuard).toContain("wrangler deploy --strict");
    expect(deployGuard).toContain("100% of production traffic");
    expect(deployGuard).not.toContain("preview-smokes");

    const currentReleaseDocs = [
      "docs/deployment-process.md",
      "docs/operator-origin-access.md",
      "docs/runbooks/db-connectivity.md",
      "docs/runbooks/telegram-group-admin-gating-rollback.md",
      "docs/worker-infrastructure.md",
      "worker/migrations/MANIFEST.md",
    ].map((path) => readFileSync(resolve(root, path), "utf8"));
    for (const text of currentReleaseDocs) {
      expect(text).not.toContain("worker_promotion_required");
      expect(text).not.toContain("wrangler versions upload");
      expect(text).not.toContain("preview-smoke");
      expect(text).not.toContain("Worker promotion");
    }
  });
});
