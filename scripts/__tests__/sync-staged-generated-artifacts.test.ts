import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GENERATED_ARTIFACT_REGISTRY, selectAutoStageArtifactIds } from "../lib/automation-registry.mjs";
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
    expect(autoStage).toEqual(["safety-score-v9-evaluation-build"]);
    expect(manual).toEqual(["public-datasets", "og-editorial"]);
  });

  it("never auto-stages a network-derived artifact", () => {
    const networkDerivedIds = GENERATED_ARTIFACT_REGISTRY
      .filter((artifact) => artifact.reproducibility === "network-derived")
      .map((artifact) => artifact.id);
    const { autoStage, manual } = selectAutoStageArtifactIds(networkDerivedIds);

    expect(GENERATED_ARTIFACT_REGISTRY.filter(
      (artifact) => artifact.autoStage === true && artifact.reproducibility === "network-derived",
    )).toEqual([]);
    expect(autoStage).toEqual([]);
    expect(manual).toEqual(networkDerivedIds);
  });
});

describe("staged artifact sync", () => {
  it("selects an artifact when a registered source is staged for deletion", () => {
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args.includes("--cached")
        ? "shared/lib/safety-score-v9/formula.ts\0"
        : "",
    );
    const result = syncStagedGeneratedArtifacts({
      cwd: "/repo",
      execFile: execFile as never,
      runCommand: vi.fn(() => 0),
      log: vi.fn(),
    });

    expect(result.regenerated).toEqual(["safety-score-v9-evaluation-build"]);
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z"],
      { cwd: "/repo", encoding: "utf8" },
    );
  });

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

  it("refuses to regenerate when an untracked source matches a registered glob", () => {
    const untrackedSource = "shared/lib/safety-score-v9/new-source.ts";
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args[0] === "ls-files" ? `${untrackedSource}\0` : "",
    );

    expect(() =>
      syncStagedGeneratedArtifacts({
        cwd: "/repo",
        stagedFiles: ["shared/lib/safety-score-v9/formula.ts"],
        execFile: execFile as never,
        runCommand: vi.fn(() => 0),
        log: vi.fn(),
      }),
    ).toThrow(/unstaged/i);
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: "/repo", encoding: "utf8" },
    );
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

  it("does not stage earlier outputs when a later generator fails", () => {
    const execFile = vi.fn((_file: string, _args: readonly string[]) => "");
    const runCommand = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(3);

    expect(() =>
      syncStagedGeneratedArtifacts({
        stagedFiles: [
          "shared/data/safety-score-v9/mechanism-measurements/example-shock-coverage.json",
          "shared/lib/safety-score-v9/formula.ts",
        ],
        execFile: execFile as never,
        runCommand,
        log: vi.fn(),
      }),
    ).toThrow(/exit code 3/);

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls.some(([, args]) => args[0] === "add")).toBe(false);
  });

  it("restores clean outputs and leaves pre-dirty outputs after a later failure", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-staged-artifacts-"));
    const firstOutput = "shared/data/safety-score-v9/shock-coverage-measurements-v1.json";
    const secondOutput = "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts";
    const firstOutputPath = join(cwd, firstOutput);
    const secondOutputPath = join(cwd, secondOutput);
    const originalFirstOutput = "original output";
    const preDirtySecondOutput = "pre-dirty output";
    mkdirSync(join(cwd, "shared/data/safety-score-v9"), { recursive: true });
    writeFileSync(firstOutputPath, originalFirstOutput);
    writeFileSync(secondOutputPath, preDirtySecondOutput);
    const execFile = vi.fn((_file: string, args: readonly string[]) => {
      if (args[0] === "status") {
        return args.at(-1) === secondOutput ? " M output\n" : "";
      }
      if (args[0] === "checkout") {
        writeFileSync(firstOutputPath, originalFirstOutput);
      }
      return "";
    });
    const runCommand = vi.fn()
      .mockImplementationOnce(() => {
        writeFileSync(firstOutputPath, "mutated output");
        return 0;
      })
      .mockImplementationOnce(() => 3);
    const log = vi.fn();

    try {
      expect(() =>
        syncStagedGeneratedArtifacts({
          cwd,
          stagedFiles: [
            "shared/data/safety-score-v9/mechanism-measurements/example-shock-coverage.json",
            "shared/lib/safety-score-v9/formula.ts",
          ],
          execFile: execFile as never,
          runCommand,
          log,
        }),
      ).toThrow(/exit code 3/);

      expect(readFileSync(firstOutputPath, "utf8")).toBe(originalFirstOutput);
      expect(readFileSync(secondOutputPath, "utf8")).toBe(preDirtySecondOutput);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(secondOutput));
      expect(execFile).toHaveBeenCalledWith(
        "git",
        ["checkout", "--", firstOutput],
        { cwd, encoding: "utf8" },
      );
      expect(execFile.mock.calls.some(([, args]) => args[0] === "checkout" && args.at(-1) === secondOutput)).toBe(false);
      expect(execFile.mock.calls.some(([, args]) => args[0] === "add")).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("restores an index-only staged output from the index after a later failure", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-staged-artifacts-"));
    const firstOutput = "shared/data/safety-score-v9/shock-coverage-measurements-v1.json";
    const firstOutputPath = join(cwd, firstOutput);
    const stagedFirstOutput = "staged output";
    mkdirSync(join(cwd, "shared/data/safety-score-v9"), { recursive: true });
    writeFileSync(firstOutputPath, stagedFirstOutput);
    const execFile = vi.fn((_file: string, args: readonly string[]) => {
      // Index-only change: porcelain `M ` (staged, working tree matches the index).
      if (args[0] === "status") return args.at(-1) === firstOutput ? "M  output\n" : "";
      if (args[0] === "checkout") writeFileSync(firstOutputPath, stagedFirstOutput);
      return "";
    });
    const runCommand = vi.fn()
      .mockImplementationOnce(() => {
        writeFileSync(firstOutputPath, "mutated output");
        return 0;
      })
      .mockImplementationOnce(() => 3);
    const log = vi.fn();

    try {
      expect(() =>
        syncStagedGeneratedArtifacts({
          cwd,
          stagedFiles: [
            "shared/data/safety-score-v9/mechanism-measurements/example-shock-coverage.json",
            "shared/lib/safety-score-v9/formula.ts",
          ],
          execFile: execFile as never,
          runCommand,
          log,
        }),
      ).toThrow(/exit code 3/);

      expect(readFileSync(firstOutputPath, "utf8")).toBe(stagedFirstOutput);
      expect(execFile).toHaveBeenCalledWith("git", ["checkout", "--", firstOutput], { cwd, encoding: "utf8" });
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining(firstOutput));
      expect(execFile.mock.calls.some(([, args]) => args[0] === "add")).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
