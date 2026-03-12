import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchTextWithRetry, requireHtmlInput } from "./helpers";
import { buildReserveSlicesFromValues } from "./utils";

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
  CELO: { name: "CELO", risk: "high" },
  USDGLO: { name: "USDGLO (Glo Dollar)", risk: "low" },
  stETH: { name: "stETH (Lido staked ETH)", risk: "low" },
  USDT: { name: "USDT", risk: "low", coinId: "usdt-tether" },
  USDC: { name: "USDC", risk: "low", coinId: "usdc-circle" },
  ETH: { name: "ETH", risk: "very-low" },
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
  const parsed = JSON.parse(
    escapedJson
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\"),
  ) as unknown;
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

export function adaptMentoReserveComposition(html: string): ReserveSlice[] {
  const entries = parseMentoReserveComposition(html);
  return buildReserveSlicesFromValues(
    entries.map((entry) => {
      const config = TOKEN_CONFIG[entry.symbol] ?? { name: entry.symbol, risk: "medium" as const };
      return {
        name: config.name,
        value: entry.percent,
        risk: config.risk,
        ...(config.coinId ? { coinId: config.coinId } : {}),
      };
    }),
    1,
  );
}

export async function fetchMentoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "mento");
  const html = await fetchTextWithRetry(input.url, signal, 12_000);
  return {
    slices: adaptMentoReserveComposition(html),
  };
}
