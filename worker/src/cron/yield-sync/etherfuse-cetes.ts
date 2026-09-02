import { logWorkerEventArgs } from "../../lib/structured-log";
import {
  ETHERFUSE_CETES_BOND_PAGE_URL,
  USER_AGENT,
} from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { parseEpochSeconds } from "@shared/lib/epoch";
import { isRecord } from "@shared/lib/type-guards";

const ETHERFUSE_CETES_BENCHMARK_SOURCE = "etherfuse-cetes-current-issuance";
export const ETHERFUSE_CETES_SOURCE_KEY = `protocol-api:${ETHERFUSE_CETES_BENCHMARK_SOURCE}`;
export const ETHERFUSE_CETES_SOURCE_LABEL = "Etherfuse CETES current issuance";
export const ETHERFUSE_CETES_SOURCE_TYPE = "nav-appreciation";

const DEFAULT_ETHERFUSE_TIMEOUT_MS = 8_000;
const ETHERFUSE_CETES_MIN_APY_PERCENT = 0;
const ETHERFUSE_CETES_MAX_APY_PERCENT = 20;

export interface EtherfuseCetesIssuance {
  apyPercent: number;
  recordDate: string;
  observedAtSec: number | null;
  startSec: number | null;
  endSec: number | null;
  issuanceAddress: string | null;
  issuanceNumber: number | null;
  startingTokenAmount: number | null;
  endingTokenAmount: number | null;
  currentTokenAmount: number | null;
}

// Intentionally uses parseFloat (not the shared toFiniteNumber, which uses
// Number()): the Etherfuse CETES API returns numeric fields with trailing units
// or whitespace that Number() would reject as NaN but parseFloat tolerates.
function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUnixTimestampSec(value: unknown): number | null {
  const parsed = parseFiniteNumber(value);
  if (parsed == null) return null;
  return parseEpochSeconds(parsed, {
    numericTextPolicy: "any",
    millisecondsThreshold: 10_000_000_000,
    millisecondsThresholdInclusive: false,
    floor: true,
    minExclusive: 946_684_800,
  });
}

function parseIsoTimestampSec(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return Math.floor(millis / 1000);
}

function isoDateFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function extractNextDataJson(html: string): string | null {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  return match?.[1] ?? null;
}

function parseCurrentIssuanceRate(issuance: Record<string, unknown>): number | null {
  const interestRateBps = parseFiniteNumber(issuance.interestRateBps);
  if (interestRateBps == null) return null;
  const apyPercent = interestRateBps / 100;
  if (
    apyPercent < ETHERFUSE_CETES_MIN_APY_PERCENT ||
    apyPercent > ETHERFUSE_CETES_MAX_APY_PERCENT
  ) {
    return null;
  }
  return apyPercent;
}

export function parseEtherfuseCetesStablebondPage(html: string): EtherfuseCetesIssuance | null {
  const json = extractNextDataJson(html);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isRecord(parsed)) return null;
    const props = isRecord(parsed.props) ? parsed.props : null;
    const pageProps = props && isRecord(props.pageProps) ? props.pageProps : null;
    if (!pageProps || !Array.isArray(pageProps.cachedBonds)) return null;

    const stablebondsLookup = isRecord(pageProps.cachedStablebondsLookup)
      ? pageProps.cachedStablebondsLookup
      : null;
    const calculatedAtSec = parseIsoTimestampSec(stablebondsLookup?.calculatedAt);

    for (const rawBond of pageProps.cachedBonds) {
      if (!isRecord(rawBond)) continue;
      const mint = isRecord(rawBond.mint) ? rawBond.mint : null;
      const symbol = typeof mint?.symbol === "string" ? mint.symbol.toUpperCase() : null;
      if (symbol !== "CETES") continue;

      const issuance = isRecord(rawBond.currentIssuance) ? rawBond.currentIssuance : null;
      if (!issuance) return null;

      const apyPercent = parseCurrentIssuanceRate(issuance);
      if (apyPercent == null) return null;

      const startSec = parseUnixTimestampSec(issuance.startDate);
      const endSec = parseUnixTimestampSec(issuance.endDate);
      const recordDateSec = startSec ?? calculatedAtSec;
      if (recordDateSec == null) return null;

      return {
        apyPercent,
        recordDate: isoDateFromSec(recordDateSec),
        observedAtSec: calculatedAtSec ?? startSec,
        startSec,
        endSec,
        issuanceAddress: typeof issuance.address === "string" ? issuance.address : null,
        issuanceNumber: parseFiniteNumber(rawBond.issuanceNumber),
        startingTokenAmount: parseFiniteNumber(issuance.startingTokenAmount),
        endingTokenAmount: parseFiniteNumber(issuance.endingTokenAmount),
        currentTokenAmount: parseFiniteNumber(mint?.currentTokenAmount),
      };
    }
  } catch {
    return null;
  }

  return null;
}

export async function fetchEtherfuseCetesIssuance(params: {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
} = {}): Promise<EtherfuseCetesIssuance | null> {
  const { signal, timeoutMs = DEFAULT_ETHERFUSE_TIMEOUT_MS, retries = 0 } = params;

  try {
    const result = await fetchTextWithRetry(
      ETHERFUSE_CETES_BOND_PAGE_URL,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": USER_AGENT,
        },
        signal,
      },
      retries,
      { timeoutMs },
    );
    if (!result?.response.ok) return null;

    return parseEtherfuseCetesStablebondPage(result.body);
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    logWorkerEventArgs("handler", "warn", "[yield] Etherfuse CETES source failed:", error);
    return null;
  }
}
