import { describe, expect, it, vi } from "vitest";

import {
  collectUncommittedPaths,
  enforceCommittedArtifactSources,
  findUncommittedArtifactSources,
} from "../lib/commit-derived-artifacts.mjs";

describe("commit-derived artifact guard", () => {
  it("collects staged, unstaged, and untracked paths without duplicates", () => {
    const outputs = [
      "docs/architecture.md\0src/app/page.tsx\0",
      "docs/architecture.md\0shared/lib/public-docs.ts\0",
      "docs/new-public-doc.md\0",
    ];
    const execFile = vi.fn(() => outputs.shift() ?? "");

    expect(collectUncommittedPaths({ cwd: "/repo", execFile: execFile as never })).toEqual([
      "docs/architecture.md",
      "docs/new-public-doc.md",
      "shared/lib/public-docs.ts",
      "src/app/page.tsx",
    ]);
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it("matches exact files and recursive source patterns", () => {
    expect(
      findUncommittedArtifactSources(
        ["docs/architecture.md", "src/app/**"],
        ["docs/testing.md", "docs/architecture.md", "src/app/status/page.tsx"],
      ),
    ).toEqual(["docs/architecture.md", "src/app/status/page.tsx"]);
  });

  it("fails checks with the required post-commit regeneration sequence", () => {
    const execFile = vi
      .fn()
      .mockReturnValueOnce("docs/architecture.md\0")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("");

    expect(() =>
      enforceCommittedArtifactSources({
        artifactId: "docs-metadata",
        check: true,
        command: "npm run generate:docs-metadata",
        execFile: execFile as never,
        sourcePaths: ["docs/architecture.md"],
      }),
    ).toThrow(/Commit the source changes first.*commit or amend the generated output/s);
  });

  it("warns but permits provisional write-mode generation for local builds", () => {
    const execFile = vi.fn().mockReturnValueOnce("src/app/page.tsx\0").mockReturnValueOnce("").mockReturnValueOnce("");
    const warn = vi.fn();

    expect(
      enforceCommittedArtifactSources({
        artifactId: "sitemap-dates",
        check: false,
        command: "npm run generate:sitemap-dates",
        execFile: execFile as never,
        sourcePaths: ["src/app/**"],
        warn,
      }),
    ).toEqual({ clean: false, dirtyOutputs: [], dirtySources: ["src/app/page.tsx"] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("generated output is provisional"));
  });

  it("rejects uncommitted generated output while allowing unrelated dirty files", () => {
    const execFile = vi
      .fn()
      .mockReturnValueOnce("unrelated.txt\0src/generated/docs-metadata.json\0")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("");

    expect(() =>
      enforceCommittedArtifactSources({
        artifactId: "docs-metadata",
        check: true,
        command: "npm run generate:docs-metadata",
        execFile: execFile as never,
        outputPaths: ["src/generated/docs-metadata.json"],
        sourcePaths: ["docs/architecture.md"],
      }),
    ).toThrow(/generated outputs are uncommitted.*Commit or discard/s);
  });
});
