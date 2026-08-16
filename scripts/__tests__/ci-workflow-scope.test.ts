import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("CI workflow scope", () => {
  it("keeps successful Pages release snapshots when another refresh fails open", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/pages-release.yml")) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const refreshStep = workflow.jobs["pages-release"].steps?.find(
      (step) => step.name === "Refresh API-backed release data",
    );
    const run = refreshStep?.run ?? "";

    expect(run).toContain("git checkout -- data/digests.json");
    expect(run).toContain("git checkout -- data/depeg-events.json");
    expect(run).toContain("git checkout -- public/datasets");
    expect(run).not.toContain(
      "git checkout -- data/digests.json data/depeg-events.json public/datasets",
    );
  });

  it("packages the Worker before production D1 mutation", () => {
    const workflow = readRepoFile(".github/workflows/deploy-cloudflare.yml");
    const packageStep = workflow.indexOf("npm run check:worker-package");
    const migrationStep = workflow.indexOf("wrangler d1 migrations apply stablecoin-db --remote");

    expect(packageStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(packageStep);
  });

  it("records read-only post-deploy acceptance for successfully deployed surfaces", () => {
    const workflow = parseYaml(readRepoFile(".github/workflows/deploy-cloudflare.yml")) as {
      jobs: Record<string, {
        environment?: unknown;
        needs?: string[];
        outputs?: Record<string, string>;
        permissions?: Record<string, string>;
        steps?: Array<{ id?: string; name?: string; run?: string }>;
      }>;
    };
    const job = workflow.jobs["post-deploy-acceptance"];
    const acceptanceStep = job.steps?.find((step) => step.id === "acceptance");

    expect(job.needs).toEqual(["plan", "deploy-worker", "pages-release"]);
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.outputs).toEqual({ outcome: "${{ steps.acceptance.outputs.outcome }}" });
    expect(acceptanceStep?.name).toContain("read-only");
    expect(acceptanceStep?.run).toContain("selectPostDeployProbes");
    expect(acceptanceStep?.run).toContain("collectWorkerHttpProbes");
    expect(acceptanceStep?.run).toContain('from "./scripts/lib/worker-http-probes.mts"');
    expect(acceptanceStep?.run).toContain('from "./scripts/lib/post-deploy-acceptance.mts"');
    expect(acceptanceStep?.run).toContain("Outcome:");
    expect(acceptanceStep?.run).toContain("automatic rollback");
    expect(acceptanceStep?.run).not.toContain("wrangler");
    expect(acceptanceStep?.run).not.toContain("CLOUDFLARE_API_TOKEN");
  });
});
