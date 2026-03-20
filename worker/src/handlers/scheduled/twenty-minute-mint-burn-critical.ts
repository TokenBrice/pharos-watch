import { buildInClause } from "../../lib/db";
import { getCache, setCache } from "../../lib/db-cache";
import { sendAlert } from "../../lib/alerts";
import { evaluateMintBurnFreshness } from "../../lib/mint-burn-health-config";
import { runMintBurnSlot } from "./mint-burn-slot";
import type { ScheduledRuntimeContext } from "./context";

export async function runTwentyMinuteMintBurnCriticalSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runMintBurnSlot(runtime, {
    lane: "critical",
    jobName: "sync-mint-burn",
    skipMessage: "[cron] Alchemy circuit open - skipping mint/burn sync",
    onSettledSuccess: async (settledRuntime) => {
      try {
      const symbols = settledRuntime.mintBurnFreshnessConfig.majorSymbols;
      if (symbols.length === 0) return;
      const symbolInClause = buildInClause(symbols);
      const now = Math.floor(Date.now() / 1000);
      const rows = await settledRuntime.db
        .prepare(
          `SELECT symbol, MAX(timestamp) as latest_ts
             FROM mint_burn_events
             WHERE symbol IN (${symbolInClause.sql})
             GROUP BY symbol`,
        )
        .bind(...symbolInClause.binds)
        .all<{ symbol: string; latest_ts: number | null }>();

      const latestBySymbol = new Map<string, number | null>();
      for (const row of rows.results ?? []) {
        latestBySymbol.set(row.symbol, row.latest_ts ?? null);
      }

      const freshness = evaluateMintBurnFreshness(now, latestBySymbol, runtime.mintBurnFreshnessConfig);

      const emitAlert = async (severity: "warn" | "crit", details: string[]): Promise<void> => {
        if (details.length === 0) return;
        const cacheKey = `alert:mint-burn-stale:${severity}`;
        const prior = await getCache(settledRuntime.db, cacheKey);
        if (prior && now - prior.updatedAt < settledRuntime.mintBurnFreshnessConfig.alertCooldownSec) return;
        const threshold = severity === "crit"
          ? settledRuntime.mintBurnFreshnessConfig.staleCritSec
          : settledRuntime.mintBurnFreshnessConfig.staleWarnSec;
        await sendAlert(
          settledRuntime.alertWebhookUrl,
          `Mint/burn staleness (${severity.toUpperCase()})`,
          `Threshold=${Math.round(threshold / 3600)}h, symbols=${details.join(", ")}`,
        );
        await setCache(settledRuntime.db, cacheKey, JSON.stringify({ symbols: details, at: now }));
      };

      await emitAlert("warn", freshness.warnDetails);
      await emitAlert("crit", freshness.critDetails);
      } catch {
        // Non-blocking alert path.
      }
    },
  });
}
