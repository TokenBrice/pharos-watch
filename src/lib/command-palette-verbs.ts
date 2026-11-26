/**
 * Command palette verb parser.
 *
 * Recognises a small set of leading-keyword verbs that turn the palette from
 * a search field into an action surface (see Council IDEA-3). The parser is
 * conservative — only fires when the input starts with one of the verb
 * keywords followed by a space — so plain search remains the default.
 *
 *   compare TOKEN [TOKEN ...]     → /compare?coins=<ids> (static pair page when curated)
 *   "<a> vs <b>"                  → compare verb without the keyword
 *   screen filter=value [...]     → /screener?<encoded>
 *   pin TOKEN                     → mutates watchlist (add)
 *   unpin TOKEN | all             → mutates watchlist (remove or clear)
 *   tape: filters                 → /timeline?<encoded>
 */

import { COMMAND_PALETTE_STABLECOINS } from "@/lib/command-palette-search-data";
import { MAX_COMPARE_COINS } from "@/lib/compare-config";
import { buildLiveCompareUrl, buildStaticComparisonSlug, STATIC_COMPARE_PAIRS } from "@/lib/compare-links";
import { mergeCoinsParam } from "@/lib/portfolio-codec";
import { decodeState, encodeState } from "@/lib/url-state";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { isBlacklistTrackedStablecoinId } from "@shared/lib/blacklist-contract-specs";
import {
  SCREENER_URL_SCHEMA,
  type ScreenerFilters,
} from "@/lib/screener-filters";

export type CommandPaletteDossierSectionKey = "reserves" | "liquidity" | "history" | "freeze" | "overview";

export type ParsedVerb =
  | { kind: "compare"; coinSymbols: string[]; resolvedCoinIds: string[]; unresolved: string[]; href: string }
  | { kind: "portfolio"; coinSymbols: string[]; resolvedCoinIds: string[]; unresolved: string[]; href: string }
  | {
      kind: "section";
      sectionKey: CommandPaletteDossierSectionKey;
      sectionLabel: string;
      coinQuery: string;
      resolvedCoinId: string | null;
      resolvedCoinName: string | null;
      resolvedCoinSymbol: string | null;
      hash: string;
      href: string;
    }
  | { kind: "screen"; filters: Record<string, string | string[] | number>; href: string; error?: string }
  | { kind: "pin"; coinSymbol: string; resolvedCoinId: string | null }
  | { kind: "unpin"; coinSymbol: string | "all"; resolvedCoinId: string | null }
  | { kind: "tape"; filters: Record<string, string>; href: string }
  | { kind: "none" };

/**
 * Fuzzy resolve a token (symbol/name/id) to a coin id from the static palette
 * registry. Case-insensitive. Returns null when nothing matches.
 *
 * Exact id and symbol matches are collected across every row, including
 * suppressed (frozen/quarantined/delisted) coins: a verb that names that asset
 * must never run against a live namesake. A ticker several coins own is
 * ambiguous and resolves to nothing, so no Run-command row offers a wrong coin.
 *
 * Preference order:
 *   1. Exact id match.
 *   2. Exact symbol match, when exactly one coin owns the ticker.
 *   3. Symbol startsWith.
 *   4. Id startsWith.
 *   5. Name startsWith (first word).
 * Only the prefix tiers skip suppressed coins.
 */
