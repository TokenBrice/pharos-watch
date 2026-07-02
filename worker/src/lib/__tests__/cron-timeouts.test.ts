import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRON_TIMEOUT_MS,
  SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS,
  SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
  SCHEDULED_SLOT_JOB_BUDGET_MS,
  getCronTimeoutBudgetMetadata,
  getScheduledSlotControlledDeadlineMs,
  resolveCronTimeoutBudget,
} from "../cron-timeouts";

describe("cron timeout budget resolution", () => {
  it("uses the configured job timeout when no slot budget is provided", () => {
    expect(resolveCronTimeoutBudget("snapshot-supply")).toMatchObject({
      configuredTimeoutMs: DEFAULT_CRON_TIMEOUT_MS,
      effectiveTimeoutMs: DEFAULT_CRON_TIMEOUT_MS,
      truncated: false,
      exhausted: false,
      remainingSlotBudgetMs: null,
    });
  });

  it("caps a late-starting job to the remaining controlled slot budget", () => {
    const slotStartedAtMs = 1_000_000;
    const nowMs = slotStartedAtMs + SCHEDULED_SLOT_JOB_BUDGET_MS - 12_000;
    const budget = resolveCronTimeoutBudget("snapshot-supply", {
      slotBudgetStartedAtMs: slotStartedAtMs,
      nowMs,
    });

    expect(budget).toMatchObject({
      configuredTimeoutMs: DEFAULT_CRON_TIMEOUT_MS,
      effectiveTimeoutMs: 12_000,
      truncated: true,
      exhausted: false,
      remainingSlotBudgetMs: 12_000,
      slotPlatformDeadlineMs: slotStartedAtMs + SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS,
      slotControlledDeadlineMs: slotStartedAtMs + SCHEDULED_SLOT_JOB_BUDGET_MS,
      controlledErrorReserveMs: SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
    });
    expect(getCronTimeoutBudgetMetadata(budget)).toMatchObject({
      reason: "cron-timeout",
      slotBudgetTruncated: true,
      effectiveTimeoutMs: 12_000,
    });
  });

  it("marks the budget exhausted once the controlled slot deadline has passed", () => {
    const slotStartedAtMs = 1_000_000;
    const budget = resolveCronTimeoutBudget("sync-stablecoins", {
      slotBudgetStartedAtMs: slotStartedAtMs,
      nowMs: slotStartedAtMs + SCHEDULED_SLOT_JOB_BUDGET_MS + 1,
    });

    expect(budget).toMatchObject({
      effectiveTimeoutMs: 0,
      truncated: true,
      exhausted: true,
      remainingSlotBudgetMs: 0,
    });
    expect(getCronTimeoutBudgetMetadata(budget)).toMatchObject({
      reason: "cron-timeout",
      slotBudgetTruncated: true,
      slotBudgetExhausted: true,
      effectiveTimeoutMs: 0,
    });
  });

  it("derives the controlled deadline from the platform ceiling minus reserve", () => {
    const slotStartedAtMs = 1_000_000;

    expect(getScheduledSlotControlledDeadlineMs(slotStartedAtMs)).toBe(
      slotStartedAtMs + SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS - SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
    );
  });
});
