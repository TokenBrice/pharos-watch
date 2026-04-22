import { CENTRALIZED_CUSTODY_CRYPTO } from "./centralized-custody";
import type { ReserveSlice, StablecoinMeta } from "../types";

export type BlacklistStatus = boolean | "possible" | "inherited";
const MIN_SYMBOL_LENGTH_FOR_DETECTION = 3;
const SYMBOL_MATCHER_PREFIX_GROUP = "(?:s|stata|vb|syrup\\s*)?";
const SYMBOL_MATCHER_SUFFIX_GROUP = "(?:0)?";

type ReserveBlacklistRisk = "direct" | "possible" | "none";

interface BlacklistSymbolMatcher {
  coinId: string;
  symbol: string;
  pattern: RegExp;
}

export interface BlacklistResolutionContext {
  blacklistableIds: ReadonlySet<string>;
  symbolMatchers: readonly BlacklistSymbolMatcher[];
  trackedMetaById?: ReadonlyMap<string, StablecoinMeta>;
}

export interface ResolveBlacklistStatusOptions {
  context?: BlacklistResolutionContext;
  reserveSlices?: readonly ReserveSlice[];
}

export interface ResolveBlacklistStatusesOptions {
  reserveSlicesById?: ReadonlyMap<string, readonly ReserveSlice[]>;
  trackedMetaById?: ReadonlyMap<string, StablecoinMeta>;
}

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

const DIRECT_COLLATERAL_BLACKLIST_SYMBOLS = [
  ...CENTRALIZED_CUSTODY_CRYPTO,
  "PAXG",
  "XAUT",
  "AAPLX",
  "BOSS",
  "DQTS",
  "ESC",
  "GOOGLX",
  "LENDS",
  "NVDAX",
  "REALU",
  "SPYON",
  "TSLAX",
] as const;

const DIRECT_COLLATERAL_BLACKLIST_PATTERNS = DIRECT_COLLATERAL_BLACKLIST_SYMBOLS.map((symbol) =>
  buildBlacklistableSymbolPattern(symbol),
);

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildBlacklistableSymbolPattern(symbol: string): RegExp {
  const escaped = escapeRegExp(symbol.toLowerCase());
  // eslint-disable-next-line security/detect-non-literal-regexp -- symbol is escaped before interpolation
  return new RegExp(
    `(?:^|[^a-z0-9])${SYMBOL_MATCHER_PREFIX_GROUP}${escaped}${SYMBOL_MATCHER_SUFFIX_GROUP}(?=$|[^a-z0-9])`,
    "i",
  );
}

function sliceTextSignalsDirectBlacklistRisk(text: string): boolean {
  return (
    textMatchesAny(text, DIRECT_BLACKLIST_TEXT_PATTERNS) ||
    DIRECT_COLLATERAL_BLACKLIST_PATTERNS.some((pattern) => pattern.test(text)) ||
    textMatchesAny(text, CUSTODY_BLACKLIST_TEXT_PATTERNS)
  );
}

function textSignalsKnownBlacklistableSymbol(text: string, context?: BlacklistResolutionContext): boolean {
  if (!context) return false;
  return context.symbolMatchers.some(({ pattern }) => pattern.test(text));
}

function sliceTextSignalsPossibleBlacklistRisk(text: string): boolean {
  return sliceTextSignalsDirectBlacklistRisk(text) || textMatchesAny(text, POSSIBLE_BLACKLIST_TEXT_PATTERNS);
}

function metaTextSignalsPossibleBlacklistRisk(meta: StablecoinMeta, context?: BlacklistResolutionContext): boolean {
  const text = `${meta.collateral ?? ""} ${meta.pegMechanism ?? ""}`;
  return (
    textMatchesAny(text, CUSTODY_BLACKLIST_TEXT_PATTERNS) ||
    (BLACKLIST_BACKING_CONTEXT_PATTERN.test(text) &&
      (textMatchesAny(text, DIRECT_BLACKLIST_TEXT_PATTERNS) ||
        DIRECT_COLLATERAL_BLACKLIST_PATTERNS.some((pattern) => pattern.test(text)) ||
        textSignalsKnownBlacklistableSymbol(text, context)))
  );
}

