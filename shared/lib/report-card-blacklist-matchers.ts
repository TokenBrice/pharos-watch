import { CENTRALIZED_CUSTODY_CRYPTO } from "./centralized-custody";
import type { ReserveSlice, StablecoinMeta } from "../types";
import { buildDelimitedSymbolPattern } from "./reserve-symbol-matchers";

export type BlacklistStatus = boolean | "possible" | "inherited";
type ReserveBlacklistExposureStatus = BlacklistStatus | "unknown";

const UPSTREAM_BLACKLISTABILITY_EXPOSURE_THRESHOLD_PCT = 50;
const UPSTREAM_BLACKLISTABILITY_EXPOSURE_EPSILON_PCT = 1e-9;
const MIN_SYMBOL_LENGTH_FOR_DETECTION = 3;
const SYMBOL_MATCHER_PREFIX_GROUP = "(?:s|stata|vb|syrup\\s*)?";
const SYMBOL_MATCHER_SUFFIX_GROUP = "(?:0)?";

interface BlacklistSymbolMatcher {
  coinId: string;
  symbol: string;
  status: BlacklistStatus;
  pattern: RegExp;
}

export interface BlacklistResolutionContext {
  blacklistableIds: ReadonlySet<string>;
  statusesById: ReadonlyMap<string, BlacklistStatus>;
  symbolMatchers: readonly BlacklistSymbolMatcher[];
  trackedMetaById?: ReadonlyMap<string, StablecoinMeta>;
}

