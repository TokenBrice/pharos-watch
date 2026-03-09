import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CronCard } from "@/components/status/cron-card";

describe("CronCard", () => {
  it("renders self-check latency diagnostics and a textual history count", () => {
    const html = renderToStaticMarkup(
      <CronCard
        job="status-self-check"
        nowSeconds={1_772_100_000}
        cron={{
          lastRun: {
            startedAt: 1_772_099_100,
            durationMs: 12_000,
            status: "degraded",
            itemCount: 25,
            metadata: {
              sampleCount: 25,
              failCount: 0,
              probeStatus: "healthy",
              rawOverallStatus: "healthy",
              effectiveStatus: "healthy",
              probeMode: "internal-router",
              p95LatencyMs: 2224,
              latencySummary: {
                minMs: 9,
                medianMs: 180,
                p95Ms: 2224,
                maxMs: 2501,
              },
              slowestProbes: [
                { path: "/api/peg-summary", latencyMs: 2224, status: 200 },
                { path: "/api/stablecoins", latencyMs: 1980, status: 200 },
              ],
            },
          },
          recentRuns: [
            { startedAt: 1_772_099_100, durationMs: 12_000, status: "degraded" },
            { startedAt: 1_772_098_200, durationMs: 10_500, status: "ok" },
          ],
          expectedIntervalSec: 900,
          healthy: true,
        }}
      />,
    );

    expect(html).toContain("probe mode internal-router");
    expect(html).toContain("latency median 180ms, p95 2224ms, max 2501ms");
    expect(html).toContain("slowest /api/peg-summary 2224ms, /api/stablecoins 1980ms");
    expect(html).toContain("History:");
    expect(html).toContain("2 runs");
  });
});
