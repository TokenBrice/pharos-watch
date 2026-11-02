import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CASE_STUDY_LIST,
  CASE_STUDIES,
  caseStudySlugForEvent,
} from "@/lib/case-studies";
import {
  CASE_STUDY_CHART_MAX_DAYS,
  getCaseStudyChartDays,
} from "@/lib/case-study-event-window";
import { DAY_MS } from "@/lib/constants";

const COINS_DIR = join(process.cwd(), "shared/data/stablecoins/coins");

const TRACKED_COIN_IDS = new Set(
  readdirSync(COINS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")),
);


describe("case-study content", () => {

  it("uses the tracked bUSD0 identity for the USD0++ live chart", () => {
    const study = CASE_STUDIES["usd0pp-usual-2025"];
    expect(study.primaryCoinId).toBe("busd0-usual");
    expect(study.dataWidgets?.map((widget) => widget.coinId)).toEqual(["busd0-usual"]);
  });

  it("keeps every captioned event reachable inside the supply-history API limit", () => {
    const nowMs = Date.now();
    for (const study of CASE_STUDY_LIST.filter((entry) => entry.dataWidgets?.length)) {
      const windows = study.eventWindows ?? [study.eventWindow];
      const earliestStart = Math.min(...windows.map((window) => Date.parse(window.startISO)));
      const days = getCaseStudyChartDays(windows, nowMs);
      expect(days, `chart days exceed API max in ${study.slug}`).toBeLessThanOrEqual(
        CASE_STUDY_CHART_MAX_DAYS,
      );
      expect(
        nowMs - days * DAY_MS,
        `chart cannot reach the earliest captioned event in ${study.slug}`,
      ).toBeLessThanOrEqual(earliestStart);
    }
  });

  it("keeps Terra's displayed low and basis-point deviation exact", () => {
    const { lowPrice, peakDeviationBps } = CASE_STUDIES["terra-ust-2022"].eventWindow;
    expect(peakDeviationBps).toBe(Math.round(((lowPrice ?? 1) - 1) * 10_000));
  });

  it("keeps each displayed low and basis-point deviation in the same window", () => {
    for (const study of CASE_STUDY_LIST) {
      for (const window of study.eventWindows ?? [study.eventWindow]) {
        const { lowPrice, peakDeviationBps } = window;
        if (lowPrice == null || peakDeviationBps == null) continue;
        // Above-peg peaks are measured against a different side of the band.
        if (peakDeviationBps >= 0 || lowPrice >= 1) continue;
        const impliedBps = Math.round((lowPrice - 1) * 10_000);
        // The low is displayed to three decimals, so its price rounding moves
        // the implied deviation by at most 0.0005 × 10,000 = 5 bps.
        const displayToleranceBps = Math.ceil(10_000 * 0.0005);
        expect(
          Math.abs(peakDeviationBps - impliedBps),
          `${study.slug} low $${lowPrice} implies ${impliedBps} bps but peakDeviationBps is ${peakDeviationBps}`,
        ).toBeLessThanOrEqual(displayToleranceBps);
      }
    }
  });

  describe.each(CASE_STUDY_LIST)("$slug", (study) => {

    it("references only tracked coins", () => {
      const coinIds = [
        study.primaryCoinId,
        ...(study.relatedCoins ?? []).map((c) => c.coinId),
        ...(study.dataWidgets ?? []).map((w) => w.coinId),
      ].filter((id): id is string => Boolean(id));
      for (const id of coinIds) {
        expect(TRACKED_COIN_IDS.has(id), `unknown coin id: ${id}`).toBe(true);
      }
    });

    it("uses parseable chronological timeline and event-window dates", () => {
      const windows = study.eventWindows ?? [study.eventWindow];
      expect(windows.length).toBeGreaterThan(0);
      const windowEnds = windows.map((window) => {
        const windowStart = Date.parse(window.startISO);
        const windowEnd = window.endISO ? Date.parse(window.endISO) : windowStart;
        expect(
          Number.isFinite(windowStart),
          `invalid event window start: ${window.startISO}`,
        ).toBe(true);
        expect(
          Number.isFinite(windowEnd),
          `invalid event window end: ${window.endISO}`,
        ).toBe(true);
        expect(windowEnd).toBeGreaterThanOrEqual(windowStart);
        return windowEnd;
      });

      let previous = Number.NEGATIVE_INFINITY;
      for (const entry of study.timeline) {
        const next = Date.parse(entry.dateISO);
        expect(Number.isFinite(next), `invalid timeline date: ${entry.dateISO}`).toBe(true);
        expect(next, `timeline out of order at ${entry.dateISO}`).toBeGreaterThanOrEqual(previous);
        previous = next;
      }

      const latestWindowEnd = Math.max(...windowEnds);
      const highSeverityAfterWindow = study.timeline
        .filter((entry) => (entry.severity ?? "low") === "high")
        .filter((entry) => Date.parse(entry.dateISO) > latestWindowEnd)
        .map((entry) => `${entry.dateISO} ${entry.headline}`);
      expect(
        highSeverityAfterWindow,
        `high-severity timeline entries after the final event window in ${study.slug}`,
      ).toEqual([]);
    });

    it("uses sane deviation metadata when provided", () => {
      if (study.eventWindow.lowPrice !== undefined) {
        expect(
          study.eventWindow.lowPrice,
          `implausible lowPrice: ${study.eventWindow.lowPrice}`,
        ).toBeGreaterThan(0);
        expect(
          study.eventWindow.lowPrice,
          `implausible lowPrice: ${study.eventWindow.lowPrice}`,
        ).toBeLessThanOrEqual(2);
      }
      if (study.eventWindow.peakDeviationBps !== undefined) {
        expect(
          Math.abs(study.eventWindow.peakDeviationBps),
          `implausible peakDeviationBps: ${study.eventWindow.peakDeviationBps}`,
        ).toBeLessThanOrEqual(10_000);
      }
    });

    it("keeps data widgets attached to the subject or related coins", () => {
      const allowedWidgetCoinIds = new Set([
        study.primaryCoinId,
        ...(study.relatedCoins ?? []).map((coin) => coin.coinId),
      ].filter(Boolean));
      for (const widget of study.dataWidgets ?? []) {
        expect(
          allowedWidgetCoinIds.has(widget.coinId),
          `dataWidget coinId is not attached to ${study.slug}: ${widget.coinId}`,
        ).toBe(true);
      }
    });

  });
});

describe("caseStudySlugForEvent", () => {
  it("maps a subject coin's in-window event to its study", () => {
    expect(caseStudySlugForEvent("usdc-circle", Date.UTC(2023, 2, 11))).toBe("usdc-svb-2023");
    expect(caseStudySlugForEvent("dai-makerdao", Date.UTC(2020, 2, 12))).toBe("dai-black-thursday");
    expect(caseStudySlugForEvent("crvusd-curve", Date.UTC(2024, 5, 12))).toBe(
      "crvusd-exploit-trilogy",
    );
  });

  it("returns undefined for events outside any study window", () => {
    expect(caseStudySlugForEvent("usdt-tether", Date.UTC(2018, 9, 15))).toBeUndefined();
    expect(caseStudySlugForEvent("usdc-circle", Date.UTC(2024, 5, 30))).toBeUndefined();
  });

});
