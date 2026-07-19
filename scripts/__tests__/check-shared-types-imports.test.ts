import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  findBroadSharedTypesValueImports,
  findSharedTypesRuntimeImports,
} from "../ci/check-shared-types-imports.mjs";

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

describe("findSharedTypesRuntimeImports", () => {
  it("rejects shared/types imports from shared/lib", () => {
    const root = makeTempRepo();
    mkdirSync(join(root, "shared/types"), { recursive: true });
    writeFileSync(
      join(root, "shared/types/status.ts"),
      'import type { PricingSourceKey } from "../lib/pricing-source-registry";\nexport type Row = PricingSourceKey;\n',
    );

    expect(findSharedTypesRuntimeImports(["shared/types"], root)).toEqual([
      {
        file: join(root, "shared/types/status.ts"),
        line: 1,
        source: "../lib/pricing-source-registry",
      },
    ]);
  });

  it("allows shared/types imports from sibling type modules", () => {
    const root = makeTempRepo();
    mkdirSync(join(root, "shared/types/status"), { recursive: true });
    writeFileSync(
      join(root, "shared/types/status.ts"),
      'import type { CronStatus } from "./status/cron";\nexport type Row = CronStatus;\n',
    );

    expect(findSharedTypesRuntimeImports(["shared/types"], root)).toEqual([]);
  });

  it("ignores test files under shared/types", () => {
    const root = makeTempRepo();
    mkdirSync(join(root, "shared/types/__tests__"), { recursive: true });
    writeFileSync(
      join(root, "shared/types/__tests__/core.test.ts"),
      'import { getFilterTags } from "../../lib/filter-tags";\n',
    );

    expect(findSharedTypesRuntimeImports(["shared/types"], root)).toEqual([]);
  });
});
