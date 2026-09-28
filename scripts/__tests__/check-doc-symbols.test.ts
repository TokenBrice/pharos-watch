import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { collectCodePaths, findSourceHits, runDocSymbolCheck, scanDocSymbols } from "../ci/check-doc-symbols.ts";

describe("check-doc-symbols", () => {
  it("fails for a stale symbol in an unrouted verified document and reports extras separately", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-doc-symbols-"));
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "README.md"), "# Fixture\n");
      writeFileSync(join(root, "docs/unrouted.md"), "Stale: `missingUnroutedSymbol`.\n");
      writeFileSync(join(root, "AGENTS.md"), "# Scoped guidance\n");
      writeFileSync(join(root, "docs/doc-ownership.json"), JSON.stringify({
        mappings: [{ docs: ["AGENTS.md"] }],
      }));
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      let output = "";
      const status = runDocSymbolCheck(["--json"], {
        repoRoot: root,
        stdout: { write: (chunk) => { output += chunk; } },
        stderr: { write: () => undefined },
      });
      expect(status).toBe(1);
      expect(JSON.parse(output)).toMatchObject({
        documentsScanned: 3,
        verifiedDocumentsScanned: 2,
        extraDocumentsScanned: 1,
        violations: [{ doc: "docs/unrouted.md", line: 1, token: "missingUnroutedSymbol" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collects tracked and standard untracked code paths with the shared extension filter", () => {
    const calls: string[][] = [];
    const paths = collectCodePaths("/tmp/pharos-doc-symbols", (args) => {
      calls.push([...args]);
      return args.includes("--others")
        ? "scripts/new-source.ts\0docs/new-doc.md\0notes/new.txt\0"
        : "src/tracked-source.ts\0scripts/tracked-source.md\0";
    }, () => true);

    expect(calls).toEqual([
      ["ls-files", "-z"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
    ]);
    expect(paths).toEqual(["src/tracked-source.ts", "scripts/new-source.ts"]);
  });

  it("reports stale symbols while accepting present symbols and ignoring narrow-scope non-symbols", () => {
    const result = scanDocSymbols({
      documents: [
        {
          path: "docs/fixture.md",
          content: [
            "Present: `presentSymbol`.",
            "Stale: `staleSymbol`.",
            "Ignored: `ALL_CAPS`, `short`, `src/hooks/staleSymbol`, and `abcDe`.",
            "```ts",
            "`missingInFence`",
            "```",
            "Present call: `presentSymbol()`.",
          ].join("\n"),
        },
      ],
      sourceFiles: [
        {
          path: "src/fixture.ts",
          content: "const presentSymbol = 1; const staleSymbolExtra = 2;",
        },
      ],
      exclusions: {},
    });

    expect(result.violations).toEqual([
      { doc: "docs/fixture.md", line: 2, token: "staleSymbol" },
    ]);
  });

  it("finds exact symbols with the in-process search used when ripgrep is unavailable", () => {
    expect(findSourceHits(["presentSymbol", "presentCall()", "absentSymbol"], [
      { path: "src/fixture.ts", content: "const presentSymbolExtra = 1; presentCall();" },
      { path: "src/other.ts", content: "export const presentSymbol = 2;" },
    ])).toEqual(new Set(["presentSymbol", "presentCall"]));
  });
});
