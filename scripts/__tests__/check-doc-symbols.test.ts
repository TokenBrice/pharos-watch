import { describe, expect, it } from "vitest";

import { collectCodePaths, scanDocSymbols } from "../ci/check-doc-symbols.ts";

describe("check-doc-symbols", () => {
  it("collects tracked and standard untracked code paths with the shared extension filter", () => {
    const calls: string[][] = [];
    const paths = collectCodePaths("/tmp/pharos-doc-symbols", (args) => {
      calls.push([...args]);
      return args.includes("--others")
        ? "scripts/new-source.ts\0docs/new-doc.md\0notes/new.txt\0"
        : "src/tracked-source.ts\0scripts/tracked-source.md\0";
    });

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
    expect(result.violations.some(({ token }) => token === "presentSymbol")).toBe(false);
    expect(result.violations.some(({ token }) => token === "ALL_CAPS")).toBe(false);
    expect(result.violations.some(({ token }) => token === "src/hooks/staleSymbol")).toBe(false);
    expect(result.violations.some(({ token }) => token === "abcDe")).toBe(false);
    expect(result.violations.some(({ token }) => token === "missingInFence")).toBe(false);
  });
});
