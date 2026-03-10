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

  it("renders discovery-cron summaries for the split DEX pipeline", () => {
    const html = renderToStaticMarkup(
      <CronCard
        job="sync-dex-discovery"
        nowSeconds={1_772_100_000}
        cron={{
          lastRun: {
            startedAt: 1_772_099_100,
            durationMs: 48_000,
            status: "degraded",
            itemCount: 18,
            metadata: {
              coinsCrawled: 18,
              poolsDiscovered: 57,
              runSeq: 42,
              budgetExhausted: true,
              tierBreakdown: { t1: 7, t2: 8, t3: 3, dormant: 1, skipped: 137 },
              failedCoins: ["usdx", "euri"],
            },
          },
          recentRuns: [{ startedAt: 1_772_099_100, durationMs: 48_000, status: "degraded" }],
          expectedIntervalSec: 1200,
          healthy: true,
        }}
      />,
    );

    expect(html).toContain("DEX pool discovery");
    expect(html).toContain("sync-dex-discovery");
    expect(html).toContain("crawled 18 coins, discovered 57 pools (run #42)");
    expect(html).toContain("eligible tiers t1 7, t2 8, t3 3, dormant 1");
    expect(html).toContain("budget exhausted before the full discovery queue finished");
    expect(html).toContain("coin crawl failures 2");
  });

  it("renders scoring-cron summaries for staged-pool merge health", () => {
    const html = renderToStaticMarkup(
      <CronCard
        job="sync-dex-liquidity"
        nowSeconds={1_772_100_000}
        cron={{
          lastRun: {
            startedAt: 1_772_099_100,
            durationMs: 33_000,
            status: "degraded",
            itemCount: 126,
            metadata: {
              stagedPoolsMerged: 41,
              stagedPoolsSkipped: 9,
              stagedPoolsSkippedByAddress: 2,
              stagedPoolsSkippedByFingerprint: 7,
              failedSources: ["defillama-yields"],
              fallbackMode: ["dl-yields-unavailable"],
              sourceCoverage: {
                currentCoverage: 126,
                previousCoverage: 131,
                minExpectedCoverage: 78,
                nearCoverageGuard: true,
                priceObservationCoins: 93,
              },
            },
          },
          recentRuns: [{ startedAt: 1_772_099_100, durationMs: 33_000, status: "degraded" }],
          expectedIntervalSec: 1800,
          healthy: true,
        }}
      />,
    );

    expect(html).toContain("DEX liquidity scoring");
    expect(html).toContain("sync-dex-liquidity");
    expect(html).toContain("staged pools merged 41, skipped 9 (fp 7, addr 2)");
    expect(html).toContain("coverage 126 vs 131 previous, floor 78");
    expect(html).toContain("dex price observations 93 coins");
    expect(html).toContain("failed sources defillama-yields");
    expect(html).toContain("fallback mode dl-yields-unavailable");
    expect(html).toContain("coverage near guardrail band");
  });

  it("keeps healthy metadata summaries neutral instead of warning-colored", () => {
    const html = renderToStaticMarkup(
      <CronCard
        job="sync-mint-burn"
        nowSeconds={1_772_100_000}
        cron={{
          lastRun: {
            startedAt: 1_772_099_100,
            durationMs: 16_000,
            status: "ok",
            itemCount: 47,
            metadata: {
              lane: "critical",
              contractsProcessed: 7,
              contractsSkipped: 0,
              budgetUsed: 50,
              budgetLimit: 200,
              criticalCoverage: {
                contractsEnabled: 7,
                contractsSatisfied: 7,
              },
              laggingConfigs: [{ key: "ethereum-0xabc" }],
            },
          },
          recentRuns: [{ startedAt: 1_772_099_100, durationMs: 16_000, status: "ok" }],
          expectedIntervalSec: 1200,
          healthy: true,
        }}
      />,
    );

    expect(html).toContain("bg-muted/30");
    expect(html).not.toContain("border-amber-500/20 bg-amber-500/5");
  });
});
