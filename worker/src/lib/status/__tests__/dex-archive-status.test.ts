import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import { loadDexArchiveStatus } from "../dex-archive-status";

describe("DEX archive status", () => {
  it("loads compact D1 control-plane state without reading R2", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const status = await loadDexArchiveStatus(db, 1_800_000_000);
      expect(status).toMatchObject({
        checkedAt: 1_800_000_000,
        releaseStage: "foundation",
        normalReadDependsOnR2: false,
        manifestCount: 0,
        uploadedManifestCount: 0,
        verifiedManifestCount: 0,
        sourceDeletedManifestCount: 0,
        failedManifestCount: 0,
      });
      expect(status.familyStates.map((family) => ({
        family: family.family,
        mode: family.effectiveMode,
      }))).toEqual([
        { family: "measured-execution", mode: "off" },
        { family: "liquidity", mode: "off" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("derives the measured-shadow stage from compact family state", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.prepare(
        `UPDATE dex_archive_family_state
            SET configured_mode = 'shadow', effective_mode = 'shadow'
          WHERE family = 'measured-execution'`,
      ).run();
      await expect(loadDexArchiveStatus(db, 1_800_000_000)).resolves.toMatchObject({
        releaseStage: "measured-shadow",
        normalReadDependsOnR2: false,
      });
    } finally {
      sqlite.close();
    }
  });
});
