import { describe, expect, it, vi } from "vitest";
import { selectAutoStageArtifactIds } from "../lib/automation-registry.mjs";
import { syncStagedGeneratedArtifacts } from "../ci/sync-staged-generated-artifacts.mts";

function execReturning(value: string) {
  return vi.fn(() => value) as never;
}

describe("auto-stage partition", () => {
  it("splits selected ids into auto-stageable and manual", () => {
    const { autoStage, manual } = selectAutoStageArtifactIds([
      "safety-score-v9-evaluation-build",
      "og-editorial",
      "public-datasets",
    ]);
    expect(autoStage).toEqual(["safety-score-v9-evaluation-build", "public-datasets"]);
    expect(manual).toEqual(["og-editorial"]);
  });

  it("keeps network-derived artifacts manual unless their generator is offline-safe", () => {
    const { autoStage } = selectAutoStageArtifactIds(["llms-txt", "public-datasets"]);
    expect(autoStage).toEqual(["public-datasets"]);
  });
});

describe("staged artifact sync", () => {
  it("regenerates and stages the artifacts the staged files affect", () => {
    const runCommand = vi.fn(() => 0);
    const execFile = execReturning("");
    const log = vi.fn();

    const result = syncStagedGeneratedArtifacts({
      cwd: "/repo",
      stagedFiles: ["shared/lib/safety-score-v9/formula.ts"],
      execFile,
      runCommand,
      log,
    });

    expect(result.regenerated).toEqual(["safety-score-v9-evaluation-build"]);
    expect(result.blocked).toEqual([]);
    expect(runCommand).toHaveBeenCalledWith(
      expect.stringContaining("generate-safety-score-v9-evaluation-build-manifest.ts"),
    );
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["add", "--", "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts"],
      { cwd: "/repo", encoding: "utf8" },
    );
  });

  it("refuses to stage an artifact whose sources have unstaged edits", () => {
    // `git add -p` style partial staging: the generator reads the working tree,
    // so staging its output would commit a manifest derived from uncommitted
    // source. Abort instead of silently pinning the wrong content.
    const execFile = execReturning("shared/lib/safety-score-v9/formula.ts\0");

    expect(() =>
      syncStagedGeneratedArtifacts({
        stagedFiles: ["shared/lib/safety-score-v9/formula.ts"],
        execFile,
        runCommand: vi.fn(() => 0),
        log: vi.fn(),
      }),
    ).toThrow(/unstaged/i);
  });

  it("does nothing when the index is empty", () => {
    const runCommand = vi.fn(() => 0);
    const result = syncStagedGeneratedArtifacts({
      stagedFiles: [],
      execFile: execReturning(""),
      runCommand,
      log: vi.fn(),
    });

    expect(result).toEqual({ blocked: [], manual: [], regenerated: [] });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("warns about selected artifacts it will not auto-stage", () => {
    const log = vi.fn();
    const result = syncStagedGeneratedArtifacts({
      stagedFiles: ["src/app/page.tsx"],
      execFile: execReturning(""),
      runCommand: vi.fn(() => 0),
      log,
    });

    expect(result.manual).toContain("og-editorial");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("og-editorial"));
  });

  it("does not warn about gitignored artifacts a human cannot commit", () => {
    // `git check-ignore --stdin` echoes back only the ignored paths.
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args[0] === "check-ignore"
        ? "src/generated/sitemap-dates.json\0src/generated/sitemap-dates.json.d.ts\0"
        : "",
    ) as never;
    const log = vi.fn();

    const result = syncStagedGeneratedArtifacts({
      stagedFiles: ["src/app/page.tsx"],
      execFile,
      runCommand: vi.fn(() => 0),
      log,
    });

    expect(result.manual).not.toContain("sitemap-dates");
    expect(result.manual).toContain("og-editorial");
  });

  it("fails loudly when a generator exits non-zero", () => {
    expect(() =>
      syncStagedGeneratedArtifacts({
        stagedFiles: ["shared/lib/safety-score-v9/formula.ts"],
        execFile: execReturning(""),
        runCommand: vi.fn(() => 3),
        log: vi.fn(),
      }),
    ).toThrow(/exit code 3/);
  });
});
