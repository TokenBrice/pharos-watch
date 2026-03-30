import type { ReserveSlice, StablecoinMeta } from "../types";

export const INHERITED_BLACKLIST_THRESHOLD_PCT = 50;
const MIN_SYMBOL_LENGTH_FOR_DETECTION = 3;

type ReserveBlacklistRisk = "direct" | "possible" | "none";

const DIRECT_BLACKLIST_TEXT_PATTERNS: readonly RegExp[] = [
  /\busdc\b/i,
  /\busdt\b/i,
  /\bpyusd\b/i,
  /\bfdusd\b/i,
  /\busd1\b/i,
  /\brlusd\b/i,
  /\bustb\b/i,
  /\busdtb\b/i,
  /\bbuidl\b/i,
  /\bousg\b/i,
  /\busyc\b/i,
  /\bbenji\b/i,
  /\bstatausdc\b/i,
  /\bstatausdt\b/i,
  /\bsyrup ?usdc\b/i,
  /\bsyrup ?usdt\b/i,
  /\bvbusdc\b/i,
  /\bvbusdt\b/i,
];

const POSSIBLE_BLACKLIST_TEXT_PATTERNS: readonly RegExp[] = [
  /\bdai\b/i,
  /\bsdai\b/i,
  /\bsusds?\b/i,
  /\bfrxusd\b/i,
  /\bsfrxusd\b/i,
  /\busde\b/i,
  /\bsusde\b/i,
  /\bcrvusd\b/i,
  /\busdt0\b/i,
  /\bfbtc\b/i,
  /\bcbbtc\b/i,
  /\bbtcb\b/i,
  /\blbtc\b/i,
  /\bpumpbtc\b/i,
  /\bapcxusdt\b/i,
  /\bstablecoins?\b/i,
  /\bstables\b/i,
  /\bpsm\b/i,
  /\bgsm\b/i,
];

const CUSTODY_BLACKLIST_TEXT_PATTERNS: readonly RegExp[] = [
  /binance/i,
  /bybit/i,
  /ceffu/i,
  /copper/i,
  /cobo/i,
  /cubo/i,
  /mirrorx/i,
  /coinbase prime/i,
  /prime broker/i,
  /off-exchange/i,
  /custod/i,
  /\bcex\b/i,
];

const BLACKLIST_BACKING_CONTEXT_PATTERN = /(mint|redeem|deposit|backed|convertib|1:1)/i;

function textMatchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function sliceTextSignalsDirectBlacklistRisk(text: string): boolean {
  return (
    textMatchesAny(text, DIRECT_BLACKLIST_TEXT_PATTERNS) ||
    textMatchesAny(text, CUSTODY_BLACKLIST_TEXT_PATTERNS)
  );
}

function sliceTextSignalsPossibleBlacklistRisk(text: string): boolean {
  return (
    sliceTextSignalsDirectBlacklistRisk(text) ||
    textMatchesAny(text, POSSIBLE_BLACKLIST_TEXT_PATTERNS)
  );
}

function metaTextSignalsPossibleBlacklistRisk(meta: StablecoinMeta): boolean {
  const text = `${meta.collateral ?? ""} ${meta.pegMechanism ?? ""}`;
  return (
    textMatchesAny(text, CUSTODY_BLACKLIST_TEXT_PATTERNS) ||
    (
      BLACKLIST_BACKING_CONTEXT_PATTERN.test(text) &&
      textMatchesAny(text, DIRECT_BLACKLIST_TEXT_PATTERNS)
    )
  );
}

function reserveSliceBlacklistRisk(
  slice: ReserveSlice,
  blacklistableIds?: ReadonlySet<string>,
): ReserveBlacklistRisk {
  if (slice.blacklistable === true) return "direct";
  if (slice.coinId !== undefined && blacklistableIds?.has(slice.coinId) === true) return "direct";
  if (sliceTextSignalsDirectBlacklistRisk(slice.name)) return "direct";
  if (sliceTextSignalsPossibleBlacklistRisk(slice.name)) return "possible";
  return "none";
}

export function enrichLiveSlicesForBlacklist(
  liveSlices: readonly ReserveSlice[],
  blacklistableIds: ReadonlySet<string>,
  trackedMetaById: ReadonlyMap<string, StablecoinMeta>,
): ReserveSlice[] {
  const blacklistableSymbols = new Map<string, string>();
  for (const coinId of blacklistableIds) {
    const meta = trackedMetaById.get(coinId);
    if (meta && meta.symbol.length >= MIN_SYMBOL_LENGTH_FOR_DETECTION) {
      blacklistableSymbols.set(meta.symbol.toLowerCase(), coinId);
    }
  }

  return liveSlices.map((slice) => {
    if (slice.blacklistable) return slice;
    if (slice.coinId && blacklistableIds.has(slice.coinId)) return { ...slice, blacklistable: true };
    if (sliceTextSignalsDirectBlacklistRisk(slice.name)) return { ...slice, blacklistable: true };

    const lowerName = slice.name.toLowerCase();
    for (const [symbol] of blacklistableSymbols) {
      if (lowerName.includes(symbol)) {
        return { ...slice, blacklistable: true };
      }
    }
    return slice;
  });
}

export function isBlacklistable(
  meta: StablecoinMeta,
  blacklistableIds?: ReadonlySet<string>,
  reserveSlices?: readonly ReserveSlice[],
): boolean | "possible" | "inherited" {
  if (meta.canBeBlacklisted !== undefined) return meta.canBeBlacklisted;
  if (meta.flags.governance === "centralized") return true;

  const effectiveReserves = reserveSlices ?? meta.reserves;
  if (effectiveReserves) {
    let directReservePct = 0;
    let possibleReservePct = 0;
    for (const slice of effectiveReserves) {
      const risk = reserveSliceBlacklistRisk(slice, blacklistableIds);
      if (risk === "direct") {
        directReservePct += slice.pct;
        continue;
      }
      if (risk === "possible") {
        possibleReservePct += slice.pct;
      }
    }
    if (directReservePct > INHERITED_BLACKLIST_THRESHOLD_PCT) return "inherited";
    if (directReservePct > 0 || possibleReservePct > 0) return "possible";
  }

  if (meta.custodyModel === "cex") return "possible";
  if (metaTextSignalsPossibleBlacklistRisk(meta)) return "possible";
  return false;
}
