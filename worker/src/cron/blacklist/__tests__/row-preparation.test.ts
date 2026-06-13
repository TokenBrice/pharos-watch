import { describe, expect, it } from "vitest";
import { makeBlacklistRow } from "../../../test-helpers/__shared/fixtures";
import type { BlacklistRow } from "../shared";
import {
  buildCurrentBalanceSnapshotRows,
} from "../row-preparation";

describe("blacklist row preparation", () => {
  it("preserves same-batch blacklist snapshots before a later release", () => {
    const blacklistRow = makeBlacklistRow({
      id: "ethereum-0xtransient-0",
      event_type: "blacklist",
      address: "0x0000000000000000000000000000000000000222",
      timestamp: 10,
    }) as BlacklistRow;
    const unblacklistRow = makeBlacklistRow({
      id: "ethereum-0xtransient-1",
      event_type: "unblacklist",
      address: blacklistRow.address,
      timestamp: 11,
    }) as BlacklistRow;

    expect(buildCurrentBalanceSnapshotRows([unblacklistRow, blacklistRow])).toEqual([
      blacklistRow,
      unblacklistRow,
    ]);
  });
});