function resolveCoinIdFromToken(token: string): string | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;

  const exactSymbolIds = new Set<string>();
  let exactId: string | null = null;
  let prefixSymbol: string | null = null;
  let prefixId: string | null = null;
  let prefixName: string | null = null;

  for (const coin of COMMAND_PALETTE_STABLECOINS) {
    const [id, name, symbol, status] = coin;
    const idLc = id.toLowerCase();
    const symbolLc = symbol.toLowerCase();

    if (idLc === t) exactId = id;
    if (symbolLc === t) exactSymbolIds.add(id);

    if (status === "quarantined" || status === "delisted" || status === "frozen") continue;
    const nameLc = name.toLowerCase();

    if (!prefixSymbol && symbolLc.startsWith(t)) prefixSymbol = id;
    if (!prefixId && idLc.startsWith(t)) prefixId = id;
    if (!prefixName) {
      const firstWord = nameLc.split(/\s+/)[0] ?? "";
      if (firstWord.startsWith(t) || nameLc.startsWith(t)) prefixName = id;
    }
  }

  if (exactId) return exactId;
  if (exactSymbolIds.size > 1) return null;
  const [exactSymbol] = exactSymbolIds;
  return exactSymbol ?? prefixSymbol ?? prefixId ?? prefixName;
}

const COMPARE_SEPARATOR_TOKENS = new Set(["vs", "versus", "vs."]);
/** "X vs Y" sugar accepts 2–4 coin tokens around the separator(s). */
const VS_PHRASE_MAX_COIN_TOKENS = 4;

function isCompareSeparator(token: string): boolean {
  return COMPARE_SEPARATOR_TOKENS.has(token.toLowerCase());
}

/**
 * Detect the "<a> vs <b>" / "<a> versus <b>" / "<a> vs. <b>" phrasing and
 * return the coin tokens. Conservative: needs 2–4 coin tokens with a separator
 * between them, never leading or trailing ("vs usdt" stays a plain query).
 */
function detectVsPhrase(input: string): string[] | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3 || tokens.length > 2 * VS_PHRASE_MAX_COIN_TOKENS - 1) return null;
  const coinTokens = tokens.filter((token) => !isCompareSeparator(token));
  const separatorCount = tokens.length - coinTokens.length;
  if (separatorCount === 0 || coinTokens.length < 2 || coinTokens.length > VS_PHRASE_MAX_COIN_TOKENS) {
    return null;
  }
  if (isCompareSeparator(tokens[0]!) || isCompareSeparator(tokens.at(-1)!)) return null;
  return coinTokens;
}

/**
 * Single compare-URL builder for the palette verb: when exactly two coins
 * resolve to a curated `STATIC_COMPARE_PAIRS` entry (either order), open the
 * pre-rendered static page; otherwise fall back to the live compare URL.
 */
function buildCompareVerbHref(coinIds: readonly string[]): string {
  if (coinIds.length === 2) {
    const [left, right] = coinIds;
    const pair = STATIC_COMPARE_PAIRS.find(
      ([pairLeft, pairRight]) =>
        (pairLeft === left && pairRight === right) || (pairLeft === right && pairRight === left),
    );
    if (pair) return `/compare/${buildStaticComparisonSlug(pair[0], pair[1])}/`;
  }
  return buildLiveCompareUrl(coinIds);
}

function buildCompareVerb(tokens: string[]): Extract<ParsedVerb, { kind: "compare" }> {
  const limited = tokens.slice(0, MAX_COMPARE_COINS);
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const token of limited) {
    const id = resolveCoinIdFromToken(token);
    if (id && !seen.has(id)) {
      resolved.push(id);
      seen.add(id);
    } else if (!id) {
      unresolved.push(token);
    }
  }
  return {
    kind: "compare",
    coinSymbols: limited,
    resolvedCoinIds: resolved,
    unresolved,
    href: buildCompareVerbHref(resolved),
  };
}

const STABLECOIN_META_BY_ID = new Map<string, { name: string; symbol: string }>(
  COMMAND_PALETTE_STABLECOINS.map(([id, name, symbol]) => [id, { name, symbol }]),
);

interface SectionIntentSpec {
  sectionKey: CommandPaletteDossierSectionKey;
  sectionLabel: string;
  hash: string;
  resolveTarget?: (coinId: string | null) => { sectionLabel: string; hash: string };
}

