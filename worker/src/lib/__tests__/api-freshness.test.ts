import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  getLatestSuccessfulCronTimestamp,
  getLatestSuccessfulCronTimestampResult,
} from "../api-freshness";

describe("getLatestSuccessfulCronTimestampResult", () => {
  it("returns ok when a successful cron run exists", async () => {
    const db = mockD1([
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        first: { started_at: 1_700_000_000 },
      },
    ]);

    await expect(getLatestSuccessfulCronTimestampResult(db, "sync-yield-data")).resolves.toEqual({
      timestamp: 1_700_000_000,
      status: "ok",
    });
  });

  it("returns missing when no successful cron run exists", async () => {
    const db = mockD1([
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        first: { started_at: null },
      },
    ]);

    await expect(getLatestSuccessfulCronTimestampResult(db, "sync-yield-data")).resolves.toEqual({
      timestamp: null,
      status: "missing",
    });
  });

  it("returns lookup_failed when the cron query throws", async () => {
    const db = mockD1([
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        throwError: new Error("boom"),
      },
    ]);

    await expect(getLatestSuccessfulCronTimestampResult(db, "sync-yield-data")).resolves.toEqual({
      timestamp: null,
      status: "lookup_failed",
    });
  });
});

describe("getLatestSuccessfulCronTimestamp", () => {
  it("falls back when the lookup result is missing", async () => {
    const db = mockD1([
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        first: { started_at: null },
      },
    ]);

    await expect(getLatestSuccessfulCronTimestamp(db, "sync-yield-data", 123)).resolves.toBe(123);
  });
});
