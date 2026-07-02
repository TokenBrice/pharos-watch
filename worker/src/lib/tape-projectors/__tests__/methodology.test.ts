import { describe, expect, it } from "vitest";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/constants";
import { mockD1, type MockD1Database } from "../../../test-helpers/__shared/mock-d1";
import { projectMethodologyBumps } from "../methodology";

function extractInsertBinds(db: MockD1Database): unknown[][] {
  return db
    .getHistory()
    .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"))
    .map((entry) => entry.binds);
}

function extractSourceUrlsForType(db: MockD1Database, type: string): Set<unknown> {
  return new Set(
    extractInsertBinds(db)
      .filter((binds) => binds[1] === type)
      .map((binds) => binds[15]),
  );
}

describe("methodology projector", () => {
  it("uses shared public changelog paths for Liquidity Score and PSI source URLs", async () => {
    const db = mockD1([
      { match: "FROM tape_events WHERE type = ?", rows: [] },
    ]) as MockD1Database;

    await projectMethodologyBumps(db);

    const liquiditySourceUrls = extractSourceUrlsForType(db, "methodology.bumped:liquidity-score");
    const psiSourceUrls = extractSourceUrlsForType(db, "methodology.bumped:stability-index");

    expect(liquiditySourceUrls).toEqual(new Set([LIQUIDITY_METHODOLOGY_CHANGELOG_PATH]));
    expect(psiSourceUrls).toEqual(new Set([PSI_METHODOLOGY_CHANGELOG_PATH]));
    expect(liquiditySourceUrls).not.toContain("/methodology/liquidity-changelog/");
    expect(psiSourceUrls).not.toContain("/methodology/psi-changelog/");
  });
});
