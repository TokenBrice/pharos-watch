import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataHealthBanner } from "../data-health-banner";
import { deriveDataHealth } from "@/lib/data-health";

describe("DataHealthBanner", () => {
  it("distinguishes source warnings, retry failures, and old producer snapshots", () => {
    const input = { label: "Liquidity", dataUpdatedAt: Date.now(), staleTime: 3600_000, hasData: true };
    const render = (overrides: Partial<Parameters<typeof deriveDataHealth>[0]>) =>
      renderToStaticMarkup(<DataHealthBanner entries={[deriveDataHealth({ ...input, ...overrides })]} />);
    const quality = render({ meta: { status: "degraded", warning: '199 - "Quality drift"' } });
    expect(quality).toContain("Data quality warning");
    expect(quality).not.toContain("running behind");
    expect(render({ error: new Error("offline") })).toContain("Refresh failed; showing saved data");
    expect(render({ dataUpdatedAt: Date.now() - 9 * 3600_000 })).toContain("Live refresh is running behind");
  });

  it("names the lagging source instead of a stall when totals were rebuilt within budget", () => {
    const nowMs = Date.UTC(2026, 9, 12, 20, 0);
    const nowSec = nowMs / 1000;
    const input = {
      label: "Freeze totals", dataUpdatedAt: nowMs, staleTime: 6 * 3600_000, hasData: true,
      meta: { updatedAt: nowSec - 56 * 3600, freshBudgetSec: 48 * 3600, warning: '110 - "Response is stale"' },
    };
    const sources = [
      { label: "BRZ on Gnosis", lastSucceededAt: nowSec - 56 * 3600 },
      { label: "USDT on Polygon", lastSucceededAt: nowSec - 6 * 3600 },
    ];
    const render = (catchUp: Parameters<typeof deriveDataHealth>[0]["catchUp"]) =>
      renderToStaticMarkup(<DataHealthBanner entries={[deriveDataHealth({ ...input, catchUp }, nowMs)]} />);

    const current = render({ observedAt: nowSec - 3600, sources });
    expect(current).toContain("Some sources are still catching up");
    expect(current).toContain("BRZ on Gnosis history is still being backfilled");
    expect(current).not.toContain("USDT on Polygon");
    expect(current).toContain("Last complete scan of every source");
    expect(current).not.toContain("running behind");
    // Totals that are themselves out of budget keep the stall wording.
    expect(render({ observedAt: nowSec - 50 * 3600, sources })).not.toContain("catching up");
    expect(render(null)).not.toContain("catching up");
  });
});
