import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { CANONICAL_ETH_RESERVE_RISK, getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchTextWithRetry,
  getAdapterTimeout,
  htmlLayoutChangedError,
  htmlParseError,
  requireHtmlInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromPercentages,
  unverifiedFreshnessMetadata,
} from "./helpers";
import { extractEscapedJsonArrayBetween } from "./html";

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

export function parseMentoReserveComposition(html: string): MentoReserveEntry[] {
  const escapedJson = extractEscapedJsonArrayBetween(
    html,
    RESERVE_COMPOSITION_START,
    RESERVE_COMPOSITION_END,
    "mento",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(escapedJson);
  } catch (e) {
    throw htmlParseError(
      "mento",
      `reserve composition JSON is malformed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw htmlLayoutChangedError("mento", "reserveComposition was not an array");
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
    warnings.push(reserveInfoWarning(
      "mento-low-entry-count",
      `Mento reserve composition has only ${entries.length} entries (expected >= 3)`,
    ));
  }

  const totalPct = entries.reduce((sum, e) => sum + e.percent, 0);
  const slices = slicesFromPercentages(
    entries.map((entry) => {
      const config = TOKEN_CONFIG[entry.symbol];
      if (!config) {
        warnings.push(reserveDegradedWarning("unknown-asset", `Unmapped Mento reserve symbol: ${entry.symbol}`));
      }
      const resolved = config ?? { name: entry.symbol, risk: "medium" as const };
      return {
        name: resolved.name,
        pct: entry.percent,
        risk: resolved.risk,
        ...(resolved.coinId ? { coinId: resolved.coinId } : {}),
      };
    }),
    { decimals: 1, context: "Mento reserve composition" },
  );

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      entryCount: entries.length,
      totalPct,
      ...unverifiedFreshnessMetadata(
        "nextjs-embedded-payload",
        "Mento reserve page embeds composition percentages without a trustworthy source timestamp",
      ),
    },
  };
}

export async function fetchMentoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "mento");
  const html = await fetchTextWithRetry(input.url, signal, getAdapterTimeout(config, 12_000), ctx);
  return adaptMentoReserveComposition(html);
}
