import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileInputStageArtifacts, criticalCssScopeForLane, dropRetiredDepegEventEntries, ogRenderCheckForLane, pagesArtifactEnvironment, preparedWorkspaceCompileInputArtifacts, runPagesArtifactLane } from "../ci/run-pages-artifact-lane.ts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { depegLedgerCaptureId } from "../lib/depeg-ledger-capture.ts";
import { PAGES_RELEASE_DATA_ARCHIVE, createPagesReleaseDataArchive, isPagesReleaseDataMember, mergeDatasetAliases, overlayPagesReleaseData, preparePagesReleaseData, selectPagesReleaseArtifacts, selectPagesReleaseRuns } from "../lib/pages-release-data.mts";
import { createTempRepoTracker } from "./helpers/test-state";

const { makeRoot, cleanup } = createTempRepoTracker("pages-artifact-lane");
beforeEach(() => { spawn.mockReset().mockReturnValue({ status: 0, signal: null }); });
afterEach(() => { vi.unstubAllEnvs(); cleanup(); });

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFileSync: vi.fn((await importOriginal<typeof ChildProcess>()).execFileSync),
  spawnSync: spawn,
}));

const aliases = (t: string) => `# BEGIN GENERATED PUBLIC DATASET ALIASES\n/datasets/topic/latest.json /datasets/topic/${t}.json 200\n# END GENERATED PUBLIC DATASET ALIASES`;
const write = (r: string, p: string, v: string) => { mkdirSync(dirname(join(r, p)), { recursive: true }); writeFileSync(join(r, p), v); };
const read = (r: string, p: string) => readFileSync(join(r, p), "utf8");
const buf = (v: unknown) => Buffer.from(JSON.stringify(v));
const stub = (k: string, v?: string) => vi.stubEnv(k, v);
const runDeg = (repoRoot: string) => runPagesArtifactLane({ repoRoot, acquireReleaseData: false });
const findCall = (t: string) => spawn.mock.calls.find((c) => c[1].includes(t));
const callsWith = (t: string) => spawn.mock.calls.filter((c) => c[1].some((a: string) => a.includes(t)));
const SNAP = "src/generated/stablecoin-detail-snapshots", POST = "generated:post-refresh", COMP = "generated:compile-input";
const RERUN_IDS = ["editorial-style", "legacy-stablecoin-redirects", "mint-burn-conservation-runtime"];

function preparedCompileInputOutputs(root: string): void {
  for (const a of GENERATED_ARTIFACT_REGISTRY as { id: string; buildLifecycle: string; outputPaths: string[] }[]) {
    if (a.buildLifecycle !== "compile-input" || RERUN_IDS.includes(a.id)) continue;
    for (const out of a.outputPaths) write(root, out, "{}");
  }
}

function dataFixture(root: string): void {
  for (const [p, v] of [
    ["data/digests.json", '{"release":true}'], ["data/depeg-events/index.json", '{"release":true}'],
    ["data/depeg-events/metadata/capture.json", '{"release":true}'], ["public/datasets/topic/2026-10-07.json", '{"release":true}'],
    ["public/_redirects", `${aliases("2026-10-07")}\n/release-only /target 301\n`],
    ["src/lib/datasets/public-dataset-current.ts", 'export const date = "2026-10-07";'],
    [`${SNAP}/existing.json`, '{"lanes":{"liveSummary":{"price":1}}}'], [`${SNAP}/removed.json`, '{"lanes":{}}'],
  ]) write(root, p, v);
}
const fixtureRoot = () => { const r = makeRoot(); dataFixture(r); return r; };

