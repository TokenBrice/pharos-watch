import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildBandStripCells, RegimeBar } from "@/components/regime-bar";
import { PSI_HEX_COLORS, PSI_UNKNOWN_BAND_HEX } from "@shared/lib/psi-colors";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

const useStabilityIndexMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/api-hooks", () => ({ useStabilityIndex: useStabilityIndexMock }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

describe("buildBandStripCells", () => {
  it("keeps completed UTC days oldest-first and excludes the current day", () => {
    const computedAt = 1_772_401_200;
    const todayMidnight = 1_772_323_200;
    const yesterday = todayMidnight - 86_400;
    const twoDaysAgo = yesterday - 86_400;

    const cells = buildBandStripCells([
      { date: todayMidnight, band: "STEADY" },
      { date: yesterday, band: "TREMOR" },
      { date: twoDaysAgo, band: "CALM" },
    ], computedAt);

    expect(cells.slice(0, 3)).toEqual([
      { date: twoDaysAgo, band: "CALM" },
      { date: yesterday, band: "TREMOR" },
      null,
    ]);
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
