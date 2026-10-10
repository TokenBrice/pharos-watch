import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildBandStripCells, RegimeBar } from "@/components/regime-bar";
import { PSI_HEX_COLORS, PSI_UNKNOWN_BAND_HEX } from "@shared/lib/classification";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

const useStabilityIndexMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/api-hooks", () => ({ useStabilityIndex: useStabilityIndexMock }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

describe("buildBandStripCells", () => {
  const todayMidnight = Date.UTC(2026, 9, 9) / 1000;
  const computedAt = todayMidnight + 12 * 3600;

  it("aligns a complete month oldest-first and excludes current and expired days", () => {
    const history = Array.from({ length: 31 }, (_, index) => ({
      date: todayMidnight - index * 86_400,
      band: "STEADY",
    }));
    const cells = buildBandStripCells([
      ...history,
      { date: todayMidnight - 90 * 86_400, band: "CRISIS" },
    ], computedAt);
    expect(cells).toHaveLength(30);
    expect(cells.map((cell) => cell?.date)).toEqual(
      Array.from({ length: 30 }, (_, index) => todayMidnight - (30 - index) * 86_400),
    );
    expect(cells.every((cell) => cell?.band === "STEADY")).toBe(true);
  });

  it("leaves sparse bootstrap and interior missing days in their calendar positions", () => {
    const yesterday = todayMidnight - 86_400;
    const threeDaysAgo = todayMidnight - 3 * 86_400;
    const cells = buildBandStripCells([
      { date: yesterday, band: "TREMOR" },
      { date: threeDaysAgo, band: "STEADY" },
      { date: todayMidnight - 90 * 86_400, band: "CRISIS" },
    ], computedAt);
    expect(cells).toHaveLength(30);
    expect(cells.slice(0, 27)).toEqual(Array(27).fill(null));
    expect(cells.slice(27)).toEqual([
      { date: threeDaysAgo, band: "STEADY" },
      null,
      { date: yesterday, band: "TREMOR" },
    ]);
    expect(buildBandStripCells(undefined, computedAt)).toEqual(Array(30).fill(null));
  });
});

describe("RegimeBar freshness", () => {
  it.each(["fresh", "expired", "refresh-failed", "generation-expired", "authority-unavailable", "warning-only", "metadata-absent"] as const)(
    "qualifies %s PSI using the canonical producer freshness policy",
    (state) => {
      const now = Date.now();
      const generation = Math.floor((state === "expired" || state === "generation-expired" || state === "metadata-absent"
        ? now - DATA_HEALTH_PRESETS.stabilityIndex.staleTime * 10 : now) / 1000);
      useStabilityIndexMock.mockReturnValue({
        data: { current: { score: 5, band: "BEDROCK", computedAt: generation, components: {} } },
        dataUpdatedAt: now,
        error: state === "refresh-failed" ? new Error("refresh failed") : null,
        meta: state === "authority-unavailable"
          ? { updatedAt: null, ageSeconds: null, status: "unknown", reason: "producer-clock-unavailable" }
          : state === "warning-only"
            ? { status: "degraded", warning: "Producer unavailable" }
            : state === "metadata-absent" ? null
              : { updatedAt: state === "generation-expired" ? Math.floor(now / 1000) : generation,
                ageSeconds: (now / 1000) - generation, status: "fresh" },
      });
      const html = renderToStaticMarkup(createElement(RegimeBar));
      if (state === "fresh") {
        expect(html).toContain('aria-label="Market regime: BEDROCK, PSI 5, raw instant"');
        expect(html).toContain(`background-color:${PSI_HEX_COLORS.BEDROCK}`);
        expect(html).not.toContain("Retained observation");
      } else {
        expect(html).toContain("Current market regime unavailable");
        expect(html).toContain("Current regime unavailable");
        expect(html).toContain("Retained observation as of");
        expect(html).toContain(`background-color:${PSI_UNKNOWN_BAND_HEX}`);
        expect(html).not.toContain('aria-label="Market regime:');
        expect(html).not.toContain(`background-color:${PSI_HEX_COLORS.BEDROCK}`);
      }
    },
  );
});