const SECTION_INTENT_BY_TOKEN: Readonly<Record<string, SectionIntentSpec>> = {
  reserves: { sectionKey: "reserves", sectionLabel: "Reserves", hash: "#reserves" },
  reserve: { sectionKey: "reserves", sectionLabel: "Reserves", hash: "#reserves" },
  backing: { sectionKey: "reserves", sectionLabel: "Reserves", hash: "#reserves" },
  overview: { sectionKey: "overview", sectionLabel: "Risk overview", hash: "#overview" },
  liquidity: { sectionKey: "liquidity", sectionLabel: "Liquidity", hash: "#liquidity" },
  dex: { sectionKey: "liquidity", sectionLabel: "Liquidity", hash: "#liquidity" },
  history: { sectionKey: "history", sectionLabel: "History", hash: "#history" },
  depeg: { sectionKey: "history", sectionLabel: "Depeg history", hash: "#history" },
  depegs: { sectionKey: "history", sectionLabel: "Depeg history", hash: "#history" },
  freeze: { sectionKey: "freeze", sectionLabel: "Freeze & Seizure", hash: "#freeze-seizure" },
  freezes: { sectionKey: "freeze", sectionLabel: "Freeze & Seizure", hash: "#freeze-seizure" },
  blacklist: {
    sectionKey: "freeze",
    sectionLabel: "Blacklist Events",
    hash: "#blacklist",
    resolveTarget: (coinId) => {
      if (!coinId || isBlacklistTrackedStablecoinId(coinId)) {
        return { sectionLabel: "Blacklist Events", hash: "#blacklist" };
      }
      return { sectionLabel: "Freeze & Seizure", hash: "#freeze-seizure" };
    },
  },
};

/**
 * Tokens that express a dossier deep-section jump when combined with a coin
 * ticker/name (e.g. "usdc reserves", "usdc liquidity", "usdc history",
 * "usdc freeze", or verb-first "reserves usdc", "depeg usdc").
 */
export const DOSSIER_SECTION_INTENT_TOKENS: ReadonlySet<string> = new Set(Object.keys(SECTION_INTENT_BY_TOKEN));

function buildSectionVerb(
  spec: SectionIntentSpec,
  coinQuery: string,
): Extract<ParsedVerb, { kind: "section" }> {
  const trimmedCoin = coinQuery.trim();
  const resolvedCoinId = trimmedCoin ? resolveCoinIdFromToken(trimmedCoin) : null;
  const meta = resolvedCoinId ? STABLECOIN_META_BY_ID.get(resolvedCoinId) ?? null : null;
  const resolvedTarget = spec.resolveTarget ? spec.resolveTarget(resolvedCoinId) : spec;
  return {
    kind: "section",
    sectionKey: spec.sectionKey,
    sectionLabel: resolvedTarget.sectionLabel,
    coinQuery: trimmedCoin,
    resolvedCoinId,
    resolvedCoinName: meta?.name ?? null,
    resolvedCoinSymbol: meta?.symbol ?? null,
    hash: resolvedTarget.hash,
    href: resolvedCoinId ? `${buildStablecoinUrl(resolvedCoinId)}${resolvedTarget.hash}` : "",
  };
}

/**
 * Detect dossier deep-section intents:
 *   - "<coin> <section>" (e.g. "usdc reserves", "usdc liquidity", "usdc history", "usdc freeze")
 *   - "<section> <coin>" (e.g. "reserves usdc", "depeg usdc")
 *   - "<section> " (trailing space from clicking a verb chip; bare "<section>" stays normal search)
 */
