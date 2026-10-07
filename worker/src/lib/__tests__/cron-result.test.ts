import { describe, expect, expectTypeOf, it } from "vitest";
import { serializeCronMetadata, type StructuredCronResult } from "../cron-result";
import { getCronQualityReasons } from "@shared/lib/cron-quality-reasons";
import type { CronResultStatus, CronRunStatus } from "@shared/types/status/cron";

describe("serializeCronMetadata", () => {
  it("serializes structured metadata as a CronResult-compatible string", () => {
    const metadata = serializeCronMetadata({
      reason: "cache-fresh",
      rowsWritten: 0,
      flags: ["cooldown"],
      nested: { ok: true },
    });

    expect(metadata).toBe(
      '{"reason":"cache-fresh","rowsWritten":0,"flags":["cooldown"],"nested":{"ok":true}}',
    );
  });

  it("omits metadata when no object is supplied", () => {
    expect(serializeCronMetadata(null)).toBeUndefined();
    expect(serializeCronMetadata(undefined)).toBeUndefined();
  });
});

describe("cron result boundaries", () => {
  it("requires a string reason for every non-ok factory input", () => {
    expectTypeOf<{ status: "degraded"; metadata: { rows: number } }>().not.toExtend<StructuredCronResult>();
    expectTypeOf<{ status: "error" }>().not.toExtend<StructuredCronResult>();
    expectTypeOf<{ status: "skipped_neutral"; metadata: { reason?: string } }>().not.toExtend<StructuredCronResult>();
    expectTypeOf<{ status: "skipped_locked"; metadata: Record<string, never> }>().not.toExtend<StructuredCronResult>();
    expectTypeOf<{ status: "degraded"; metadata: { reason: null } }>().not.toExtend<StructuredCronResult>();
    expectTypeOf<{ status: "degraded" | "error" | "skipped_neutral" | "skipped_locked"; metadata: { reason: string } }>().toExtend<StructuredCronResult>();
    expectTypeOf<{ status: "ok" }>().toExtend<StructuredCronResult>();
    expectTypeOf<{ status: "ok"; metadata: { rows: number } }>().toExtend<StructuredCronResult>();
    expectTypeOf<{ status: "skipped_duplicate"; metadata: { reason: string } }>().not.toExtend<StructuredCronResult>();
    expectTypeOf<{ status: "skipped_running"; metadata: { reason: string } }>().not.toExtend<StructuredCronResult>();
    expectTypeOf<CronResultStatus>().toEqualTypeOf<Exclude<CronRunStatus, "skipped_duplicate" | "skipped_running">>();
  });

  it("reads current quality findings without reviving expired sentinel diagnostics", () => {
    expect(getCronQualityReasons({
      quality: { sources: { growth: { reason: "row-count-threshold" } } },
      sources: { expired: { metadata: { quality: { reason: "expired-warning" } } } },
    })).toEqual(["growth:row-count-threshold"]);
    expect(getCronQualityReasons({ quality: { reasons: ["", "coverage-gap", "coverage-gap", 2] } }))
      .toEqual(["coverage-gap"]);
    expect(getCronQualityReasons({ quality: { degraded: false, reasons: [], advisoryReasons: ["advisory"] } }))
      .toEqual([]);
  });
});
