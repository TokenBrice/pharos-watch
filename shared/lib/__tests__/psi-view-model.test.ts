import { describe, expect, it } from "vitest";
import {
  buildPsiChartData,
  getCompletedPsiHistory,
  getDisplayedPsi,
  getPsiBandStreak,
  getPsiCompletedDayPoint,
  getPsiTodayMidnight,
  upsertPsiHistoryPoint,
} from "../psi-view-model";

describe("psi-view-model", () => {
  const computedAt = 1_772_401_200; // 2026-03-05T12:00:00Z
  const todayMidnight = getPsiTodayMidnight(computedAt);
  const yesterday = todayMidnight - 86_400;
  const twoDaysAgo = yesterday - 86_400;

  describe("getDisplayedPsi", () => {
    it("prefers avg24h and avg24hBand when present", () => {
      expect(getDisplayedPsi({
        score: 71.2,
        band: "TREMOR",
        avg24h: 77.5,
        avg24hBand: "STEADY",
        computedAt,
      })).toEqual({ score: 77.5, band: "STEADY" });
    });

    it("falls back to current score and band", () => {
      expect(getDisplayedPsi({
        score: 71.2,
        band: "TREMOR",
        computedAt,
      })).toEqual({ score: 71.2, band: "TREMOR" });
    });
  });

  describe("getCompletedPsiHistory", () => {
    it("excludes synthetic or duplicated today points", () => {
      const history = [
        { date: todayMidnight, score: 80, band: "STEADY" },
        { date: yesterday, score: 76, band: "STEADY" },
        { date: twoDaysAgo, score: 74, band: "TREMOR" },
      ];

      expect(getCompletedPsiHistory(history, computedAt)).toEqual([
        { date: yesterday, score: 76, band: "STEADY" },
        { date: twoDaysAgo, score: 74, band: "TREMOR" },
      ]);
    });
  });

  describe("getPsiBandStreak", () => {
    it("starts at today and counts consecutive completed days in the same band", () => {
      const history = [
        { date: todayMidnight, score: 78, band: "STEADY" },
        { date: yesterday, score: 77, band: "STEADY" },
        { date: twoDaysAgo, score: 76, band: "STEADY" },
      ];

      expect(getPsiBandStreak(history, computedAt, "STEADY")).toBe(3);
    });

    it("stops when the first completed day changes band", () => {
      const history = [
        { date: todayMidnight, score: 78, band: "STEADY" },
        { date: yesterday, score: 74, band: "TREMOR" },
        { date: twoDaysAgo, score: 73, band: "TREMOR" },
      ];

      expect(getPsiBandStreak(history, computedAt, "STEADY")).toBe(1);
    });
  });

  describe("getPsiCompletedDayPoint", () => {
    it("resolves previous completed UTC days without counting today", () => {
      const history = [
        { date: todayMidnight, score: 80, band: "STEADY" },
        { date: yesterday, score: 76, band: "STEADY" },
        { date: twoDaysAgo, score: 74, band: "TREMOR" },
      ];

      expect(getPsiCompletedDayPoint(history, computedAt, 1)).toEqual({
        date: yesterday,
        score: 76,
        band: "STEADY",
      });
      expect(getPsiCompletedDayPoint(history, computedAt, 2)).toEqual({
        date: twoDaysAgo,
        score: 74,
        band: "TREMOR",
      });
    });
  });

  describe("upsertPsiHistoryPoint", () => {
    it("replaces an existing entry for the same day instead of duplicating it", () => {
      const history = [
        { date: todayMidnight, score: 79, band: "STEADY" },
        { date: yesterday, score: 76, band: "STEADY" },
      ];

      expect(upsertPsiHistoryPoint(history, {
        date: todayMidnight,
        score: 80,
        band: "STEADY",
      })).toEqual([
        { date: todayMidnight, score: 80, band: "STEADY" },
        { date: yesterday, score: 76, band: "STEADY" },
      ]);
    });
  });

  describe("buildPsiChartData", () => {
    it("returns historical points in chronological order with the current point appended", () => {
      const chart = buildPsiChartData(
        [
          { date: yesterday, score: 76, band: "STEADY" },
          { date: twoDaysAgo, score: 74, band: "TREMOR" },
        ],
        { computedAt, score: 78 },
      );

      expect(chart).toEqual([
        { ts: twoDaysAgo * 1000, score: 74 },
        { ts: yesterday * 1000, score: 76 },
        { ts: computedAt * 1000, score: 78 },
      ]);
    });

    it("returns an empty array when current or history is missing", () => {
      expect(buildPsiChartData(null, { computedAt, score: 78 })).toEqual([]);
      expect(buildPsiChartData([{ date: yesterday, score: 76, band: "STEADY" }], null)).toEqual([]);
    });
  });
});