function detectSectionIntent(input: string): Extract<ParsedVerb, { kind: "section" }> | null {
  const trimmedStart = input.trimStart();
  if (!trimmedStart) return null;
  const lower = trimmedStart.toLowerCase();

  // Leading section keyword followed by whitespace ("reserves ", "depeg usdc").
  const leadingSpaceIdx = lower.indexOf(" ");
  if (leadingSpaceIdx > 0) {
    const first = lower.slice(0, leadingSpaceIdx);
    const leadingSpec = SECTION_INTENT_BY_TOKEN[first];
    if (leadingSpec) {
      const rest = trimmedStart.slice(leadingSpaceIdx + 1).trim();
      return buildSectionVerb(leadingSpec, rest);
    }
  }

  // Trailing section keyword ("usdc reserves", "usd coin liquidity").
  const tokens = trimmedStart.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const lastToken = tokens.at(-1)!.toLowerCase();
  const trailingSpec = SECTION_INTENT_BY_TOKEN[lastToken];
  if (!trailingSpec) return null;
  const coinQuery = tokens.slice(0, -1).join(" ");
  const verb = buildSectionVerb(trailingSpec, coinQuery);
  return verb.resolvedCoinId ? verb : null;
}

/**
 * Build a `/portfolio/?coins=...` URL (or merge into an existing `p` param)
 * routed through `mergeCoinsParam` so token formatting stays aligned with
 * `src/lib/portfolio-codec.ts`.
 */
export function buildPortfolioHrefFromCoinIds(
  coinIds: readonly string[],
  existingPortfolioParam?: string | null,
): string {
  const uniqueIds = [...new Set(coinIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return "/portfolio/";
  if (existingPortfolioParam) {
    const merged = mergeCoinsParam(existingPortfolioParam, uniqueIds.join(","));
    return merged ? `/portfolio/?p=${encodeURIComponent(merged)}` : "/portfolio/";
  }
  const merged = mergeCoinsParam(null, uniqueIds.join(","));
  if (!merged) return "/portfolio/";
  const tokens = merged
    .split(",")
    .map((part) => part.split(":")[0])
    .filter((token): token is string => Boolean(token));
  return `/portfolio/?coins=${tokens.map((id) => encodeURIComponent(id)).join(",")}`;
}

function buildPortfolioVerb(tokens: string[]): Extract<ParsedVerb, { kind: "portfolio" }> {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const id = resolveCoinIdFromToken(token);
    if (id && !seen.has(id)) {
      resolved.push(id);
      seen.add(id);
    } else if (!id) {
      unresolved.push(token);
    }
  }
  return {
    kind: "portfolio",
    coinSymbols: tokens,
    resolvedCoinIds: resolved,
    unresolved,
    href: buildPortfolioHrefFromCoinIds(resolved),
  };
}

const VERB_KEYWORDS = ["compare", "portfolio", "screen", "pin", "unpin", "tape:"] as const;
type VerbKeyword = (typeof VERB_KEYWORDS)[number];

interface VerbLead {
  keyword: VerbKeyword;
  rest: string;
}

function detectVerbLead(input: string): VerbLead | null {
  const trimmed = input.trimStart();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  for (const keyword of VERB_KEYWORDS) {
    if (keyword.endsWith(":")) {
      // `view:` / `tape:` accept the colon as a delimiter and an optional space.
      if (lower.startsWith(keyword)) {
        return { keyword, rest: trimmed.slice(keyword.length).trim() };
      }
    } else if (lower === keyword || lower.startsWith(`${keyword} `)) {
      return { keyword, rest: trimmed.slice(keyword.length).trim() };
    }
  }
  return null;
}

/**
 * Parse `key OP value` tokens into screener URL params. Supported operators:
 *   key>=N       → field "<key>Min" or maps to `safety<X>Min`
 *   key<N        → field "<key>Max"
 *   key=value    → list / enum field
 *
 * Conservative: returns an empty params object if no token parses.
 */
interface ScreenTokenMapping {
  resolve: (op: "gte" | "lte" | "eq", value: string) => Array<[string, string]>;
}

const SCREEN_TOKEN_MAP: Record<string, ScreenTokenMapping> = {
  dews: {
    resolve: (op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      if (op === "gte") return [["dewsMin", String(n)]];
      if (op === "lte") return [["dewsMax", String(n)]];
      return [];
    },
  },
  supply: {
    resolve: (op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return [];
      if (op === "gte") return [["supplyMin", String(n)]];
      // The screener reads `supplyMax=0` as "no maximum", so a non-positive
      // ceiling cannot be represented; drop it rather than widen to every row.
      if (op === "lte") return n > 0 ? [["supplyMax", String(n)]] : [];
      return [];
    },
  },
  safety: {
    resolve: (op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        if (op === "eq") return [["safetyGrades", value.toUpperCase()]];
        return [];
      }
      // `safety>=N` is the published overall Safety Score minimum, the axis the
      // screener decodes; a key outside `SCREENER_URL_SCHEMA` is dropped silently.
      if (op === "gte") return [["safetyScoreMin", String(n)]];
      return [];
    },
  },
  peg: {
    resolve: (op, value) => {
      if (op !== "eq") return [];
      return [["pegs", value.toUpperCase()]];
    },
  },
  mechanism: {
    resolve: (op, value) => {
      if (op !== "eq") return [];
      return [["mechanisms", value.toLowerCase()]];
    },
  },
  type: {
    resolve: (op, value) => {
      if (op !== "eq") return [];
      return [["types", value.toLowerCase()]];
    },
  },
  lifecycle: {
    resolve: (op, value) => {
      if (op !== "eq") return [];
      return [["lifecycle", value.toLowerCase()]];
    },
  },
};

