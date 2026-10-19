import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import type * as V9SlotWindow from "../../../lib/v9-slot-window";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { runV9SupplyAttributionSlot } from "../v9-supply-attribution";

const mocks = vi.hoisted(() => ({ sync: vi.fn(), withinWindow: vi.fn() }));
vi.mock("../../../cron/sync-v9-supply-attribution", () => ({ syncSafetyScoreV9SupplyAttribution: mocks.sync }));
vi.mock("../../../lib/v9-slot-window", async importOriginal => ({
  ...await importOriginal<typeof V9SlotWindow>(),
  runV9AfterCoreWithinWindow: mocks.withinWindow,
}));

describe("scheduled supply-attribution native context", () => {
  beforeEach(() => { mocks.sync.mockReset(); mocks.withinWindow.mockReset(); });

  it.each([true, false])("forwards only the runtime's admitted native capability: %s", async admitted => {
    const signal = new AbortController().signal;
    const window = { slotStartedAtSec: 1000, deadlineMs: Date.now() + 180_000, minimumRemainingMs: 60_000 };
    mocks.withinWindow.mockImplementation(async (_input, run) => run(signal, window));
    mocks.sync.mockResolvedValue({ status: "ok", itemCount: 1 });
    const dwellirNative = admitted ? createDwellirNativeCapability("native-test-key-placeholder") : undefined;
    const job = getCronJobMeta("sync-v9-supply-attribution");
    if (!job) throw new Error("Supply-attribution job is missing from the cron registry");
    const runtime = makeScheduledRuntime({ dwellirNative, scheduleKey: job.scheduleKey });
    await runV9SupplyAttributionSlot(runtime);
    expect(mocks.sync).toHaveBeenCalledExactlyOnceWith(runtime.db, runtime.chainRpcs, signal, window, dwellirNative);
  });
});