describe("Pages artifact input profile", () => {
  it("forces the production proxy and disables ambient live acquisition/continuity", () => {
    const env = pagesArtifactEnvironment({
      PUBLIC_DATASETS_API_URL: "https://not-allowed.example", API_BASE_URL: "https://not-allowed.example",
      PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP: "1", PHAROS_DETAIL_SNAPSHOT_CHECK: "0",
      SEO_PREVIOUS_SITEMAP_URL: "https://not-allowed.example/sitemap.xml", PHAROS_PAGES_REPLAY: "1",
      NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "false", NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS: "true",
    });
    expect(env).toMatchObject({
      NODE_ENV: "production", NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true", NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS: "true",
      PHAROS_DETAIL_SNAPSHOT_CHECK: "1", PHAROS_DETAIL_SNAPSHOT_BOOTSTRAP: "", PUBLIC_DATASETS_API_URL: "",
      API_BASE_URL: "", SEO_PREVIOUS_SITEMAP_URL: "", PHAROS_PAGES_REPLAY: "",
    });
    expect(pagesArtifactEnvironment({}, "https://explicit.example/sitemap.xml").SEO_PREVIOUS_SITEMAP_URL).toBe("https://explicit.example/sitemap.xml");
  });

  it("derives only the compile-input artifacts a reused prepare workspace cannot supply", () => {
    expect(preparedWorkspaceCompileInputArtifacts()).toEqual(RERUN_IDS);
  });

  it("adds any compile-input output the transported workspace lacks", () => {
    const r = makeRoot(); preparedCompileInputOutputs(r);
    expect(compileInputStageArtifacts(r)).toEqual(RERUN_IDS);
    rmSync(join(r, "shared/data/safety-score-v9/incident-runtime-v1.generated.json"));
    expect(compileInputStageArtifacts(r)).toEqual([...RERUN_IDS, "safety-score-v9-incident-runtime"].sort());
  });

  it("reruns only those artifacts when reuse of the prepared workspace is requested", async () => {
    const r = fixtureRoot(); preparedCompileInputOutputs(r); stub("PHAROS_PAGES_REUSE_PREPARED_WORKSPACE", "1");
    await expect(runDeg(r)).resolves.toMatchObject({ dataStatus: "degraded-data" });
    const ci = callsWith("run-generated-artifacts.ts");
    expect(ci).toHaveLength(1);
    expect([ci[0][0], ci[0][1], ci[0][2].env.PHAROS_GENERATED_SKIP_EXISTING_DEPS]).toEqual([
      process.execPath, ["--import", "tsx", "scripts/maintenance/run-generated-artifacts.ts", `--only=${RERUN_IDS.join(",")}`], "1",
    ]);
    expect(findCall(POST)?.[2].env.PHAROS_GENERATED_SKIP_EXISTING_DEPS).toBe("1");
    expect(Boolean(findCall(COMP))).toBe(false);
  });

  it("reruns every missing compile-input artifact when the prepared workspace is empty", async () => {
    stub("PHAROS_PAGES_REUSE_PREPARED_WORKSPACE", "1"); await runDeg(fixtureRoot());
    const ci = callsWith("run-generated-artifacts.ts");
    expect(ci).toHaveLength(1);
    const only = (ci[0][1] as string[]).find((a) => a.startsWith("--only="))!;
    expect(only.slice(7).split(",")).toEqual(expect.arrayContaining([
      ...RERUN_IDS, "sitemap-dates", "docs-metadata", "safety-score-v9-incident-runtime",
      "safety-score-v9-incident-review-key-migration", "safety-score-v9-lane-emitter-descriptors",
    ]));
    expect(spawn.mock.calls.some((c) => c[0] === "npm" && c[1].includes(COMP))).toBe(false);
  });

  it("keeps full compile-input without reuse and honors build env overrides", async () => {
    const r = fixtureRoot(); stub("PHAROS_GENERATED_SKIP_EXISTING_DEPS", "1");
    await runDeg(r);
    expect(findCall(COMP)?.[2].env.PHAROS_GENERATED_SKIP_EXISTING_DEPS).toBe("");
    expect(spawn.mock.calls.find((c) => c[0] === "npx")?.[2].env).toMatchObject({ NEXT_TELEMETRY_DISABLED: "1", PHAROS_DISABLE_WEBPACK_FS_CACHE: "1", PHAROS_NEXT_BUILD_CPUS: "4" });
    spawn.mockClear(); stub("PHAROS_NEXT_BUILD_CPUS", "2"); await runDeg(r);
    expect(spawn.mock.calls.find((c) => c[0] === "npx")?.[2].env.PHAROS_NEXT_BUILD_CPUS).toBe("2");
  });

  it.each([["false", "gates"], ["true", "all"], ["0", "all"], [undefined, "all"]] as const)("narrows critical CSS only for full-pass=false (%s)", async (v, scope) => {
    expect(criticalCssScopeForLane({ PHAROS_CRITICAL_CSS_FULL_PASS: v })).toBe(scope);
    stub("PHAROS_CRITICAL_CSS_FULL_PASS", v); await runDeg(fixtureRoot());
    expect(findCall("postbuild")?.[2].env.PHAROS_CRITICAL_CSS_SCOPE).toBe(scope);
  });

  it.each([["false", false], ["true", true], ["0", true], [undefined, true]] as const)("runs temp-dir OG render check unless explicitly false (%s)", async (v, exp) => {
    expect(ogRenderCheckForLane({ PHAROS_OG_RENDER_CHECK: v })).toBe(exp);
    const r = fixtureRoot(); stub("PHAROS_OG_RENDER_CHECK", v); await runDeg(r);
    expect(findCall(POST)?.[2].env.PHAROS_OG_EVERGREEN_MAP_ONLY).toBe("1");
    const og = findCall("scripts/maintenance/build-og-evergreen.ts");
    expect(Boolean(og)).toBe(exp);
    if (og) {
      expect([og[0], og[1][2], og[1][3], og[2].env.PHAROS_OG_EVERGREEN_MAP_ONLY]).toEqual([process.execPath, "scripts/maintenance/build-og-evergreen.ts", "--out-dir", ""]);
      expect(og[1][4]).not.toContain(r);
    }
  });

  it("never forwards acquisition tokens or other credentials to generator/build children", async () => {
    const r = fixtureRoot(), keys = ["GH_TOKEN", "GITHUB_TOKEN", "SITE_API_SHARED_SECRET", "PHAROS_API_KEY", "CLOUDFLARE_API_TOKEN", "npm_config_auth"];
    stub("PHAROS_PAGES_REPLAY", "1"); stub("GITHUB_STEP_SUMMARY", join(r, "summary.md"));
    for (const k of keys) stub(k, "test-credential");
    expect((await runDeg(r)).dataStatus).toBe("degraded-data");
    const md = read(r, "summary.md");
    expect(md).toContain("Data status: `degraded-data`"); expect(md).toContain("Reason: `pages-artifact-data-unavailable`");
    expect(spawn.mock.calls.length).toBeGreaterThan(0);
    for (const c of spawn.mock.calls) {
      const env = c[2].env as NodeJS.ProcessEnv;
      expect([env.NODE_ENV, env.PHAROS_PAGES_REPLAY]).toEqual(["production", ""]);
      for (const k of keys) expect(env).not.toHaveProperty(k);
    }
  });

  it("reports the trusted acquisition's degraded reason without a replay waiver", async () => {
    const r = fixtureRoot(), acq = join(r, "acquisition"), reason = "partial-run-listing:deploy-cloudflare.yml";
    write(acq, "release-data-result.json", JSON.stringify({ schemaVersion: 1, dataStatus: "degraded-data", reason }));
    stub("PAGES_RELEASE_DATA_DIR", acq); stub("GITHUB_STEP_SUMMARY", join(r, "summary.md"));
    await expect(runPagesArtifactLane({ repoRoot: r })).resolves.toEqual({ dataStatus: "degraded-data" });
    expect(read(r, "summary.md")).toContain(`Reason: \`${reason}\``);
    for (const c of spawn.mock.calls) expect(c[2].env.PHAROS_PAGES_REPLAY).toBe("");
  });

  it("waives only wall-clock age after validating and overlaying retained release data", async () => {
    const r = makeRoot(), rel = join(r, "release"), cand = join(r, "candidate"), acq = join(r, "acquisition"), name = `pages-release-data-${"a".repeat(40)}`;
    dataFixture(rel); dataFixture(cand);
    createPagesReleaseDataArchive(rel, join(acq, PAGES_RELEASE_DATA_ARCHIVE));
    write(acq, "release-data-result.json", JSON.stringify({ schemaVersion: 1, dataStatus: "release-snapshot", artifactName: name }));
    stub("PAGES_RELEASE_DATA_DIR", acq); stub("GITHUB_STEP_SUMMARY", join(r, "summary.md"));
    await expect(runPagesArtifactLane({ repoRoot: cand })).resolves.toEqual({ dataStatus: "release-snapshot", artifactName: name });
    const md = read(r, "summary.md");
    expect(md).toContain(`Release artifact: \`${name}\``); expect(md).not.toContain("pages-artifact-data-unavailable");
    expect(spawn.mock.calls.length).toBeGreaterThan(0);
    for (const c of spawn.mock.calls) expect(c[2].env.PHAROS_PAGES_REPLAY).toBe("1");
    // Corruption must fail before any generator/build receives the waiver.
    write(acq, PAGES_RELEASE_DATA_ARCHIVE, "corrupt archive"); spawn.mockClear();
    await expect(runPagesArtifactLane({ repoRoot: cand })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["0", "1"])("audits all five routes when opted in and keeps Lighthouse advisory unless enforced (%s)", async (enforce) => {
    stub("PHAROS_LIGHTHOUSE_ENFORCE", enforce); stub("PHAROS_LIGHTHOUSE_THRESHOLD", "75");
    spawn.mockImplementation((_p: string, a: string[]) => ({ status: a.includes("lighthouse:static") ? 1 : 0, signal: null }));
    const res = runDeg(fixtureRoot());
    if (enforce === "1") await expect(res).rejects.toThrow("lighthouse");
    else await expect(res).resolves.toMatchObject({ dataStatus: "degraded-data" });
    const probes = callsWith("lighthouse:static");
    expect(probes.map((c) => c[1][c[1].indexOf("--route") + 1])).toEqual(["/", "/stablecoin/usdc-circle/", "/depeg/", "/safety-scores/", "/stablecoins/"]);
    expect(probes[0][1]).toContain("75"); expect(probes[2][1]).toContain("65");
  });

  it("skips Lighthouse unless this lane opts in", async () => {
    stub("PHAROS_LIGHTHOUSE_ENFORCE", undefined);
    await expect(runDeg(fixtureRoot())).resolves.toMatchObject({ dataStatus: "degraded-data" });
    expect(callsWith("lighthouse:static")).toEqual([]);
  });

  it("restores post-refresh outputs it regenerated from release data, even when a gate fails", async () => {
    const r = fixtureRoot(); write(r, "public/llms.txt", "candidate llms\n");
    spawn.mockImplementation((_p: string, a: string[]) => {
      if (a.includes(POST)) write(r, "public/llms.txt", "release-derived llms\n");
      return { status: a.includes("check:pages-release") ? 1 : 0, signal: null };
    });
    await expect(runDeg(r)).rejects.toThrow(/pages-release-artifact-gates/);
    expect(read(r, "public/llms.txt")).toBe("candidate llms\n");
  });

  it.each([{ pre: true, fail: false }, { pre: true, fail: true }, { pre: false, fail: false }, { pre: false, fail: true }])(
    "stashes pre-existing local public/og/v2 for R2-first parity and restores map + previews ($pre, $fail)",
    async ({ pre, fail }) => {
      const r = fixtureRoot(), map = "src/generated/social-preview-images.json";
      if (pre) { write(r, "public/og/v2/original.png", "original bytes"); write(r, map, "original map"); }
      expect(GENERATED_ARTIFACT_REGISTRY.find((a) => a.id === "social-preview-images")?.outputPaths).toEqual([map]);
      let ogExistsAtBuild: boolean | undefined;
      spawn.mockImplementation((_p: string, a: string[]) => {
        if (a.includes(POST)) write(r, map, "replayed map");
        if (a.includes("next")) ogExistsAtBuild = existsSync(join(r, "public/og/v2"));
        return { status: fail && a.includes("check:pages-release") ? 1 : 0, signal: null };
      });
      const res = runDeg(r);
      if (fail) await expect(res).rejects.toThrow(/pages-release-artifact-gates/);
      else await expect(res).resolves.toMatchObject({ dataStatus: "degraded-data" });
      expect(ogExistsAtBuild).toBe(false);
      if (pre) { expect(readdirSync(join(r, "public/og/v2"))).toEqual(["original.png"]); expect(read(r, map)).toBe("original map"); }
      else { expect(existsSync(join(r, "public/og/v2"))).toBe(false); expect(existsSync(join(r, map))).toBe(false); }
    },
  );

  it("queries trusted workflow runs newest-first, skips missing/expired artifacts, and fails closed", () => {
    const REPO = "TokenBrice/pharos-watch", API = `repos/${REPO}/actions`;
    const DEPLOY = ".github/workflows/deploy-cloudflare.yml", REBUILD = ".github/workflows/rebuild-pages.yml";
    const sA = "a".repeat(40), sB = "b".repeat(40), sC = "c".repeat(40);
    const art = (id: number, runId: number, sha: string, extra = {}) => ({
      id, name: `pages-release-data-${sha}`, expired: false, created_at: "2026-10-07T00:00:00Z",
      workflow_run: { id: runId, head_branch: "main", head_sha: sha, head_repository_id: 100, repository_id: 100 }, ...extra,
    });
    const run = (id: number, sha: string, extra = {}) => ({
      id, status: "completed", conclusion: "success", head_branch: "main", head_sha: sha, path: DEPLOY, event: "push",
      created_at: "2026-10-07T00:00:00Z", updated_at: "2026-10-07T00:10:00Z", head_repository: { full_name: REPO }, ...extra,
    });
    const a1 = art(1, 10, sA);
    expect(selectPagesReleaseArtifacts([
      a1, art(2, 10, sA, { created_at: "2026-10-08T00:00:00Z" }), art(3, 10, sA, { expired: true }), art(4, 10, sA, { name: "pages-release-data-other" }),
      { ...a1, id: 5, workflow_run: { ...a1.workflow_run, head_branch: "candidate" } }, { ...a1, id: 6, workflow_run: { ...a1.workflow_run, head_repository_id: 200 } },
    ]).map((e) => e.id)).toEqual([2, 1]);
    expect(selectPagesReleaseRuns([
      run(10, sA, { created_at: "2026-10-07T01:00:00Z", updated_at: "2026-10-08T09:00:00Z" }),
      run(10, sA, { created_at: "2026-10-07T01:00:00Z" }),
      run(11, sB, { path: REBUILD, event: "schedule", created_at: "2026-10-07T02:00:00Z", updated_at: "2026-10-07T02:05:00Z" }),
      run(12, sA, { status: "in_progress" }), run(13, sA, { conclusion: "failure" }), run(14, sA, { head_branch: "candidate" }),
      run(15, "short"), run(16, sA, { event: "pull_request" }), run(17, sA, { path: ".github/workflows/other.yml" }),
      run(18, sA, { head_repository: { full_name: "fork/pharos-watch" } }), run(19, sA, { head_repository: undefined }),
    ]).map((r) => r.id)).toEqual([11, 10]);

    const gh = vi.mocked(execFileSync).mockClear();
    for (const [event, repo, path, ok] of [
      ["pull_request", REPO, DEPLOY, false], ["push", "fork/pharos-watch", DEPLOY, false],
      ["push", undefined, DEPLOY, false], ["push", REPO, ".github/workflows/other.yml", false],
      ...["push", "schedule", "workflow_dispatch"].map((e) => [e, REPO, DEPLOY, true] as const),
    ] as const) {
      gh.mockReturnValueOnce(buf({ workflow_runs: [run(10, sA, { event, path, head_repository: repo ? { full_name: repo } : undefined })] }))
        .mockReturnValueOnce(buf({ workflow_runs: [] }));
      if (ok) {
        gh.mockReturnValueOnce(buf({ artifacts: [a1] })).mockImplementationOnce(() => { throw new Error("pages-artifact-data-invalid: download reached"); });
        expect(() => preparePagesReleaseData(makeRoot(), makeRoot())).toThrow("download reached");
      } else expect(preparePagesReleaseData(makeRoot(), makeRoot()).dataStatus).toBe("degraded-data");
      expect(gh).toHaveBeenCalledTimes(ok ? 4 : 2);
      gh.mockClear();
    }

    // Newest deploy lacks artifact, rebuild has expired/mismatched artifacts, third run wins; single-workflow fault stays isolated.
    gh.mockReturnValueOnce(buf({ workflow_runs: [run(30, sC, { created_at: "2026-10-08T03:00:00Z" }), run(10, sA, { created_at: "2026-10-08T01:00:00Z" })] }))
      .mockReturnValueOnce(buf({ workflow_runs: [run(20, sB, { path: REBUILD, event: "schedule", created_at: "2026-10-08T02:00:00Z" })] }))
      .mockReturnValueOnce(buf({ artifacts: [] }))
      .mockReturnValueOnce(buf({ artifacts: [art(2, 20, sB, { expired: true }), art(3, 99, sB)] }))
      .mockReturnValueOnce(buf({ artifacts: [a1] }))
      .mockImplementationOnce(() => { throw new Error("pages-artifact-data-invalid: zip 1"); });
    expect(() => preparePagesReleaseData(makeRoot(), makeRoot())).toThrow("zip 1");
    expect(gh.mock.calls.map((c) => (c[1] as string[]).at(-1))).toEqual([
      `${API}/workflows/deploy-cloudflare.yml/runs?branch=main&status=success&per_page=30`,
      `${API}/workflows/rebuild-pages.yml/runs?branch=main&status=success&per_page=30`,
      `${API}/runs/30/artifacts?name=pages-release-data-${sC}&per_page=100`,
      `${API}/runs/20/artifacts?name=pages-release-data-${sB}&per_page=100`,
      `${API}/runs/10/artifacts?name=pages-release-data-${sA}&per_page=100`,
      `${API}/artifacts/1/zip`,
    ]);
    // A failed listing can hide the newest trusted run: degrade with its reason instead of replaying the survivor.
    for (const failing of ["deploy-cloudflare.yml", "rebuild-pages.yml"]) {
      const listed = () => buf({ workflow_runs: [run(10, sA)] }), fault = () => { throw new Error("API 500"); };
      gh.mockClear().mockImplementation(() => { throw new Error("pages-artifact-data-invalid: replayed survivor"); })
        .mockImplementationOnce(failing === "deploy-cloudflare.yml" ? fault : listed)
        .mockImplementationOnce(failing === "rebuild-pages.yml" ? fault : listed);
      expect(preparePagesReleaseData(makeRoot(), makeRoot())).toEqual({ schemaVersion: 1, dataStatus: "degraded-data", reason: `partial-run-listing:${failing}` });
      expect(gh).toHaveBeenCalledTimes(2);
    }
    gh.mockClear().mockImplementation(() => { throw new Error("gh network down"); });
    expect(preparePagesReleaseData(makeRoot(), makeRoot()).dataStatus).toBe("degraded-data");
    gh.mockReset();
  });
});

describe("Pages release data archive", () => {
  it.each([".env", "public/datasets/.env", "data/depeg-events/../secret.json", `${SNAP}/../../secret.json`, "public/_redirects/extra", "/data/digests.json", "data//digests.json"])("rejects non-public or traversing member %s", (p) => { expect(isPagesReleaseDataMember(p)).toBe(false); });
  it.each(["data/depeg-events/metadata", "data/depeg-events/metadata/", "data/depeg-events/metadata/capture.json"])("permits exact depeg capture member %s", (p) => { expect(isPagesReleaseDataMember(p)).toBe(true); });
  it.each(["data/depeg-events/capture.json", "data/depeg-events/metadata/.env", "data/depeg-events/metadata/extra.json", "data/depeg-events/metadata/capture.json/extra"])("rejects unexpected depeg metadata member %s", (p) => { expect(isPagesReleaseDataMember(p)).toBe(false); });

  it("replays release inputs without replacing candidate redirects or resurrecting removed coins", () => {
    const r = makeRoot(), rel = join(r, "release"), cand = join(r, "candidate"), arch = join(r, "data.tar.zst");
    dataFixture(rel);
    write(cand, "public/_redirects", `/candidate-only /new 301\n${aliases("2026-10-01")}\n`);
    write(cand, `${SNAP}/existing.json`, '{"lanes":{}}'); write(cand, `${SNAP}/new.json`, '{"lanes":{}}');
    createPagesReleaseDataArchive(rel, arch); overlayPagesReleaseData(cand, arch, join(r, "staging"));
    expect(read(cand, "public/_redirects")).toBe(`/candidate-only /new 301\n${aliases("2026-10-07")}\n`);
    expect(read(cand, `${SNAP}/existing.json`)).toContain('"price":1');
    expect(read(cand, `${SNAP}/new.json`)).toBe('{"lanes":{}}');
    expect(() => read(cand, `${SNAP}/removed.json`)).toThrow();
    expect(read(cand, "data/digests.json")).toBe('{"release":true}');
    expect(read(cand, "data/depeg-events/metadata/capture.json")).toBe('{"release":true}');
  });

  it("refuses to publish unexpected files or links inside allowed data directories", () => {
    const r = fixtureRoot();
    write(r, "public/datasets/.env", "not-a-public-input");
    expect(() => createPagesReleaseDataArchive(r, join(r, "data.tar.zst"))).toThrow(/refusing to archive/);
    rmSync(join(r, "public/datasets/.env"));
    symlinkSync(join(r, "data/digests.json"), join(r, "public/datasets/link.json"));
    expect(() => createPagesReleaseDataArchive(r, join(r, "data.tar.zst"))).toThrow(/refusing to archive/);
    // Downloaded transport receives the same path boundary, before extraction.
    execFileSync("tar", ["--zstd", "-cf", join(r, "bad.tar.zst"), "public/datasets/link.json"], { cwd: r });
    expect(() => overlayPagesReleaseData(r, join(r, "bad.tar.zst"), join(r, "stage"))).toThrow(/links are forbidden/);
  });

  it("rejects missing alias blocks instead of replacing candidate configuration", () => {
    expect(() => mergeDatasetAliases("/auth /login 301", aliases("2026-10-07"))).toThrow(/missing.*alias block/);
  });
});

describe("dropRetiredDepegEventEntries", () => {
  it("drops replayed depeg entries retired by a committed 301 and re-seals the capture", () => {
    const r = makeRoot(), dir = join(r, "data/depeg-events"), rows = [{ slug: "eurs-2026-04-19" }, { slug: "usdc-2023-03-11" }];
    write(r, "public/_redirects", "/depeg/eurs-2026-04-19/ /stablecoin/eurs-stasis/ 301\n/depeg/eurs-2026-04-19 /stablecoin/eurs-stasis/ 301\n/depeg-old/* /depeg/ 301\n");
    write(r, "data/depeg-events/2026.json", `${JSON.stringify(rows, null, 2)}\n`);
    write(r, "data/depeg-events/2023.json", `${JSON.stringify([{ slug: "usdt-2023-06-15" }], null, 2)}\n`);
    write(r, "data/depeg-events/index.json", `${JSON.stringify(rows, null, 2)}\n`);
    write(r, "data/depeg-events/metadata/capture.json", `${JSON.stringify({ captureId: "sha256:stale", eventCount: 3, shardSource: "fetched-ledger", ledgerProof: { generation: "a".repeat(64), coveredFromSec: 1, coveredThroughSec: 42 } })}\n`);
    expect(dropRetiredDepegEventEntries(r)).toEqual(["eurs-2026-04-19"]);
    expect(JSON.parse(read(r, "data/depeg-events/2026.json"))).toEqual([{ slug: "usdc-2023-03-11" }]);
    expect(JSON.parse(read(r, "data/depeg-events/index.json"))).toEqual([{ slug: "usdc-2023-03-11" }]);
    expect(JSON.parse(read(r, "data/depeg-events/metadata/capture.json"))).toEqual({ captureId: depegLedgerCaptureId(dir), eventCount: 2 });
  });
});
