import { buildInClause } from "../../lib/db";
import { getCache, setCache } from "../../lib/db-cache";
import { sendAlert } from "../../lib/alerts";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { evaluateMintBurnFreshness } from "../../lib/mint-burn-health-config";
import { syncMintBurn } from "../../cron/sync-mint-burn";
import type { ScheduledRuntimeContext } from "./context";

export async function runTwentyMinuteMintBurnCriticalSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  const alchemyAllowed = await shouldAttemptFetch(runtime.db, CIRCUIT_SOURCE.ALCHEMY);
  if (!alchemyAllowed) {
    console.warn("[cron] Alchemy circuit open - skipping mint/burn sync");
    return;
  }

  const mintBurnJob = runtime.runLeasedCron("sync-mint-burn", (signal, reportProgress) =>
    syncMintBurn(runtime.db, runtime.env.ALCHEMY_API_KEY ?? null, {
      signal,
      disabledConfigIds: runtime.mintBurnDisabledIds,
      disabledSymbols: runtime.mintBurnDisabledSymbols,
      lane: "critical",
      jobName: "sync-mint-burn",
      onProgress: reportProgress,
    }),
  );
  runtime.ctx.waitUntil(mintBurnJob);
  runtime.ctx.waitUntil(mintBurnJob.then(
    (result) => recordOutcome(
      runtime.db,
      CIRCUIT_SOURCE.ALCHEMY,
      (result?.status ?? "ok") !== "error",
    ),
    () => recordOutcome(runtime.db, CIRCUIT_SOURCE.ALCHEMY, false),
  ));
  runtime.ctx.waitUntil(mintBurnJob.then(async () => {
    try {
      const symbols = runtime.mintBurnFreshnessConfig.majorSymbols;
      if (symbols.length === 0) return;
      const symbolInClause = buildInClause(symbols);
      const now = Math.floor(Date.now() / 1000);
      const rows = await runtime.db
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
        const prior = await getCache(runtime.db, cacheKey);
        if (prior && now - prior.updatedAt < runtime.mintBurnFreshnessConfig.alertCooldownSec) return;
        const threshold = severity === "crit"
          ? runtime.mintBurnFreshnessConfig.staleCritSec
          : runtime.mintBurnFreshnessConfig.staleWarnSec;
        await sendAlert(
          runtime.alertWebhookUrl,
          `Mint/burn staleness (${severity.toUpperCase()})`,
          `Threshold=${Math.round(threshold / 3600)}h, symbols=${details.join(", ")}`,
        );
        await setCache(runtime.db, cacheKey, JSON.stringify({ symbols: details, at: now }));
      };

      await emitAlert("warn", freshness.warnDetails);
      await emitAlert("crit", freshness.critDetails);
    } catch {
      // Non-blocking alert path.
    }
  }));
}