function reserveSliceBlacklistRisk(slice: ReserveSlice, context?: BlacklistResolutionContext): ReserveBlacklistRisk {
  if (slice.blacklistable === true) return "direct";
  if (slice.coinId !== undefined && context?.blacklistableIds.has(slice.coinId) === true) return "direct";
  if (sliceTextSignalsDirectBlacklistRisk(slice.name)) return "direct";
  if (textSignalsKnownBlacklistableSymbol(slice.name, context)) return "direct";
  if (sliceTextSignalsPossibleBlacklistRisk(slice.name)) return "possible";
  return "none";
}

export function createBlacklistResolutionContext(
  blacklistableIds: ReadonlySet<string>,
  trackedMetaById: ReadonlyMap<string, StablecoinMeta>,
): BlacklistResolutionContext {
  const symbolMatchers: BlacklistSymbolMatcher[] = [];
  for (const coinId of blacklistableIds) {
    const meta = trackedMetaById.get(coinId);
    if (meta && meta.symbol.length >= MIN_SYMBOL_LENGTH_FOR_DETECTION) {
      symbolMatchers.push({
        coinId,
        symbol: meta.symbol,
        pattern: buildBlacklistableSymbolPattern(meta.symbol),
      });
    }
  }
  return {
    blacklistableIds,
    symbolMatchers,
    trackedMetaById,
  };
}

function enrichReserveSlicesForBlacklist(
  reserveSlices: readonly ReserveSlice[],
  context: BlacklistResolutionContext,
): ReserveSlice[] {
  return reserveSlices.map((slice) => {
    const risk = reserveSliceBlacklistRisk(slice, context);
    if (risk !== "direct" || slice.blacklistable) return slice;
    return { ...slice, blacklistable: true };
  });
}

export function enrichLiveSlicesForBlacklist(
  liveSlices: readonly ReserveSlice[],
  blacklistableIds: ReadonlySet<string>,
  trackedMetaById: ReadonlyMap<string, StablecoinMeta>,
): ReserveSlice[] {
  return enrichReserveSlicesForBlacklist(
    liveSlices,
    createBlacklistResolutionContext(blacklistableIds, trackedMetaById),
  );
}

export function getBlacklistStatusLabel(status: BlacklistStatus): "Yes" | "Possible" | "Upstream" | "No" {
  if (status === true) return "Yes";
  if (status === "possible") return "Possible";
  if (status === "inherited") return "Upstream";
  return "No";
}

export function resolveBlacklistStatus(
  meta: StablecoinMeta,
  options: ResolveBlacklistStatusOptions = {},
): BlacklistStatus {
  if (meta.canBeBlacklisted !== undefined) return meta.canBeBlacklisted;
  if (meta.flags.governance === "centralized") return true;

  // Tracked parent variants inherit their parent's freeze surface: a sUSDS or
  // sDAI holder's exposure to issuer-side freeze flows through the parent, so
  // resolve the parent's status rather than relying on reserve/text inference.
  if (meta.variantOf && options.context) {
    if (options.context.blacklistableIds.has(meta.variantOf)) {
      return "inherited";
    }
    const parentMeta = options.context.trackedMetaById?.get(meta.variantOf);
    if (parentMeta) {
      const parentStatus = resolveBlacklistStatus(parentMeta, options);
      if (parentStatus === true || parentStatus === "inherited") return "inherited";
      if (parentStatus === "possible") return "possible";
    }
  }

  const effectiveReserves = options.reserveSlices ?? meta.reserves;
  const enrichedReserves =
    effectiveReserves && options.context
      ? enrichReserveSlicesForBlacklist(effectiveReserves, options.context)
      : effectiveReserves;

  if (enrichedReserves) {
    let directReservePct = 0;
    let possibleReservePct = 0;
    for (const slice of enrichedReserves) {
      const risk = reserveSliceBlacklistRisk(slice, options.context);
      if (risk === "direct") {
        directReservePct += slice.pct;
        continue;
      }
      if (risk === "possible") {
        possibleReservePct += slice.pct;
      }
    }
    if (directReservePct > 0 || possibleReservePct > 0) return "inherited";
  }

  if (meta.custodyModel === "cex") return "inherited";
  if (metaTextSignalsPossibleBlacklistRisk(meta, options.context)) return "inherited";
  return false;
}

export function isBlacklistable(
  meta: StablecoinMeta,
  blacklistableIds?: ReadonlySet<string>,
  reserveSlices?: readonly ReserveSlice[],
): BlacklistStatus {
  const context = blacklistableIds
    ? {
        blacklistableIds,
        symbolMatchers: [],
      }
    : undefined;
  return resolveBlacklistStatus(meta, { context, reserveSlices });
}
