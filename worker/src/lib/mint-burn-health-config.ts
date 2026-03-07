const MINT_BURN_MAJOR_SYMBOLS = [
  "USDT",
  "USDC",
  "DAI",
  "USDS",
  "GHO",
  "FRXUSD",
  "BOLD",
  "reUSD",
] as const;

const MINT_BURN_STALE_WARN_SEC = 6 * 3600;
const MINT_BURN_STALE_CRIT_SEC = 24 * 3600;
const MINT_BURN_ALERT_COOLDOWN_SEC = 3600;

export interface MintBurnFreshnessConfig {
  majorSymbols: string[];
  staleWarnSec: number;
  staleCritSec: number;
  alertCooldownSec: number;
}

interface MintBurnFreshnessEnv {
  MINT_BURN_MAJOR_SYMBOLS?: string;
  MINT_BURN_STALE_WARN_SEC?: string;
  MINT_BURN_STALE_CRIT_SEC?: string;
  MINT_BURN_ALERT_COOLDOWN_SEC?: string;
}

function parseCsvSymbols(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveMintBurnFreshnessConfig(env?: MintBurnFreshnessEnv): MintBurnFreshnessConfig {
  const envMajorSymbols = parseCsvSymbols(env?.MINT_BURN_MAJOR_SYMBOLS);
  return {
    majorSymbols: envMajorSymbols.length > 0 ? envMajorSymbols : [...MINT_BURN_MAJOR_SYMBOLS],
    staleWarnSec: parsePositiveInt(env?.MINT_BURN_STALE_WARN_SEC, MINT_BURN_STALE_WARN_SEC),
    staleCritSec: parsePositiveInt(env?.MINT_BURN_STALE_CRIT_SEC, MINT_BURN_STALE_CRIT_SEC),
    alertCooldownSec: parsePositiveInt(env?.MINT_BURN_ALERT_COOLDOWN_SEC, MINT_BURN_ALERT_COOLDOWN_SEC),
  };
}

export interface MintBurnFreshnessEvaluation {
  staleMajorSymbols: string[];
  criticalStaleCount: number;
  warnDetails: string[];
  critDetails: string[];
}

export function evaluateMintBurnFreshness(
  nowSec: number,
  latestBySymbol: Map<string, number | null | undefined>,
  config: Pick<MintBurnFreshnessConfig, "majorSymbols" | "staleWarnSec" | "staleCritSec">,
): MintBurnFreshnessEvaluation {
  const staleMajorSymbols: string[] = [];
  const warnDetails: string[] = [];
  const critDetails: string[] = [];
  let criticalStaleCount = 0;

  for (const symbol of config.majorSymbols) {
    const latest = latestBySymbol.get(symbol);
    const ageSec = latest == null ? Number.POSITIVE_INFINITY : Math.max(0, nowSec - latest);
    if (ageSec >= config.staleWarnSec) {
      staleMajorSymbols.push(symbol);
      if (ageSec >= config.staleCritSec) {
        criticalStaleCount++;
        critDetails.push(`${symbol}:${latest == null ? "missing" : `${Math.round(ageSec / 3600)}h`}`);
      } else {
        warnDetails.push(`${symbol}:${Math.round(ageSec / 3600)}h`);
      }
    }
  }

  return {
    staleMajorSymbols,
    criticalStaleCount,
    warnDetails,
    critDetails,
  };
}
