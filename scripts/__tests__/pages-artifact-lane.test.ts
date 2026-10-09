import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pagesArtifactEnvironment, runPagesArtifactLane } from "../ci/run-pages-artifact-lane.ts";
import { createPagesReleaseDataArchive, isPagesReleaseDataMember, mergeDatasetAliases, overlayPagesReleaseData, selectPagesReleaseArtifacts } from "../lib/pages-release-data.mts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawnSync: spawn,
}));

const aliases = (target: string) => `# BEGIN GENERATED PUBLIC DATASET ALIASES\n/datasets/topic/latest.json /datasets/topic/${target}.json 200\n# END GENERATED PUBLIC DATASET ALIASES`;
const write = (root: string, path: string, value: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
};

function dataFixture(root: string): void {
  write(root, "data/digests.json", '{"release":true}');
  write(root, "data/depeg-events/index.json", '{"release":true}');
  write(root, "public/datasets/topic/2026-10-07.json", '{"release":true}');
  write(root, "public/_redirects", `${aliases("2026-10-07")}\n/release-only /target 301\n`);
  write(root, "src/lib/datasets/public-dataset-current.ts", 'export const date = "2026-10-07";');
  write(root, "src/generated/stablecoin-detail-snapshots/existing.json", '{"lanes":{"liveSummary":{"price":1}}}');
  write(root, "src/generated/stablecoin-detail-snapshots/removed.json", '{"lanes":{}}');
}

