import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { runFourHourlyReserveSyncSlot } from "../hourly-live-reserves";
import type { ScheduledRuntimeContext } from "../context";

vi.mock("../../../cron/sync-live-reserves", () => ({
  syncLiveReserves: vi.fn(),
}));
vi.mock("../../../cron/sync-redemption-backstops", () => ({
  syncRedemptionBackstops: vi.fn(),
}));
vi.mock("../../../cron/sync-kinesis-supply", () => ({
  syncKinesisSupply: vi.fn(),
}));
vi.mock("../../../lib/collateral-drift", () => ({
  checkCollateralDrift: vi.fn(),
}));
vi.mock("../../../lib/live-reserves-store", () => ({
  getMaxSyncAge: vi.fn(),
}));
vi.mock("../../../lib/alerts", () => ({
  sendAlert: vi.fn(async () => {}),
}));

import { syncLiveReserves } from "../../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../../cron/sync-redemption-backstops";
import { syncKinesisSupply } from "../../../cron/sync-kinesis-supply";
import { checkCollateralDrift } from "../../../lib/collateral-drift";
import { getMaxSyncAge } from "../../../lib/live-reserves-store";

describe("runFourHourlyReserveSyncSlot", () => {
  let runLeasedCron: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(syncLiveReserves).mockResolvedValue(undefined as never);
    vi.mocked(syncRedemptionBackstops).mockResolvedValue(undefined as never);
    vi.mocked(syncKinesisSupply).mockResolvedValue(undefined as never);
    vi.mocked(checkCollateralDrift).mockResolvedValue({
      driftCoins: [],
      fallbackCoins: [],
    } as never);
    vi.mocked(getMaxSyncAge).mockResolvedValue(0);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runLeasedCron = vi.fn(async (_job: string, fn: (signal: AbortSignal, reportProgress: unknown) => Promise<unknown>) => {
      return fn(new AbortController().signal, async () => {});
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    errorSpy.mockRestore();
  });

  function buildRuntime(): ScheduledRuntimeContext {
    return {
      db: {} as D1Database,
      env: {} as ScheduledRuntimeContext["env"],
      ctx: {} as ExecutionContext,
      cron: "11 * * * *",
      scheduleKey: "hourlyReserveSync" as ScheduledRuntimeContext["scheduleKey"],
      scheduledTimeMs: null,
      slotStartedAt: 0,
      mintBurnDisabledIds: [],
      mintBurnDisabledSymbols: [],
      mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
      coingeckoApiKey: null,
      alertWebhookUrl: null,
      chainRpcs: new Map(),
      runLeasedCron: runLeasedCron as unknown as ScheduledRuntimeContext["runLeasedCron"],
    };
  }

  it("runs kinesis supply and drift check even when sync-live-reserves throws", async () => {
    vi.mocked(syncLiveReserves).mockRejectedValue(new Error("sync blew up"));

    await runFourHourlyReserveSyncSlot(buildRuntime());

    expect(syncLiveReserves).toHaveBeenCalledTimes(1);
    expect(syncRedemptionBackstops).toHaveBeenCalledTimes(1);
    expect(syncKinesisSupply).toHaveBeenCalledTimes(1);
    expect(checkCollateralDrift).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Live reserves sync failed"),
      expect.any(Error),
    );
  });

  it("runs drift check even when redemption backstops + kinesis throw", async () => {
    vi.mocked(syncRedemptionBackstops).mockRejectedValue(new Error("rb blew up"));
    vi.mocked(syncKinesisSupply).mockRejectedValue(new Error("ks blew up"));

    await runFourHourlyReserveSyncSlot(buildRuntime());

    expect(checkCollateralDrift).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redemption backstops sync failed"),
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Kinesis supply sync failed"),
      expect.any(Error),
    );
  });

  it("swallows drift check errors and logs them", async () => {
    vi.mocked(checkCollateralDrift).mockRejectedValue(new Error("drift blew up"));

    await expect(runFourHourlyReserveSyncSlot(buildRuntime())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Drift check failed"),
      expect.any(Error),
    );
  });
});
