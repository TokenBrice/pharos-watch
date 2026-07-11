import { describe, expect, it } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  ALERT_RESERVE_SOURCE_GENERATION,
  assessAlertReserveSourceCache,
  buildAlertReserveSourceEnvelope,
} from "../alert-reserve-source-cache";

const nowSec = 2_000_000_000;
const producerIntervalSec = CRON_INTERVALS["sync-live-reserves"];

function cached(value: unknown, updatedAt = nowSec) {
  return { value: JSON.stringify(value), updatedAt };
}

function assess(value: unknown) {
  return assessAlertReserveSourceCache(cached(value), {
    expectedGeneration: ALERT_RESERVE_SOURCE_GENERATION,
    nowSec,
    producerIntervalSec,
  });
}

describe("alert reserve source cache", () => {
  it("rejects missing, malformed, future, and wrong-generation envelopes", () => {
    expect(assessAlertReserveSourceCache(null, { nowSec, producerIntervalSec }).state).toBe("missing");
    expect(assess({ driftIds: [] }).state).toBe("corrupt");
    expect(assess({
      generation: ALERT_RESERVE_SOURCE_GENERATION,
      publishedAt: nowSec + 1,
      continuous: true,
      driftIds: [],
    }).state).toBe("corrupt");
    expect(assess({
      generation: "reserve-alert-source-v0",
      publishedAt: nowSec,
      continuous: true,
      driftIds: [],
    })).toMatchObject({ state: "wrong-generation", generation: "reserve-alert-source-v0" });
  });

  it("derives staleness from two four-hour producer intervals", () => {
    const atBoundary = {
      generation: ALERT_RESERVE_SOURCE_GENERATION,
      publishedAt: nowSec - producerIntervalSec * 2,
      continuous: true,
      driftIds: [],
    };

    expect(assess(atBoundary).state).toBe("ok");
    expect(assess({ ...atBoundary, publishedAt: atBoundary.publishedAt - 1 }).state).toBe("stale");
  });

  it("marks the first publish after missing or stale state as recovering", () => {
    const first = buildAlertReserveSourceEnvelope(["usdc-circle"], null, {
      nowSec,
      producerIntervalSec,
    });
    expect(first).toMatchObject({ continuous: false, driftIds: ["usdc-circle"] });
    expect(assess(first).state).toBe("recovering");

    const stalePrevious = cached({
      ...first,
      publishedAt: nowSec - producerIntervalSec * 2 - 1,
    });
    const recovered = buildAlertReserveSourceEnvelope(["usdc-circle"], stalePrevious, {
      nowSec,
      producerIntervalSec,
    });
    expect(recovered.continuous).toBe(false);
    expect(assess(recovered).state).toBe("recovering");
  });

  it("becomes alertable only after the next continuous expected-generation publish", () => {
    const first = buildAlertReserveSourceEnvelope(["usdc-circle"], null, {
      nowSec: nowSec - producerIntervalSec,
      producerIntervalSec,
    });
    const next = buildAlertReserveSourceEnvelope(["usdc-circle"], cached(first), {
      nowSec,
      producerIntervalSec,
    });

    expect(next.continuous).toBe(true);
    expect(assess(next)).toMatchObject({
      state: "ok",
      generation: ALERT_RESERVE_SOURCE_GENERATION,
      ageSeconds: 0,
    });
  });
});
