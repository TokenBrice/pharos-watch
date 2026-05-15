/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findBroadSharedTypesValueImports } from "../ci/check-shared-types-imports.mjs";

let tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pharos-shared-types-imports-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("findBroadSharedTypesValueImports", () => {
  it("allows type-only imports from the broad @shared/types barrel", () => {
    const root = makeTempRepo();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src/allowed.ts"),
      'import type { StablecoinData } from "@shared/types";\nexport type Row = StablecoinData;\n',
    );

    expect(findBroadSharedTypesValueImports(["src"], root)).toEqual([]);
  });

  it("rejects value imports from the broad @shared/types barrel", () => {
    const root = makeTempRepo();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src/rejected.ts"),
      'import { StablecoinListResponseSchema, type StablecoinData } from "@shared/types";\n',
    );

    expect(findBroadSharedTypesValueImports(["src"], root)).toEqual([
      {
        file: join(root, "src/rejected.ts"),
        line: 1,
        names: ["StablecoinListResponseSchema"],
      },
    ]);
  });
});
