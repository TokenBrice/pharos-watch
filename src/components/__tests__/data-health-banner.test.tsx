import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataHealthBanner } from "../data-health-banner";
import { deriveDataHealth, isPublicWarning } from "@/lib/data-health";

describe("DataHealthBanner", () => {
  const nowMs = Date.UTC(2026, 9, 21, 12);
  const base = { label: "Liquidity", dataUpdatedAt: nowMs, staleTime: 3600_000, hasData: true };
  const derive = (overrides: Partial<Parameters<typeof deriveDataHealth>[0]>) =>
    deriveDataHealth({ ...base, ...overrides }, nowMs);
  const render = (overrides: Partial<Parameters<typeof deriveDataHealth>[0]>) =>
    renderToStaticMarkup(<DataHealthBanner entries={[derive(overrides)]} />);

  it("keeps degraded findings off the public surface", () => {
    const degraded = [
      { meta: { status: "degraded" as const, warning: '199 - "Quality drift"' } },
      { error: new Error("offline") },
      { dataUpdatedAt: nowMs - 9 * 3600_000 },
      {
        meta: {
          updatedAt: nowMs / 1000, ageSeconds: 0, status: "fresh" as const,
          dependencies: { flightToQuality: { status: "stale" as const, reason: "source-stale" } },
        },
      },
    ];
    for (const overrides of degraded) {
      expect(derive(overrides).state).toBe("degraded");
      expect(isPublicWarning(derive(overrides))).toBe(false);
      expect(render(overrides)).toBe("");
    }
  });

  it("keeps a live reserve book with an unreadable constituent off the public surface", () => {
    const markup = render({
      label: "Live Reserves",
      meta: {
        updatedAt: nowMs / 1000, ageSeconds: 0, status: "degraded", freshBudgetSec: 172800, degradedBudgetSec: 172800,
        warning: "live; sync:degraded; liquity-v2-branches unavailable or unclassified constituents: WETH (balance-unavailable)",
      },
    });
    expect(markup).toBe("");
  });

  it("warns once data is past the stale band, with a path to the full breakdown", () => {
    const markup = render({ dataUpdatedAt: nowMs - 13 * 3600_000 });
    expect(markup).toContain("Showing an older snapshot");
    expect(markup).toContain("Liquidity last refreshed over 13h ago");
    expect(markup).toMatch(/href="\/status\/?"/);
    expect(markup).not.toContain("199 -");
  });

  it("warns when a dataset is missing with nothing retained", () => {
    expect(render({ hasData: false, dataUpdatedAt: 0, error: new Error("boom") })).toContain("Refresh failed");
    expect(render({ hasData: false, dataUpdatedAt: 0 })).toContain("Waiting for initial data");
  });

  it("names only the publicly material datasets", () => {
    const markup = renderToStaticMarkup(<DataHealthBanner entries={[
      derive({ label: "Peg Data", meta: { status: "degraded", warning: '199 - "Quality drift"' } }),
      derive({ label: "Supply History", dataUpdatedAt: nowMs - 13 * 3600_000 }),
    ]} />);
    expect(markup).toContain("Supply History last refreshed");
    expect(markup).not.toContain("Peg Data");
  });
});
