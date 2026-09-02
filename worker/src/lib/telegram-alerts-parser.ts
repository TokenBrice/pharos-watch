import { WORKER_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  resolveTelegramPresetAlias,
  type TelegramPresetId,
} from "./telegram-presets";
import {
  isDepegStepValue,
  type DepegStepValue,
} from "./telegram-constants";
import { TELEGRAM_SUBSCRIBABLE_STABLECOINS } from "./telegram-subscription-eligibility";
import { isTelegramReservedTargetToken } from "@shared/lib/telegram-command-vocabulary";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status/telegram";

// ---------- Types ----------

export interface ResolvedCoin {
  id: string;
  symbol: string;
  name: string;
}

export interface TickerMatch {
  status: "unique" | "ambiguous" | "not_found";
  matches: ResolvedCoin[];
  /** For not_found: suggested ticker if a close match exists */
  suggestion?: ResolvedCoin;
}

export interface ParsedSubscribeArgs {
  alertTypes: Set<string>;
  subscribeAll: boolean;
  presetIds: TelegramPresetId[];
  tickers: string[];
  invalidTargets: string[];
  depegWorseningBpsStep?: 100 | 250 | 500 | null;
  invalidDepegWorseningBpsStep?: string;
}

export interface ParsedTargetArgs {
  includeAll: boolean;
  presetIds: TelegramPresetId[];
  tickers: string[];
  invalidTargets: string[];
}

export type TickerResolutionScope = "subscribable" | "tracked";

// ---------- Constants ----------

const ALERT_TYPES: ReadonlySet<string> = new Set(TELEGRAM_ALERT_TYPES);
const GLOBAL_SUBSCRIBE_TOKEN = "all";
const DEPEG_STEP_TOKEN = "depeg-step";

/**
 * Returns the closest candidate to `input` within Levenshtein distance 1
 * (case-insensitive), or null if no candidate qualifies. Comparison is on
 * lowercased strings; the original candidate string is returned unchanged.
 */
