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
      observedSince: {}, unavailableIds: [],
    }).state).toBe("corrupt");
    expect(assess({
      generation: "reserve-alert-source-v0",
      publishedAt: nowSec,
      continuous: true,
      driftIds: [],
      observedSince: {}, unavailableIds: [],
    })).toMatchObject({ state: "wrong-generation", generation: "reserve-alert-source-v0" });
  });

  it("derives staleness from two four-hour producer intervals", () => {
    const atBoundary = {
      generation: ALERT_RESERVE_SOURCE_GENERATION,
      publishedAt: nowSec - producerIntervalSec * 2,
      continuous: true,
      driftIds: [],
      observedSince: {}, unavailableIds: [],
    };

    expect(assess(atBoundary).state).toBe("ok");
    expect(assess({ ...atBoundary, publishedAt: atBoundary.publishedAt - 1 }).state).toBe("stale");
  });

  it("marks the first publish after missing or stale state as recovering", () => {
    const first = buildAlertReserveSourceEnvelope(["usdc-circle"], null, {
      nowSec,
      producerIntervalSec,
      observedIds: ["usdc-circle"], unavailableIds: [],
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
      observedIds: ["usdc-circle"], unavailableIds: [],
    });
    expect(recovered.continuous).toBe(false);
    expect(assess(recovered).state).toBe("recovering");
  });

  it("becomes alertable only after the next continuous expected-generation publish", () => {
    const first = buildAlertReserveSourceEnvelope(["usdc-circle"], null, {
      nowSec: nowSec - producerIntervalSec,
      producerIntervalSec,
      observedIds: ["usdc-circle"], unavailableIds: [],
    });
    const next = buildAlertReserveSourceEnvelope(["usdc-circle"], cached(first), {
      nowSec,
      producerIntervalSec,
      observedIds: ["usdc-circle"], unavailableIds: [],
    });

    expect(next.continuous).toBe(true);
    expect(assess(next)).toMatchObject({
      state: "ok",
      generation: ALERT_RESERVE_SOURCE_GENERATION,
      ageSeconds: 0,
    });
  });

  it("resets only a returning asset's observation epoch while preserving observed peers", () => {
    const first = buildAlertReserveSourceEnvelope(["coin"], null, {
      nowSec: nowSec - 2 * producerIntervalSec, producerIntervalSec,
      observedIds: ["coin", "peer"], unavailableIds: [],
    });
    const gap = buildAlertReserveSourceEnvelope([], cached(first), {
      nowSec: nowSec - producerIntervalSec, producerIntervalSec,
      observedIds: ["peer"], unavailableIds: ["coin"],
    });
    const recovery = buildAlertReserveSourceEnvelope(["coin", "peer"], cached(gap), {
      nowSec, producerIntervalSec, observedIds: ["coin", "peer"], unavailableIds: [],
    });
    expect(gap.unavailableIds).toEqual(["coin"]);
    expect(gap.observedSince.coin).toBeUndefined();
    expect(recovery.observedSince.coin).toBe(nowSec);
    expect(recovery.observedSince.peer).toBe(first.observedSince.peer);
    expect(assess(recovery).state).toBe("ok");
  });
});
