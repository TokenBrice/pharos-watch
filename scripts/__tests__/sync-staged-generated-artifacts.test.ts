import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GENERATED_ARTIFACT_REGISTRY, selectAutoStageArtifactIds } from "../lib/automation-registry.mjs";
import { syncStagedGeneratedArtifacts } from "../ci/sync-staged-generated-artifacts.mts";
import { V9_EVALUATION_BUILD_SOURCE_PATHS } from "../lib/safety-score-v9-evaluation-inputs.mts";

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
  it("removes newly generated glob members after failure, restores tracked bytes, and allows retry", () => {
    const cwd = mkdtempSync(join(tmpdir(), "staged-logo-rollback-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    const compact = join(cwd, "public/logos/compact");
    const oldOutput = join(compact, "old.webp");
    const newOutput = join(compact, "nested/new.webp");
    try {
      git("init");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "Fixture");
      git("config", "core.hooksPath", "/dev/null");
      mkdirSync(compact, { recursive: true });
      mkdirSync(join(cwd, "src/lib"), { recursive: true });
      writeFileSync(oldOutput, "original compact bytes");
      writeFileSync(join(cwd, "src/lib/logo-variants.generated.json"), "{}");
      git("add", ".");
      git("commit", "-qm", "Tracked compact outputs");
      writeFileSync(join(cwd, "public/logos/new.png"), "staged input");
      git("add", "public/logos/new.png");
      expect(() => syncStagedGeneratedArtifacts({
        cwd, log: vi.fn(), runCommand: () => {
          writeFileSync(oldOutput, "changed compact bytes");
          mkdirSync(join(compact, "nested"), { recursive: true });
          writeFileSync(newOutput, "new output bytes");
          return 3;
        },
      })).toThrow(/exit code 3/);
      expect(readFileSync(oldOutput, "utf8")).toBe("original compact bytes");
      expect(existsSync(newOutput)).toBe(false);
      expect(git("diff", "--cached", "--name-only").trim()).toBe("public/logos/new.png");
      expect(git("diff", "--name-only")).toBe("");
      expect(syncStagedGeneratedArtifacts({ cwd, log: vi.fn(), runCommand: () => 0 }).regenerated)
        .toEqual(["compact-logos"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks every unstaged fixed manifest input and dynamic summaries", () => {
    const runCommand = vi.fn(() => 0);
    for (const source of [...V9_EVALUATION_BUILD_SOURCE_PATHS,
      "shared/data/safety-score-v9/mechanism-measurements/new/nested.summary.json",
    ]) {
      expect(() => syncStagedGeneratedArtifacts({
        stagedFiles: ["shared/lib/safety-score-v9/formula.ts"],
        execFile: execReturning(`${source}\0`),
        runCommand,
        log: vi.fn(),
      }), source).toThrow(/unstaged/);
    }
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("runs cemetery prerequisites in order but only stages authorized outputs", () => {
    const execFile = execReturning("");
    const runCommand = vi.fn((_command: string) => 0);
    const result = syncStagedGeneratedArtifacts({
      stagedFiles: ["data/logos.json"],
      execFile,
      runCommand,
      log: vi.fn(),
    });
    expect(result.regenerated).toEqual(["stablecoin-catalog", "report-card-registry-fingerprint", "cemetery-dataset"]);
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual(
      result.regenerated.map((id) => GENERATED_ARTIFACT_REGISTRY.find((artifact) => artifact.id === id)!.command),
    );
    expect(execFile).toHaveBeenCalledWith("git", ["add", "--",
      "public/datasets/stablecoin-cemetery.csv", "public/datasets/stablecoin-cemetery.json",
    ], expect.anything());
    expect(runCommand.mock.calls.some(([command]) => command.includes("detail-snapshots"))).toBe(false);
  });

  it("rejects unstaged dependency sources before cemetery generation", () => {
    const runCommand = vi.fn(() => 0);
    expect(() => syncStagedGeneratedArtifacts({
      stagedFiles: ["data/logos.json"],
      execFile: execReturning("shared/data/stablecoins/coins/frozen.json\0"),
      runCommand,
      log: vi.fn(),
    })).toThrow(/stablecoin-catalog.*unstaged/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("restores existing ignored prerequisite bytes when its generator fails and stages nothing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "staged-prerequisite-"));
    const catalog = "shared/data/stablecoins/coins.generated.json";
    mkdirSync(join(cwd, "shared/data/stablecoins"), { recursive: true });
    writeFileSync(join(cwd, catalog), "original ignored catalog");
    const execFile = vi.fn((_file: string, args: readonly string[]) => {
      if (args[0] === "ls-files" && args.includes("--error-unmatch") && args.at(-1) === catalog) {
        throw new Error("ignored");
      }
      return "";
    });
    const runCommand = vi.fn(() => { writeFileSync(join(cwd, catalog), "partial output"); return 3; });
    try {
      expect(() => syncStagedGeneratedArtifacts({
        cwd, stagedFiles: ["data/logos.json"], execFile: execFile as never, runCommand, log: vi.fn(),
      })).toThrow(/stablecoin-catalog generator failed/);
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(cwd, catalog), "utf8")).toBe("original ignored catalog");
      expect(execFile.mock.calls.some(([, args]) => args[0] === "add")).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a network dependency even when reached from an offline artifact", () => {
    const catalog = GENERATED_ARTIFACT_REGISTRY.find((artifact) => artifact.id === "stablecoin-catalog")!;
    const original = catalog.reproducibility;
    const runCommand = vi.fn(() => 0);
    try {
      catalog.reproducibility = "network-derived";
      expect(() => syncStagedGeneratedArtifacts({
        stagedFiles: ["data/logos.json"], execFile: execReturning(""), runCommand, log: vi.fn(),
      })).toThrow(/network-derived prerequisite stablecoin-catalog/);
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      catalog.reproducibility = original;
    }
  });

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
      ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMRD", "-z"],
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
    const untrackedSource = "shared/data/safety-score-v9/mechanism-measurements/new/nested.summary.json";
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

  it("rejects dirty outputs before a generator can overwrite their bytes", () => {
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
      ).toThrow(/refusing to overwrite dirty outputs/);

      expect(readFileSync(firstOutputPath, "utf8")).toBe(originalFirstOutput);
      expect(readFileSync(secondOutputPath, "utf8")).toBe(preDirtySecondOutput);
      expect(runCommand).not.toHaveBeenCalled();
      expect(execFile.mock.calls.some(([, args]) => args[0] === "checkout")).toBe(false);
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
