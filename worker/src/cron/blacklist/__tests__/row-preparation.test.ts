import { describe, expect, it } from "vitest";
import { makeBlacklistRow } from "../../../test-helpers/__shared/fixtures";
import type { BlacklistRow } from "../../../lib/blacklist/shared";
import {
  buildCurrentBalanceSnapshotRows,
  buildLatestBlacklistRows,
} from "../../../lib/blacklist/row-preparation";

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

  it("selects only the latest row per address for active-state repair", () => {
    const blacklistRow = makeBlacklistRow({
      id: "ethereum-0xduplicate-0",
      event_type: "blacklist",
      address: "0x0000000000000000000000000000000000000333",
      timestamp: 10,
    }) as BlacklistRow;
    const unblacklistRow = makeBlacklistRow({
      id: "ethereum-0xduplicate-1",
      event_type: "unblacklist",
      address: blacklistRow.address,
      timestamp: 11,
    }) as BlacklistRow;

    expect(buildLatestBlacklistRows([unblacklistRow, blacklistRow])).toEqual([
      unblacklistRow,
    ]);
  });
});
