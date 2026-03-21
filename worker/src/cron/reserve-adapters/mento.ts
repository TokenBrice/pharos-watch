import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { CANONICAL_ETH_RESERVE_RISK, getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchTextWithRetry, getAdapterTimeout, requireHtmlInput, slicesFromValues } from "./helpers";

interface MentoReserveEntry {
  symbol: string;
  percent: number;
}

const RESERVE_COMPOSITION_START = '\\"reserveComposition\\":';
const RESERVE_COMPOSITION_END = '],\\"reserveHoldings\\":';

interface TokenConfig {
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
}

const TOKEN_CONFIG: Record<string, TokenConfig> = {
  sUSDS: { name: "sUSDS (Sky savings USDS)", risk: "low", coinId: "usds-sky" },
  EURC: { name: "EURC (Circle euro stablecoin)", risk: "low" },
  CELO: { name: "CELO", risk: getCanonicalReserveAssetRisk("CELO") ?? "high" },
  USDGLO: { name: "USDGLO (Glo Dollar)", risk: "low" },
  stETH: { name: "stETH (Lido staked ETH)", risk: getCanonicalReserveAssetRisk("stETH") ?? "low" },
  USDT: { name: "USDT", risk: "low", coinId: "usdt-tether" },
  USDC: { name: "USDC", risk: "low", coinId: "usdc-circle" },
  ETH: { name: "ETH", risk: CANONICAL_ETH_RESERVE_RISK },
};

function extractEscapedArray(html: string, startNeedle: string, endNeedle: string): string {
  const start = html.indexOf(startNeedle);
  if (start === -1) {
    throw new Error("Mento reserve payload is missing reserveComposition");
  }
  const contentStart = start + startNeedle.length;
  const end = html.indexOf(endNeedle, contentStart);
  if (end === -1) {
    throw new Error("Mento reserve payload is missing reserveHoldings delimiter");
  }
  return `${html.slice(contentStart, end)}]`;
}

export function parseMentoReserveComposition(html: string): MentoReserveEntry[] {
  const escapedJson = extractEscapedArray(html, RESERVE_COMPOSITION_START, RESERVE_COMPOSITION_END);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      escapedJson
        .replace(/\\\\/g, "\\")
        .replace(/\\"/g, '"'),
    );
  } catch (e) {
    throw new Error(`Mento reserve composition JSON is malformed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Mento reserveComposition was not an array");
  }

  return parsed
    .filter((entry): entry is MentoReserveEntry =>
      !!entry
      && typeof entry === "object"
      && typeof (entry as MentoReserveEntry).symbol === "string"
      && typeof (entry as MentoReserveEntry).percent === "number",
    );
}

export function adaptMentoReserveComposition(html: string): AdapterResult {
  const entries = parseMentoReserveComposition(html);
  const warnings: LiveReserveWarning[] = [];

  if (entries.length < 3) {
    warnings.push({
      code: "mento-low-entry-count",
      message: `Mento reserve composition has only ${entries.length} entries (expected >= 3)`,
      severity: "warning",
    });
  }

  const totalPct = entries.reduce((sum, e) => sum + e.percent, 0);
  if (totalPct < 50) {
    warnings.push({
      code: "mento-low-total-pct",
      message: `Mento reserve composition total is ${totalPct.toFixed(1)}% (expected >= 50%)`,
      severity: "warning",
    });
  }

  const slices = slicesFromValues(
    entries.map((entry) => {
      const config = TOKEN_CONFIG[entry.symbol];
      if (!config) {
        warnings.push({
          code: "unknown-asset",
          message: `Unmapped Mento reserve symbol: ${entry.symbol}`,
          severity: "warning",
        });
      }
      const resolved = config ?? { name: entry.symbol, risk: "medium" as const };
      return {
        name: resolved.name,
        value: entry.percent,
        risk: resolved.risk,
        ...(resolved.coinId ? { coinId: resolved.coinId } : {}),
      };
    }),
    1,
  );

  return { slices, ...(warnings.length > 0 ? { warnings } : {}) };
}

export async function fetchMentoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "mento");
  const html = await fetchTextWithRetry(input.url, signal, getAdapterTimeout(config, 12_000));
  return adaptMentoReserveComposition(html);
}