export function suggestClosestToken(input: string, candidates: readonly string[]): string | null {
  const needle = input.trim().toLowerCase();
  if (needle.length === 0) return null;
  let best: { value: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(needle, candidate.toLowerCase());
    if (distance > 1) continue;
    if (distance === 0) return candidate;
    if (!best || distance < best.distance) {
      best = { value: candidate, distance };
    }
  }
  return best?.value ?? null;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

// ---------- Ticker Resolution ----------

function buildSymbolIndex(coins: readonly typeof WORKER_TRACKED_STABLECOINS[number][]): Map<string, ResolvedCoin[]> {
  const map = new Map<string, ResolvedCoin[]>();
  for (const meta of coins) {
    const key = meta.symbol.toLowerCase();
    const coin: ResolvedCoin = { id: meta.id, symbol: meta.symbol, name: meta.name };
    const existing = map.get(key);
    if (existing) {
      existing.push(coin);
    } else {
      map.set(key, [coin]);
    }
  }
  return map;
}

function buildIdIndex(coins: readonly typeof WORKER_TRACKED_STABLECOINS[number][]): Map<string, ResolvedCoin> {
  return new Map(coins.map((meta) => [
    meta.id.toLowerCase(),
    { id: meta.id, symbol: meta.symbol, name: meta.name },
  ]));
}

/** Build lowercase symbol / id indexes once at module load. */
const SUBSCRIBABLE_SYMBOL_INDEX = buildSymbolIndex(TELEGRAM_SUBSCRIBABLE_STABLECOINS);
const SUBSCRIBABLE_ID_INDEX = buildIdIndex(TELEGRAM_SUBSCRIBABLE_STABLECOINS);
const TRACKED_SYMBOL_INDEX = buildSymbolIndex(WORKER_TRACKED_STABLECOINS);
const TRACKED_ID_INDEX = buildIdIndex(WORKER_TRACKED_STABLECOINS);

function indexesForScope(scope: TickerResolutionScope): {
  symbols: Map<string, ResolvedCoin[]>;
  ids: Map<string, ResolvedCoin>;
} {
  return scope === "tracked"
    ? { symbols: TRACKED_SYMBOL_INDEX, ids: TRACKED_ID_INDEX }
    : { symbols: SUBSCRIBABLE_SYMBOL_INDEX, ids: SUBSCRIBABLE_ID_INDEX };
}

/** Resolve a user-provided ticker to matching coin(s). Case-insensitive. */
export function resolveTicker(ticker: string, scope: TickerResolutionScope = "subscribable"): TickerMatch {
  const { symbols, ids } = indexesForScope(scope);
  const key = ticker.toLowerCase();
  const exactIdMatch = ids.get(key);
  if (exactIdMatch) {
    return { status: "unique", matches: [exactIdMatch] };
  }
  const matches = symbols.get(key);
  if (matches && matches.length === 1) {
    return { status: "unique", matches };
  }
  if (matches && matches.length > 1) {
    return { status: "ambiguous", matches };
  }
  // Not found — try prefix match for suggestion
  const suggestion = findClosestMatch(key, symbols);
  return { status: "not_found", matches: [], suggestion: suggestion ?? undefined };
}

/** Find a coin whose symbol starts with the given prefix, or null. */
function findClosestMatch(lowerTicker: string, symbols: Map<string, ResolvedCoin[]>): ResolvedCoin | null {
  for (const [key, coins] of symbols) {
    if (key.startsWith(lowerTicker) || lowerTicker.startsWith(key)) {
      return coins[0];
    }
  }
  return null;
}

// ---------- Command Parsing ----------

/**
 * Parse target tokens shared by subscribe/unsubscribe flows.
 */
export function parseTargetArgs(
  argsText: string,
  options: { resolutionScope?: TickerResolutionScope } = {},
): ParsedTargetArgs {
  const { symbols, ids } = indexesForScope(options.resolutionScope ?? "subscribable");
  const tokens = argsText.trim().split(/[\s,]+/).filter(Boolean);
  let includeAll = false;
  const presetIds: TelegramPresetId[] = [];
  const tickers: string[] = [];
  const invalidTargets: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const presetId = resolveTelegramPresetAlias(lower);
    if (lower === GLOBAL_SUBSCRIBE_TOKEN) {
      includeAll = true;
    } else if (presetId) {
      presetIds.push(presetId);
    } else if (isTelegramReservedTargetToken(lower)) {
      invalidTargets.push(token);
    } else if (symbols.has(lower) || ids.has(lower)) {
      tickers.push(token);
    } else {
      invalidTargets.push(token);
    }
  }

  return { includeAll, presetIds, tickers, invalidTargets };
}

/**
 * Parse `/subscribe` arguments. Alert types are extracted first, then the remaining
 * tokens are parsed as target selectors (tickers, presets, or `all`).
 */
export function parseSubscribeArgs(argsText: string): ParsedSubscribeArgs {
  const tokens = argsText.trim().split(/[\s,]+/).filter(Boolean);
  const alertTypes = new Set<string>();
  const targetTokens: string[] = [];
  let depegWorseningBpsStep: ParsedSubscribeArgs["depegWorseningBpsStep"];
  let invalidDepegWorseningBpsStep: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (ALERT_TYPES.has(lower)) {
      alertTypes.add(lower);
    } else if (lower === DEPEG_STEP_TOKEN) {
      alertTypes.add("depeg");
      const rawStep = tokens[i + 1];
      if (rawStep == null) {
        invalidDepegWorseningBpsStep = "";
      } else {
        const parsedStep = parseDepegWorseningStep(rawStep);
        if (parsedStep.valid) {
          depegWorseningBpsStep = parsedStep.value;
          i += 1;
        } else {
          invalidDepegWorseningBpsStep = rawStep;
          i += 1;
        }
      }
    } else {
      targetTokens.push(token);
    }
  }

  const parsedTargets = parseTargetArgs(targetTokens.join(" "));
  return {
    alertTypes,
    subscribeAll: parsedTargets.includeAll,
    presetIds: parsedTargets.presetIds,
    tickers: parsedTargets.tickers,
    invalidTargets: parsedTargets.invalidTargets,
    depegWorseningBpsStep,
    invalidDepegWorseningBpsStep,
  };
}