describe("Pages artifact input profile", () => {
  it("forces the production proxy and disables ambient live acquisition/continuity", () => {
    const env = pagesArtifactEnvironment({
      PUBLIC_DATASETS_API_URL: "https://not-allowed.example", API_BASE_URL: "https://not-allowed.example",
      PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP: "1", PHAROS_DETAIL_SNAPSHOT_CHECK: "0",
      SEO_PREVIOUS_SITEMAP_URL: "https://not-allowed.example/sitemap.xml",
      NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "false", NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS: "true",
    });
    expect(env).toMatchObject({
      NODE_ENV: "production", NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true",
      NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS: "true", PHAROS_DETAIL_SNAPSHOT_CHECK: "1",
      PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP: "", PUBLIC_DATASETS_API_URL: "", API_BASE_URL: "",
      SEO_PREVIOUS_SITEMAP_URL: "",
    });
    expect(pagesArtifactEnvironment({}, "https://explicit.example/sitemap.xml").SEO_PREVIOUS_SITEMAP_URL).toBe("https://explicit.example/sitemap.xml");
  });

  it("never forwards acquisition tokens or other credentials to generator/build children", async () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-pages-child-env-"));
    try {
      dataFixture(root);
      for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SITE_API_SHARED_SECRET", "PHAROS_API_KEY", "CLOUDFLARE_API_TOKEN", "npm_config_auth"]) {
        vi.stubEnv(name, "test-credential");
      }
      spawn.mockReset();
      spawn.mockReturnValue({ status: 0, signal: null });
      const result = await runPagesArtifactLane({ repoRoot: root, acquireReleaseData: false });
      expect(result.dataStatus).toBe("degraded-data");
      expect(spawn.mock.calls.length).toBeGreaterThan(0);
      for (const call of spawn.mock.calls) {
        const childEnv = call[2].env as NodeJS.ProcessEnv;
        expect(childEnv.NODE_ENV).toBe("production");
        for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SITE_API_SHARED_SECRET", "PHAROS_API_KEY", "CLOUDFLARE_API_TOKEN", "npm_config_auth"]) {
          expect(childEnv).not.toHaveProperty(name);
        }
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores post-refresh outputs it regenerated from release data, even when a gate fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-pages-restore-"));
    try {
      dataFixture(root);
      write(root, "public/llms.txt", "candidate llms\n");
      spawn.mockReset();
      spawn.mockImplementation((_program: string, args: string[]) => {
        if (args.includes("generated:post-refresh")) write(root, "public/llms.txt", "release-derived llms\n");
        return { status: args.includes("check:pages-release") ? 1 : 0, signal: null };
      });
      await expect(runPagesArtifactLane({ repoRoot: root, acquireReleaseData: false })).rejects.toThrow(/pages-release-artifact-gates/);
      expect(readFileSync(join(root, "public/llms.txt"), "utf8")).toBe("candidate llms\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("considers only unexpired identity-matched main artifacts, newest first", () => {
    const sha = "a".repeat(40);
    const artifact = { id: 1, name: `pages-release-data-${sha}`, expired: false, created_at: "2026-10-07", workflow_run: { id: 10, head_branch: "main", head_sha: sha } };
    expect(selectPagesReleaseArtifacts([
      artifact,
      { ...artifact, id: 2, created_at: "2026-10-08" },
      { ...artifact, id: 3, expired: true },
      { ...artifact, id: 4, name: "pages-release-data-other" },
      { ...artifact, id: 5, workflow_run: { ...artifact.workflow_run, head_branch: "candidate" } },
    ]).map((entry) => entry.id)).toEqual([2, 1]);
  });
});

describe("Pages release data archive", () => {
  it.each([".env", "public/datasets/.env", "data/depeg-events/../secret.json", "src/generated/stablecoin-detail-snapshots/../../secret.json", "public/_redirects/extra", "/data/digests.json", "data//digests.json"])("rejects non-public or traversing member %s", (path) => {
    expect(isPagesReleaseDataMember(path)).toBe(false);
  });

  it("replays release inputs without replacing candidate redirects or resurrecting removed coins", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-release-data-test-"));
    try {
      const release = join(root, "release");
      const candidate = join(root, "candidate");
      dataFixture(release);
      write(candidate, "public/_redirects", `/candidate-only /new 301\n${aliases("2026-10-01")}\n`);
      write(candidate, "src/generated/stablecoin-detail-snapshots/existing.json", '{"lanes":{}}');
      write(candidate, "src/generated/stablecoin-detail-snapshots/new.json", '{"lanes":{}}');
      const archive = join(root, "data.tar.zst");
      createPagesReleaseDataArchive(release, archive);
      overlayPagesReleaseData(candidate, archive, join(root, "staging"));
      expect(readFileSync(join(candidate, "public/_redirects"), "utf8")).toBe(`/candidate-only /new 301\n${aliases("2026-10-07")}\n`);
      expect(readFileSync(join(candidate, "src/generated/stablecoin-detail-snapshots/existing.json"), "utf8")).toContain('"price":1');
      expect(readFileSync(join(candidate, "src/generated/stablecoin-detail-snapshots/new.json"), "utf8")).toBe('{"lanes":{}}');
      expect(() => readFileSync(join(candidate, "src/generated/stablecoin-detail-snapshots/removed.json"))).toThrow();
      expect(readFileSync(join(candidate, "data/digests.json"), "utf8")).toBe('{"release":true}');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses to publish unexpected files or links inside allowed data directories", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-release-data-test-"));
    try {
      dataFixture(root);
      write(root, "public/datasets/.env", "not-a-public-input");
      expect(() => createPagesReleaseDataArchive(root, join(root, "data.tar.zst"))).toThrow(/refusing to archive/);
      rmSync(join(root, "public/datasets/.env"));
      symlinkSync(join(root, "data/digests.json"), join(root, "public/datasets/link.json"));
      expect(() => createPagesReleaseDataArchive(root, join(root, "data.tar.zst"))).toThrow(/refusing to archive/);
      // Downloaded transport receives the same path boundary, before extraction.
      execFileSync("tar", ["--zstd", "-cf", join(root, "bad.tar.zst"), "public/datasets/link.json"], { cwd: root });
      expect(() => overlayPagesReleaseData(root, join(root, "bad.tar.zst"), join(root, "stage"))).toThrow(/links are forbidden/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects missing alias blocks instead of replacing candidate configuration", () => {
    expect(() => mergeDatasetAliases("/auth /login 301", aliases("2026-10-07"))).toThrow(/missing.*alias block/);
  });
});
