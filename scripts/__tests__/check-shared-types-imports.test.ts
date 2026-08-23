import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  findBroadSharedTypesValueImports,
  findSharedTypesRuntimeImports,
} from "../ci/check-shared-types-imports";
import { createTempRepoTracker } from "./helpers/test-state";

const { cleanup, makeRoot, writeText } = createTempRepoTracker("pharos-shared-types-imports");

afterEach(cleanup);

describe("findBroadSharedTypesValueImports", () => {
  it("allows type-only imports from the broad @shared/types barrel", () => {
    const root = makeRoot();
    writeText(
      root,
      "src/allowed.ts",
      'import type { StablecoinData } from "@shared/types";\nexport type Row = StablecoinData;\n',
    );

    expect(findBroadSharedTypesValueImports(["src"], root)).toEqual([]);
  });

  it("rejects value imports from the broad @shared/types barrel", () => {
    const root = makeRoot();
    writeText(
      root,
      "src/rejected.ts",
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
    const root = makeRoot();
    writeText(
      root,
      "shared/types/status.ts",
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
    const root = makeRoot();
    writeText(
      root,
      "shared/types/status.ts",
      'import type { CronStatus } from "./status/cron";\nexport type Row = CronStatus;\n',
    );

    expect(findSharedTypesRuntimeImports(["shared/types"], root)).toEqual([]);
  });

  it("ignores test files under shared/types", () => {
    const root = makeRoot();
    writeText(
      root,
      "shared/types/__tests__/core.test.ts",
      'import { getFilterTags } from "../../lib/filter-tags";\n',
    );

    expect(findSharedTypesRuntimeImports(["shared/types"], root)).toEqual([]);
  });
});
