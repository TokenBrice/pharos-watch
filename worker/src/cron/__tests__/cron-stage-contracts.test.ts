import { describe, expect, it, vi } from "vitest";

import {
  buildAbortedCronStageResult,
  readCronAbortReason,
  reportCronStage,
  returnIfCronStageAborted,
} from "../shared/stage-contracts";

describe("cron stage contracts", () => {
  it("reads abort reasons from Error and string signal reasons", () => {
    const errorController = new AbortController();
    errorController.abort(new Error("budget exhausted"));
    expect(readCronAbortReason(errorController.signal)).toBe("budget exhausted");

    const stringController = new AbortController();
    stringController.abort("timed out");
    expect(readCronAbortReason(stringController.signal)).toBe("timed out");
  });

  it("builds degraded abort results with custom metadata serialization", () => {
    const controller = new AbortController();
    controller.abort(new Error("quota exceeded"));

    const result = buildAbortedCronStageResult({
      signal: controller.signal,
      stage: "resolve-yield",
      serializeMetadata: (metadata) => JSON.stringify({ ...metadata, lane: "yield" }),
    });

    expect(result).toEqual({
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "aborted",
        stage: "resolve-yield",
        detail: "quota exceeded",
        lane: "yield",
      }),
    });
  });

  it("returns null when the stage has not been aborted", () => {
    expect(returnIfCronStageAborted({ signal: new AbortController().signal, stage: "intake" })).toBeNull();
  });

  it("reports normalized stage progress through the cron reporter", async () => {
    const reportProgress = vi.fn(async () => {});

    await reportCronStage(reportProgress, {
      stage: "publish",
      message: "Writing cache",
      itemsDone: 3,
      itemsTotal: 5,
      metadata: { cacheKey: "yield-rankings" },
    });

    expect(reportProgress).toHaveBeenCalledWith({
      stage: "publish",
      message: "Writing cache",
      itemsDone: 3,
      itemsTotal: 5,
      metadata: { cacheKey: "yield-rankings" },
    });
  });
});