function parseDepegWorseningStep(value: string): { valid: true; value: DepegStepValue | null } | { valid: false } {
  const normalized = value.toLowerCase();
  if (normalized === "off") {
    return { valid: true, value: null };
  }
  const step = Number(normalized);
  if (isDepegStepValue(step)) {
    return { valid: true, value: step };
  }
  return { valid: false };
}

/**
 * Validate parsed subscribe args. Returns an error message string if invalid, or null if valid.
 * Checks invalidTargets first - contextual error message depends on whether alert types were provided.
 */
export function validateSubscribeArgs(parsed: ParsedSubscribeArgs): string | null {
  if (parsed.invalidDepegWorseningBpsStep != null) {
    return "Depeg-step values: off, 100, 250, 500";
  }
  if (parsed.invalidTargets.length > 0) {
    const unknown = parsed.invalidTargets.join(", ");
    if (parsed.alertTypes.size === 0) {
      const suggestion =
        parsed.invalidTargets.length === 1
          ? suggestClosestToken(parsed.invalidTargets[0], ["dews", "depeg", "safety", "launch", "reserve", "freeze"])
          : null;
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
      return `Unknown alert type: ${unknown}.${hint} Valid types: dews, depeg, safety, launch, reserve, freeze.`;
    }
    return `Unknown ticker or preset: ${unknown}. Check spelling, use the coin's symbol, or try /presets.`;
  }
  if (parsed.subscribeAll && (parsed.tickers.length > 0 || parsed.presetIds.length > 0)) {
    return 'Use either "all" or specific tickers/presets in one command, not both.';
  }
  if (parsed.presetIds.length > 0 && parsed.alertTypes.has("launch")) {
    return "Preset watchlists support dews, depeg, and safety only. Use explicit tickers for launch alerts.";
  }
  if (parsed.presetIds.length > 0 && parsed.alertTypes.has("reserve")) {
    return "Preset watchlists support dews, depeg, and safety only. Use explicit tickers for reserve alerts.";
  }
  if (parsed.presetIds.length > 0 && parsed.alertTypes.has("freeze")) {
    return "Preset watchlists do not include freeze alerts. Use explicit tickers for freeze alerts.";
  }
  if (
    parsed.alertTypes.size === 0
    && parsed.tickers.length === 0
    && parsed.presetIds.length === 0
    && !parsed.subscribeAll
  ) {
    return "Specify alert types and tickers or presets. Example: /subscribe dews USDC BOLD";
  }
  if (parsed.alertTypes.size === 0) {
    return "Specify at least one alert type: dews, depeg, safety, launch, reserve, freeze. Example: /subscribe freeze USDC";
  }
  if (parsed.tickers.length === 0 && parsed.presetIds.length === 0 && !parsed.subscribeAll) {
    return "Specify at least one ticker or preset, or use all. Example: /subscribe dews all";
  }
  return null;
}

/** Parse a disambiguation reply (e.g. "1", "1,2", "1, 3"). Returns selected indices (0-based). */
export function parseDisambiguationReply(text: string, candidateCount: number): number[] | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  const indices: number[] = [];
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 1 || n > candidateCount) return null;
    indices.push(n - 1);
  }
  return indices.length > 0 ? indices : null;
}

export function findInvalidDisambiguationToken(text: string, candidateCount: number): string | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 0) return "";
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return part;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > candidateCount) return part;
  }
  return null;
}
