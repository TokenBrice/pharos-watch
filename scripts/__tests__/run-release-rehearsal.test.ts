import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { checkWorkerPackage } from "../ci/check-worker-package.ts";
import { PAGES_PREVIOUS_SITEMAP_URL } from "../ci/run-pages-artifact-lane.ts";
import { runReleaseRehearsal } from "../maintenance/run-release-rehearsal.ts";

describe("offline release rehearsal", () => {
  it("preserves typechecking, selects the offline Pages profile, then validates migrations before packaging", async () => {
    const calls: string[] = [];
    const runPages = vi.fn(async () => {
      calls.push("pages");
      return { dataStatus: "degraded-data" as const };
    });
    const report = vi.fn();
    await runReleaseRehearsal({}, {
      runCommand: (command) => { calls.push(command.scriptName); return 0; }, runPages, report,
    });
    expect(calls).toEqual(["pages", "check:migrations", "check:worker-package"]);
    expect(runPages).toHaveBeenCalledWith({ acquireReleaseData: false, preserveTypecheck: true });
    expect(report.mock.calls.flat().some((message) => message.includes("continuity skipped"))).toBe(true);
  });

  it("fetches published archive continuity only when explicitly opted in, using the production URL", async () => {
    const runPages = vi.fn(async () => ({ dataStatus: "degraded-data" as const }));
    await runReleaseRehearsal({ liveContinuity: true }, { runCommand: () => 0, runPages, report: () => {} });
    expect(runPages).toHaveBeenCalledWith({
      acquireReleaseData: false, preserveTypecheck: true, previousSitemapUrl: PAGES_PREVIOUS_SITEMAP_URL,
    });
    const workflow = parseYaml(readFileSync(".github/workflows/pages-release.yml", "utf8"));
    const continuity = workflow.jobs["pages-release"].steps.find(
      (step: { env?: Record<string, string> }) => step.env?.SEO_PREVIOUS_SITEMAP_URL,
    );
    expect(continuity.env.SEO_PREVIOUS_SITEMAP_URL).toBe(PAGES_PREVIOUS_SITEMAP_URL);
  });

  it.each(["check:migrations", "check:worker-package"])("fails closed when %s fails", async (failure) => {
    const calls: string[] = [];
    await expect(runReleaseRehearsal({}, {
      runCommand: (command) => {
        calls.push(command.scriptName);
        return command.scriptName === failure ? 1 : 0;
      },
      runPages: async () => { calls.push("pages"); return { dataStatus: "degraded-data" }; },
      report: () => {},
    })).rejects.toThrow(`${failure} failed`);
    expect(calls.at(-1)).toBe(failure);
  });

  it("does not claim migration or bundle proof after the Pages artifact gate fails", async () => {
    const calls: string[] = [];
    await expect(runReleaseRehearsal({}, {
      runCommand: (command) => { calls.push(command.scriptName); return 0; },
      runPages: async () => { throw new Error("artifact failure"); }, report: () => {},
    })).rejects.toThrow("artifact failure");
    expect(calls).toEqual([]);
  });
});

describe("Worker release packaging", () => {
  it("strictly dry-runs both production roles with the same strict/config contract as deploy", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-strict-package-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const calls: string[][] = [];
    try {
      expect(checkWorkerPackage({ run: (command, args, options) => {
        expect(command).toBe("npx");
        expect(options.cwd).toBe(join(root, "worker"));
        calls.push(args);
        return { status: 0 };
      } }).status).toBe(0);
    } finally {
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
    const workflow = parseYaml(readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8"));
    const deployCommands = workflow.jobs["deploy-worker"].steps
      .map((step: { run?: string }) => step.run ?? "")
      .filter((run: string) => /wrangler deploy\b/.test(run));
    expect(calls).toHaveLength(2);
    expect(deployCommands).toHaveLength(2);
    for (const args of calls) {
      expect(args).toContain("--strict");
      expect(args).toContain("--dry-run");
      const config = args[args.indexOf("--config") + 1];
      const production = deployCommands.find((run: string) => run.includes(`--config ${config}`));
      expect(production).toMatch(/wrangler deploy\s+--strict\b/);
    }
  });
});
