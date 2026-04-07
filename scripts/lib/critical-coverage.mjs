export const CRITICAL_FILES = [
  "src/lib/api.ts",
  "worker/src/lib/api-cache-read.ts",
  "worker/src/lib/api-freshness.ts",
  "worker/src/lib/api-history.ts",
  "worker/src/lib/api-pagination.ts",
  "worker/src/lib/api-params.ts",
  "worker/src/lib/api-response.ts",
  "worker/src/lib/auth.ts",
  "worker/src/lib/evm-rpc.ts",
  "worker/src/lib/stablecoins-cache.ts",
  "worker/src/lib/safety-scores.ts",
  "worker/src/handlers/scheduled.ts",
  "worker/src/api/health.ts",
  "worker/src/cron/sync-stablecoins.ts",
  "worker/src/cron/daily-digest.ts",
  "worker/src/cron/sync-yield-data.ts",
  "worker/src/api/discovery.ts",
  "worker/src/api/peg-summary.ts",
  "worker/src/api/report-cards.ts",
  "worker/src/api/dex-liquidity.ts",
  "worker/src/api/stress-signals.ts",
  "worker/src/api/mint-burn-flows.ts",
  "worker/src/api/status.ts",
  "worker/src/lib/alerts.ts",
  "worker/src/api/stablecoin-detail.ts",
  "worker/src/cron/dex-liquidity/orchestrator.ts",
];

export function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

export function parseLcov(content) {
  const blocks = content.split("end_of_record\n");
  const map = new Map();

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    const sf = lines.find((line) => line.startsWith("SF:"));
    if (!sf) continue;
    const file = normalizePath(sf.slice(3));

    let lf = 0;
    let lh = 0;
    for (const line of lines) {
      if (line.startsWith("LF:")) lf = Number.parseInt(line.slice(3), 10);
      if (line.startsWith("LH:")) lh = Number.parseInt(line.slice(3), 10);
    }

    if (Number.isFinite(lf) && lf > 0) {
      map.set(file, { lf, lh, pct: (lh / lf) * 100 });
    }
  }

  return map;
}

export function findCoverageFor(file, map) {
  for (const [key, value] of map.entries()) {
    if (key.endsWith(file)) return { key, ...value };
  }
  return null;
}
