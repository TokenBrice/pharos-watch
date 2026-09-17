import { describe, expect, it } from "vitest";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/constants";
import { type MockD1Database } from "@shared/test-utils/mock-d1";
import { projectMethodologyBumps } from "../methodology";
import { mockTapeD1, tapeInsertBinds } from "./test-support";

function extractSourceUrlsForType(db: MockD1Database, type: string): Set<unknown> {
  return new Set(
    tapeInsertBinds(db)
      .filter((binds) => binds[1] === type)
      .map((binds) => binds[15]),
  );
}

describe("methodology projector", () => {
  it("uses shared public changelog paths for Liquidity Score and PSI source URLs", async () => {
    const db = mockTapeD1([
      { match: "INDEXED BY idx_tape_source_key", rows: [] },
    ]) as MockD1Database;

    await projectMethodologyBumps(db);

    const liquiditySourceUrls = extractSourceUrlsForType(db, "methodology.bumped:liquidity-score");
    const psiSourceUrls = extractSourceUrlsForType(db, "methodology.bumped:stability-index");

    expect(liquiditySourceUrls).toEqual(new Set([LIQUIDITY_METHODOLOGY_CHANGELOG_PATH]));
    expect(psiSourceUrls).toEqual(new Set([PSI_METHODOLOGY_CHANGELOG_PATH]));
    expect(liquiditySourceUrls).not.toContain("/methodology/liquidity-changelog/");
    expect(psiSourceUrls).not.toContain("/methodology/psi-changelog/");

    const reads = db.getHistory()
      .filter((entry) => entry.sql.includes("FROM tape_events"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((entry) =>
      entry.sql.includes("INDEXED BY idx_tape_source_key") &&
      entry.sql.includes("LIMIT 1")
    )).toBe(true);
    expect(reads.every((entry) => !entry.sql.includes("WHERE type = ?"))).toBe(true);
  });
});
