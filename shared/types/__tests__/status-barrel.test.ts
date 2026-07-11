import { describe, expect, expectTypeOf, it } from "vitest";
import * as status from "../status";
import type {
  CronStatus as BarrelCronStatus,
  DiscoveryCandidate as BarrelDiscoveryCandidate,
  HealthResponse as BarrelHealthResponse,
  PriceSourceHealth as BarrelPriceSourceHealth,
  PublicationHealth as BarrelPublicationHealth,
  StatusResponse as BarrelStatusResponse,
  TelegramDispatchCronResult as BarrelTelegramDispatchCronResult,
  YieldHealthSummary as BarrelYieldHealthSummary,
} from "../status";
import type { DiscoveryCandidate } from "../discovery";
import type { PriceSourceHealth } from "../pricing-source-health";
import type { CronStatus } from "../status/cron";
import type { PublicationHealth } from "../status/operational";
import * as publicHealth from "../status/public-health";
import type { HealthResponse } from "../status/public-health";
import * as response from "../status/response";
import type { StatusResponse } from "../status/response";
import * as telegram from "../status/telegram";
import type { TelegramDispatchCronResult } from "../status/telegram";
import type { YieldHealthSummary } from "../status/yield-liquidity";

const LEGACY_RUNTIME_EXPORTS = [
  "CRON_RUN_STATUS_VALUES",
  "CronRunStatusSchema",
  "HealthResponseSchema",
  "PUBLIC_STATUS_HISTORY_WINDOWS",
  "PublicStatusHistoryResponseSchema",
  "PublicStatusTransitionSchema",
  "RESERVE_ALERT_SOURCE_STATE_VALUES",
  "SAFETY_ALERT_SOURCE_STATE_VALUES",
  "STATUS_DISCREPANCY_REASON_VALUES",
  "STATUS_PROBE_COMPARISON_REASON_VALUES",
  "StatusHealthValueSchema",
  "StatusHistoryResponseSchema",
  "StatusResponseSchema",
  "TELEGRAM_ALERT_TYPES",
  "TelegramPulseSchema",
  "WORKER_JOB_ATTEMPT_STATE_VALUES",
  "WORKER_JOB_ATTEMPT_STATUS_CLASS_VALUES",
  "isTelegramAlertType",
] as const;

describe("status compatibility barrel", () => {
  it("preserves the legacy runtime export surface without leaking internal schemas", () => {
    expect(Object.keys(status).sort()).toEqual([...LEGACY_RUNTIME_EXPORTS].sort());
  });

  it("re-exports the domain schema instances used by lazy loaders", () => {
    expect(status.StatusResponseSchema).toBe(response.StatusResponseSchema);
    expect(status.StatusHistoryResponseSchema).toBe(response.StatusHistoryResponseSchema);
    expect(status.HealthResponseSchema).toBe(publicHealth.HealthResponseSchema);
    expect(status.PublicStatusHistoryResponseSchema).toBe(publicHealth.PublicStatusHistoryResponseSchema);
    expect(status.TelegramPulseSchema).toBe(telegram.TelegramPulseSchema);
  });

  it("keeps dynamic schema lookup through the compatibility path", async () => {
    const lazyStatus = await import("../status");

    expect(lazyStatus.HealthResponseSchema).toBe(publicHealth.HealthResponseSchema);
    expect(lazyStatus.TelegramPulseSchema).toBe(telegram.TelegramPulseSchema);
  });

  it("preserves representative type exports from every domain module", () => {
    expectTypeOf<BarrelCronStatus>().toEqualTypeOf<CronStatus>();
    expectTypeOf<BarrelTelegramDispatchCronResult>().toEqualTypeOf<TelegramDispatchCronResult>();
    expectTypeOf<BarrelYieldHealthSummary>().toEqualTypeOf<YieldHealthSummary>();
    expectTypeOf<BarrelPublicationHealth>().toEqualTypeOf<PublicationHealth>();
    expectTypeOf<BarrelStatusResponse>().toEqualTypeOf<StatusResponse>();
    expectTypeOf<BarrelHealthResponse>().toEqualTypeOf<HealthResponse>();
    expectTypeOf<BarrelDiscoveryCandidate>().toEqualTypeOf<DiscoveryCandidate>();
    expectTypeOf<BarrelPriceSourceHealth>().toEqualTypeOf<PriceSourceHealth>();
  });
});