interface ScreenTokens {
  filters: Record<string, string | string[]>;
  error?: string;
}

function parseScreenTokens(rest: string): ScreenTokens {
  const tokens = rest.split(/\s+/).filter(Boolean);
  const filters: Record<string, string | string[]> = {};
  let error: string | undefined;

  const setOrAppend = (key: string, value: string) => {
    const field = SCREENER_URL_SCHEMA[key as keyof ScreenerFilters];
    if (field.kind === "boundedNumber") {
      const n = Number(value);
      if (!Number.isFinite(n) || (field.min != null && n < field.min) || (field.max != null && n > field.max)) {
        error = `Cannot represent ${key}=${value} in the screener.`;
        return;
      }
      const existing = filters[key];
      filters[key] = String(existing == null ? n : key.endsWith("Min")
        ? Math.max(Number(existing), n)
        : Math.min(Number(existing), n));
    } else if (field.kind === "enumList") {
      const existing = filters[key];
      if (existing == null) filters[key] = value;
      else {
        const values = Array.isArray(existing) ? existing : [existing];
        if (!values.includes(value)) values.push(value);
        filters[key] = values;
      }
    }
  };

  for (const token of tokens) {
    // Match `key>=value`, `key<=value`, `key>value`, `key<value`, `key=value`.
    const m = /^([A-Za-z]+)(>=|<=|>|<|=)(.+)$/.exec(token);
    if (!m) continue;
    const [, rawKey, rawOp, rawValue] = m;
    const key = rawKey.toLowerCase();
    const mapping = SCREEN_TOKEN_MAP[key];
    if (!mapping) continue;

    const op: "gte" | "lte" | "eq" =
      rawOp === ">=" || rawOp === ">" ? "gte" : rawOp === "<=" || rawOp === "<" ? "lte" : "eq";
    const pairs = mapping.resolve(op, rawValue.trim());
    for (const [k, v] of pairs) setOrAppend(k, v);
  }

  if (Number(filters.dewsMin ?? 0) > Number(filters.dewsMax ?? 100) ||
      (filters.supplyMax != null && Number(filters.supplyMin ?? 0) > Number(filters.supplyMax))) {
    error = "Conflicting screener bounds: the minimum exceeds the maximum.";
  }
  return { filters, ...(error ? { error } : {}) };
}