export interface ResolveBlacklistStatusOptions {
  context?: BlacklistResolutionContext;
  reserveSlices?: readonly ReserveSlice[];
  reserveSlicesById?: ReadonlyMap<string, readonly ReserveSlice[]>;
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
  /\bpsms?\b/i,
  /\bgsms?\b/i,
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

function buildBlacklistableSymbolPattern(symbol: string): RegExp {
  return buildDelimitedSymbolPattern(symbol.toLowerCase(), {
    prefixPattern: SYMBOL_MATCHER_PREFIX_GROUP,
    suffixPattern: SYMBOL_MATCHER_SUFFIX_GROUP,
  });
}

function sliceTextSignalsDirectBlacklistRisk(text: string): boolean {
  return (
    textMatchesAny(text, DIRECT_BLACKLIST_TEXT_PATTERNS) ||
    DIRECT_COLLATERAL_BLACKLIST_PATTERNS.some((pattern) => pattern.test(text)) ||
    textMatchesAny(text, CUSTODY_BLACKLIST_TEXT_PATTERNS)
  );
}

function strongerBlacklistStatus(left: BlacklistStatus, right: BlacklistStatus): BlacklistStatus {
  const rank = (status: BlacklistStatus) => {
    if (status === true) return 3;
    if (status === "inherited") return 2;
    if (status === "possible") return 1;
    return 0;
  };

  return rank(left) >= rank(right) ? left : right;
}

function isCountedUpstreamBlacklistExposure(
  status: ReserveBlacklistExposureStatus | null | undefined,
): boolean {
  return status === true || status === "inherited" || status === "possible";
}

function exceedsUpstreamBlacklistExposureThreshold(pct: number): boolean {
  return pct - UPSTREAM_BLACKLISTABILITY_EXPOSURE_THRESHOLD_PCT > UPSTREAM_BLACKLISTABILITY_EXPOSURE_EPSILON_PCT;
}

function mapReserveBlacklistabilityExposure(
  exposure: ReserveSlice["blacklistabilityExposure"],
): ReserveBlacklistExposureStatus | null {
  if (exposure === "yes") return true;
  if (exposure === "upstream") return "inherited";
  if (exposure === "possible") return "possible";
  if (exposure === "no") return false;
  if (exposure === "unknown") return "unknown";
  return null;
}

function matchKnownBlacklistableSymbolStatus(
  text: string,
  context?: BlacklistResolutionContext,
  excludedCoinId?: string,
): BlacklistStatus | null {
  if (!context) return null;

  let status: BlacklistStatus | null = null;
  for (const matcher of context.symbolMatchers) {
    if (matcher.coinId === excludedCoinId) continue;
    if (!matcher.pattern.test(text)) continue;
    status = status === null ? matcher.status : strongerBlacklistStatus(status, matcher.status);
  }
  return status;
}

function textSignalsKnownBlacklistableSymbol(text: string, context?: BlacklistResolutionContext): boolean {
  return matchKnownBlacklistableSymbolStatus(text, context) !== null;
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

function reserveSliceBlacklistExposureStatus(
  slice: ReserveSlice,
  context?: BlacklistResolutionContext,
  excludedCoinId?: string,
): ReserveBlacklistExposureStatus {
  const explicitExposure = mapReserveBlacklistabilityExposure(slice.blacklistabilityExposure);
  if (explicitExposure !== null) return explicitExposure;

  if (slice.blacklistable === true) return true;
  if (slice.coinId !== undefined) {
    if (slice.coinId === excludedCoinId) return false;
    const linkedStatus = context?.statusesById.get(slice.coinId);
    if (linkedStatus !== undefined) return linkedStatus;
    if (context?.blacklistableIds.has(slice.coinId) === true) return true;
  }
  if (sliceTextSignalsDirectBlacklistRisk(slice.name)) return true;
  const symbolStatus = matchKnownBlacklistableSymbolStatus(slice.name, context, excludedCoinId);
  if (symbolStatus !== null) return symbolStatus;
  if (sliceTextSignalsPossibleBlacklistRisk(slice.name)) return "possible";
  return false;
}

export function getReserveBlacklistabilityExposurePct(
  reserveSlices: readonly ReserveSlice[],
  context?: BlacklistResolutionContext,
  excludedCoinId?: string,
): number {
  return reserveSlices.reduce((total, slice) => {
    const status = reserveSliceBlacklistExposureStatus(slice, context, excludedCoinId);
    return isCountedUpstreamBlacklistExposure(status) ? total + slice.pct : total;
  }, 0);
}

export function createBlacklistResolutionContext(
  blacklistableIds: ReadonlySet<string>,
  trackedMetaById: ReadonlyMap<string, StablecoinMeta>,
  statusesById: ReadonlyMap<string, BlacklistStatus> = new Map(
    [...blacklistableIds].map((coinId) => [coinId, true] as const),
  ),
): BlacklistResolutionContext {
  const resolvedStatusesById = new Map(statusesById);
  for (const coinId of blacklistableIds) {
    if (!resolvedStatusesById.has(coinId)) {
      resolvedStatusesById.set(coinId, true);
    }
  }

  const symbolMatchers: BlacklistSymbolMatcher[] = [];
  for (const [coinId, status] of resolvedStatusesById) {
    if (!isCountedUpstreamBlacklistExposure(status)) continue;
    const meta = trackedMetaById.get(coinId);
    if (meta && meta.symbol.length >= MIN_SYMBOL_LENGTH_FOR_DETECTION) {
      symbolMatchers.push({
        coinId,
        symbol: meta.symbol,
        status,
        pattern: buildBlacklistableSymbolPattern(meta.symbol),
      });
    }
  }
  return {
    blacklistableIds,
    statusesById: resolvedStatusesById,
    symbolMatchers,
    trackedMetaById,
  };
}

function enrichReserveSlicesForBlacklist(
  reserveSlices: readonly ReserveSlice[],
  context: BlacklistResolutionContext,
): ReserveSlice[] {
  return reserveSlices.map((slice) => {
    const status = reserveSliceBlacklistExposureStatus(slice, context);
    if (status !== true || slice.blacklistable) return slice;
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

export function getBlacklistStatusLabel(
  status: BlacklistStatus,
): "Yes" | "Possible" | "Upstream" | "No" {
  if (status === true) return "Yes";
  if (status === "possible") return "Possible";
  if (status === "inherited") return "Upstream";
  return "No";
}

export function resolveBlacklistStatus(
  meta: StablecoinMeta,
  options: ResolveBlacklistStatusOptions = {},
): BlacklistStatus {
  const directStatus = resolveDirectBlacklistStatus(meta);
  if (directStatus === true) return true;
  if (directStatus === "possible") return "possible";

  const inferredStatus = resolveBlacklistStatusWithoutExplicitOverride(meta, options);
  if (inferredStatus === "inherited") {
    if (directStatus === false && meta.blacklistabilityReview?.upstreamSuppressionRationale) {
      return false;
    }
    return "inherited";
  }
  if (directStatus === false) return false;

  return inferredStatus;
}

function resolveDirectBlacklistStatus(meta: StablecoinMeta): BlacklistStatus | null {
  if (meta.canBeBlacklisted !== undefined) return meta.canBeBlacklisted;

  const reviewedStatus = meta.blacklistabilityReview?.reviewedStatus;
  if (reviewedStatus === true || reviewedStatus === false || reviewedStatus === "possible") {
    return reviewedStatus;
  }
  if (reviewedStatus === "inherited") {
    return null;
  }

  if (meta.flags.governance === "centralized") return true;

  return null;
}

function resolveBlacklistStatusWithoutExplicitOverride(
  meta: StablecoinMeta,
  options: ResolveBlacklistStatusOptions = {},
): BlacklistStatus {
  // Tracked parent variants inherit their parent's freeze surface: a sUSDS or
  // sDAI holder's exposure to issuer-side freeze flows through the parent, so
  // resolve the parent's status rather than relying on reserve/text inference.
  if (meta.variantOf && options.context) {
    const resolvedParentStatus = options.context.statusesById.get(meta.variantOf);
    if (isCountedUpstreamBlacklistExposure(resolvedParentStatus)) {
      return "inherited";
    }
    const parentMeta = options.context.trackedMetaById?.get(meta.variantOf);
    if (parentMeta) {
      const parentStatus = resolveBlacklistStatus(parentMeta, {
        ...options,
        reserveSlices: options.reserveSlicesById?.get(parentMeta.id),
      });
      if (isCountedUpstreamBlacklistExposure(parentStatus)) return "inherited";
    }
  }

  const effectiveReserves = options.reserveSlices ?? meta.reserves;
  if (effectiveReserves) {
    const upstreamExposurePct = getReserveBlacklistabilityExposurePct(effectiveReserves, options.context, meta.id);
    if (exceedsUpstreamBlacklistExposureThreshold(upstreamExposurePct)) return "inherited";
  }

  if (meta.custodyModel === "cex") return "inherited";
  if (
    (!effectiveReserves || effectiveReserves.length === 0) &&
    metaTextSignalsPossibleBlacklistRisk(meta, options.context)
  ) {
    return "inherited";
  }
  return false;
}

export function isBlacklistable(
  meta: StablecoinMeta,
  blacklistableIds?: ReadonlySet<string>,
  reserveSlices?: readonly ReserveSlice[],
): BlacklistStatus {
  const context = blacklistableIds
    ? createBlacklistResolutionContext(
        blacklistableIds,
        // Single-coin callers only pass ids, not the tracked metadata required
        // to build symbol matchers. Bulk resolution supplies the full context.
        new Map(),
      )
    : undefined;
  return resolveBlacklistStatus(meta, { context, reserveSlices });
}

function getCountedBlacklistableIds(statuses: ReadonlyMap<string, BlacklistStatus>): Set<string> {
  return new Set(
    [...statuses.entries()]
      .filter(([, status]) => isCountedUpstreamBlacklistExposure(status))
      .map(([coinId]) => coinId),
  );
}

function seedDirectBlacklistStatuses(metas: readonly StablecoinMeta[]): Map<string, BlacklistStatus> {
  const statuses = new Map<string, BlacklistStatus>();
  for (const meta of metas) {
    const status = resolveDirectBlacklistStatus(meta);
    if (status !== null) {
      statuses.set(meta.id, status);
    }
  }
  return statuses;
}

function blacklistStatusesEqual(
  left: ReadonlyMap<string, BlacklistStatus>,
  right: ReadonlyMap<string, BlacklistStatus>,
  metas: readonly StablecoinMeta[],
): boolean {
  for (const meta of metas) {
    if (left.get(meta.id) !== right.get(meta.id)) {
      return false;
    }
  }
  return true;
}

export function resolveBlacklistStatuses(
  metas: readonly StablecoinMeta[],
  options: ResolveBlacklistStatusesOptions = {},
): Map<string, BlacklistStatus> {
  const trackedMetaById = options.trackedMetaById ?? new Map(
    metas.map((meta) => [meta.id, meta] as const),
  );
  const reserveSlicesById = options.reserveSlicesById;
  const maxIterations = metas.length + 1;
  let statuses = seedDirectBlacklistStatuses(metas);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const blacklistableIds = getCountedBlacklistableIds(statuses);
    const context = createBlacklistResolutionContext(blacklistableIds, trackedMetaById, statuses);
    const nextStatuses = new Map<string, BlacklistStatus>();

    for (const meta of metas) {
      const status = resolveBlacklistStatus(meta, {
        context,
        reserveSlices: reserveSlicesById?.get(meta.id),
        reserveSlicesById,
      });
      nextStatuses.set(meta.id, status);
    }

    if (blacklistStatusesEqual(statuses, nextStatuses, metas)) {
      return nextStatuses;
    }
    statuses = nextStatuses;
  }

  throw new Error("Blacklist status resolution did not converge");
}
