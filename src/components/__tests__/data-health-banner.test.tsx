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

  it("distinguishes failed producer refreshes while retaining advisory details outside the banner body", () => {
    const nowMs = Date.UTC(2026, 9, 14, 6);
    const failure = '199 - "Latest sync-dex-liquidity run failed; serving last successful dataset (failedSources=defillama-yields)"';
    const render = (warning: string, ageHours = 0) => renderToStaticMarkup(<DataHealthBanner entries={[deriveDataHealth({
      label: "Liquidity", dataUpdatedAt: nowMs, staleTime: 3600_000, hasData: true,
      meta: { updatedAt: nowMs / 1000 - ageHours * 3600, ageSeconds: ageHours * 3600, status: "fresh", warning },
    }, nowMs)]} />);
    const failed = render(failure);
    expect(failed).toContain("Refresh failed; showing saved data");
    expect(failed).not.toContain("Data quality warning");
    expect(failed).toContain('title="Liquidity: Latest sync-dex-liquidity run failed;');
    expect(failed.replace(/title="[^"]*"/g, "")).not.toContain("failedSources=");
    expect(render(`110 - "Response is stale", ${failure}`, 9)).toContain("Refresh failed; showing saved data");
    expect(render(failure, 13)).toContain("Showing an older snapshot");

    const quality = render('199 - "Latest sync-dex-liquidity run shows high quality drift (qualityDriftFlags=major-tvl-cliff:usds-sky)"');
    expect(quality).toContain("Data quality warning");
    expect(quality).toContain("qualityDriftFlags=major-tvl-cliff:usds-sky");
    expect(quality.replace(/title="[^"]*"/g, "")).not.toContain("qualityDriftFlags=");
    expect(failed).not.toContain("199 -");
    expect(quality).not.toContain("199 -");
  });

  it("names the lagging source instead of a stall when totals were rebuilt within budget", () => {
    const nowMs = Date.UTC(2026, 9, 12, 20, 0);
    const nowSec = nowMs / 1000;
    const input: Parameters<typeof deriveDataHealth>[0] = {
      label: "Freeze totals", dataUpdatedAt: nowMs, staleTime: 6 * 3600_000, hasData: true,
      meta: { updatedAt: nowSec - 56 * 3600, ageSeconds: 56 * 3600, status: "stale", freshBudgetSec: 48 * 3600, warning: '110 - "Response is stale"' },
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

  it("names independent dependency clocks and budgets without leaking HTTP syntax", () => {
    const nowMs = Date.UTC(2026, 9, 19, 23);
    const warning = '199 - "Flight-to-quality classification unavailable (source-stale, Safety Score budget 1h)"';
    const flowMeta = {
      updatedAt: nowMs / 1000 - 120, ageSeconds: 120, status: "fresh" as const,
      freshBudgetSec: 28800, degradedBudgetSec: 43200, warning,
      dependencies: {
        flightToQuality: { updatedAt: nowMs / 1000 - 4000, ageSeconds: 4000, status: "stale" as const,
          reason: "source-stale", freshBudgetSec: 3600, generationId: "accepted-safety-generation" },
      },
    };
    const entries = [
      deriveDataHealth({ label: "Mint/Burn Flows", dataUpdatedAt: nowMs, staleTime: 3600_000, hasData: true, meta: flowMeta }, nowMs),
      deriveDataHealth({ label: "Live Reserves", dataUpdatedAt: nowMs, staleTime: 3600_000, hasData: true,
        meta: { updatedAt: nowMs / 1000, ageSeconds: 0, status: "fresh",
          dependencies: { reserveEvidence: { status: "fresh", reason: "live; sync:ok; fetch budget 172800 seconds; source budget 604800 seconds" } } } }, nowMs),
    ];
    const markup = renderToStaticMarkup(<DataHealthBanner persistent entries={entries} />);
    expect(markup).toContain("Data quality warning");
    expect(markup).toContain("freshness budget 8h");
    expect(markup).toContain("Safety Score publication (flight-to-quality): stale");
    expect(markup).toContain("dependency freshness budget 1h");
    expect(markup).toContain("accepted-safety-generation");
    expect(markup).toContain("reason source-stale");
    expect(markup).toContain("live; sync:ok; fetch budget 172800 seconds");
    expect(markup).toContain("source budget 604800 seconds");
    expect(markup).not.toContain("199 -");
    expect(flowMeta.warning).toBe(warning);
  });
});