/** Admit through the destination codec, then derive both the URL and preview. */
function buildScreenerResult(
  parsed: ScreenTokens,
): Extract<ParsedVerb, { kind: "screen" }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.filters)) {
    params.set(key, Array.isArray(value) ? value.join(",") : value);
  }
  const admitted = decodeState(params, SCREENER_URL_SCHEMA);
  // Preserve the single-mechanism alias's active-only deep-link behavior.
  if (admitted.mechanisms.length > 0 && parsed.filters.lifecycle == null) admitted.lifecycle = ["active"];
  const qs = encodeState(admitted, SCREENER_URL_SCHEMA);
  const encoded = new URLSearchParams(qs);
  const filters: Record<string, string | string[]> = {};
  for (const [key, value] of encoded) {
    const field = SCREENER_URL_SCHEMA[key as keyof ScreenerFilters];
    filters[key] = field.kind === "enumList" && value.includes(",") ? value.split(",") : value;
  }
  return {
    kind: "screen",
    filters,
    href: qs ? `/screener/?${qs}` : "/screener/",
    ...(parsed.error ? { error: parsed.error } : {}),
  };
}

const TAPE_ALLOWED_KEYS = new Set(["severity", "type", "coin", "stablecoin", "chain"]);

function parseTapeTokens(rest: string): Record<string, string> {
  const tokens = rest.split(/\s+/).filter(Boolean);
  const filters: Record<string, string> = {};
  for (const token of tokens) {
    const m = /^([A-Za-z]+)=(.+)$/.exec(token);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (!TAPE_ALLOWED_KEYS.has(key)) continue;
    filters[key === "stablecoin" ? "coin" : key] = m[2].trim();
  }
  return filters;
}

function buildTapeHref(filters: Record<string, string>): string {
  const params = new URLSearchParams(filters);
  const qs = params.toString();
  return qs ? `/timeline/?${qs}` : "/timeline/";
}

export function parsePaletteInput(input: string): ParsedVerb {
  const lead = detectVerbLead(input);
  if (lead) {
    switch (lead.keyword) {
      case "compare": {
        // Tolerate "compare a vs b" — the separator is never a coin token.
        const tokens = lead.rest
          .split(/[\s,]+/)
          .filter(Boolean)
          .filter((token) => !isCompareSeparator(token));
        if (tokens.length === 0) {
          return {
            kind: "compare",
            coinSymbols: [],
            resolvedCoinIds: [],
            unresolved: [],
            href: buildCompareVerbHref([]),
          };
        }
        return buildCompareVerb(tokens);
      }

      case "portfolio": {
        const tokens = lead.rest
          .split(/[\s,]+/)
          .filter(Boolean);
        if (tokens.length === 0) {
          return {
            kind: "portfolio",
            coinSymbols: [],
            resolvedCoinIds: [],
            unresolved: [],
            href: "/portfolio/",
          };
        }
        return buildPortfolioVerb(tokens);
      }

      case "screen":
        return buildScreenerResult(parseScreenTokens(lead.rest));

      case "pin": {
        const token = lead.rest.split(/\s+/)[0] ?? "";
        const resolvedCoinId = token ? resolveCoinIdFromToken(token) : null;
        return { kind: "pin", coinSymbol: token, resolvedCoinId };
      }

      case "unpin": {
        const token = lead.rest.split(/\s+/)[0] ?? "";
        if (token.toLowerCase() === "all") {
          return { kind: "unpin", coinSymbol: "all", resolvedCoinId: null };
        }
        const resolvedCoinId = token ? resolveCoinIdFromToken(token) : null;
        return { kind: "unpin", coinSymbol: token, resolvedCoinId };
      }

      case "tape:": {
        const filters = parseTapeTokens(lead.rest);
        return {
          kind: "tape",
          filters,
          href: buildTapeHref(filters),
        };
      }
    }
  }

  const vsTokens = detectVsPhrase(input);
  if (vsTokens) return buildCompareVerb(vsTokens);
  const sectionIntent = detectSectionIntent(input);
  if (sectionIntent) return sectionIntent;
  return { kind: "none" };
}

/** Build a /compare URL from a list of coin ids, capped at MAX_COMPARE_COINS. */
export function buildCompareHrefFromCoinIds(coinIds: readonly string[]): string {
  return buildLiveCompareUrl(coinIds.slice(0, MAX_COMPARE_COINS));
}
