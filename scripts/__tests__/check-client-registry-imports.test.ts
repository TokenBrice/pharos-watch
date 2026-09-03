import { afterEach, describe, expect, it } from "vitest";

import { findClientRegistryImportViolations } from "../ci/check-client-registry-imports";
import { createTempRepoTracker } from "./helpers/test-state";

const { cleanup, makeRoot, writeText } = createTempRepoTracker("pharos-client-registry-imports");

afterEach(cleanup);

describe("findClientRegistryImportViolations", () => {
  it("allows the compact list projection in a client entry", () => {
    const root = makeRoot();
    writeText(
      root,
      "src/allowed.tsx",
      '"use client";\nimport list from "@shared/data/stablecoins/coins.client.list.generated.json";\nexport const ids = list.map((coin) => coin.id);\n',
    );

    expect(findClientRegistryImportViolations(root)).toEqual({ violations: [], scannedCount: 1 });
  });

  it("rejects direct detail projection imports from a client entry", () => {
    const root = makeRoot();
    writeText(
      root,
      "src/rejected.tsx",
      '"use client";\nimport detail from "@shared/data/stablecoins/coins.client.detail/usdc-circle.generated.json";\nexport const name = detail.name;\n',
    );

    expect(findClientRegistryImportViolations(root)).toEqual({
      violations: [
        `src/rejected.tsx:2: client bundle imports a stablecoin detail projection directly; use loadClientStablecoinDetail(id)`,
      ],
      scannedCount: 1,
    });
  });

  it("rejects the legacy fat client registry import", () => {
    const root = makeRoot();
    writeText(
      root,
      "src/rejected.tsx",
      '"use client";\nimport registry from "@shared/data/stablecoins/coins.client.generated.json";\nexport const ids = registry.map((coin) => coin.id);\n',
    );

    expect(findClientRegistryImportViolations(root)).toEqual({
      violations: [
        `src/rejected.tsx:2: client bundle imports the full stablecoin registry; use @shared/lib/stablecoins/client-registry or pass server-derived props`,
      ],
      scannedCount: 1,
    });
  });

  it("reports fat imports reached through a local source module", () => {
    const root = makeRoot();
    writeText(root, "src/registry.ts", 'import registry from "@shared/data/stablecoins/coins.generated.json";\nexport default registry;\n');
    writeText(root, "src/page.tsx", '"use client";\nimport registry from "@/registry";\nexport const ids = registry.map((coin) => coin.id);\n');

    expect(findClientRegistryImportViolations(root)).toEqual({
      violations: [
        `src/registry.ts:1: client bundle imports the full stablecoin registry via src/page.tsx -> src/registry.ts; use @shared/lib/stablecoins/client-registry or pass server-derived props`,
      ],
      scannedCount: 2,
    });
  });
});
