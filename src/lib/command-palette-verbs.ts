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
import { decodeState, encodeState } from "@/lib/url-state";
import {
  SCREENER_URL_SCHEMA,
  type ScreenerFilters,
} from "@/lib/screener-filters";

// ── Result types ────────────────────────────────────────────────────────────

export type ParsedVerb =
  | { kind: "compare"; coinSymbols: string[]; resolvedCoinIds: string[]; unresolved: string[]; href: string }
  | { kind: "screen"; filters: Record<string, string | string[] | number>; href: string; error?: string }
  | { kind: "pin"; coinSymbol: string; resolvedCoinId: string | null }
  | { kind: "unpin"; coinSymbol: string | "all"; resolvedCoinId: string | null }
  | { kind: "tape"; filters: Record<string, string>; href: string }
  | { kind: "none" };

// ── Coin lookup ─────────────────────────────────────────────────────────────

/**
 * Fuzzy resolve a token (symbol/name/id) to a coin id from the static palette
 * registry. Case-insensitive. Returns null when nothing matches.
 *
 * Preference order:
 *   1. Exact symbol match (case-insensitive).
 *   2. Exact id match.
 *   3. Symbol startsWith.
 *   4. Id startsWith.
 *   5. Name startsWith (first word).
 */
function resolveCoinIdFromToken(token: string): string | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;

  let exactSymbol: string | null = null;
  let exactId: string | null = null;
  let prefixSymbol: string | null = null;
  let prefixId: string | null = null;
  let prefixName: string | null = null;

  for (const coin of COMMAND_PALETTE_STABLECOINS) {
    const [id, name, symbol, status] = coin;
    if (status === "quarantined" || status === "delisted" || status === "frozen") continue;
    const idLc = id.toLowerCase();
    const symbolLc = symbol.toLowerCase();
    const nameLc = name.toLowerCase();

    if (!exactSymbol && symbolLc === t) exactSymbol = id;
    if (!exactId && idLc === t) exactId = id;
    if (!prefixSymbol && symbolLc.startsWith(t)) prefixSymbol = id;
    if (!prefixId && idLc.startsWith(t)) prefixId = id;
    if (!prefixName) {
      const firstWord = nameLc.split(/\s+/)[0] ?? "";
      if (firstWord.startsWith(t) || nameLc.startsWith(t)) prefixName = id;
    }
  }

  return exactSymbol ?? exactId ?? prefixSymbol ?? prefixId ?? prefixName;
}

// ── Compare verb resolution ─────────────────────────────────────────────────

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

// ── Verb keyword detection ──────────────────────────────────────────────────

const VERB_KEYWORDS = ["compare", "screen", "pin", "unpin", "tape:"] as const;
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

// ── Screener filter mini-parser ─────────────────────────────────────────────

/**
 * Parse `key OP value` tokens into screener URL params. Supported operators:
 *   key>=N       → field "<key>Min" or maps to `safety<X>Min`
 *   key<N        → field "<key>Max"
 *   key=value    → list / enum field
 *
 * Conservative: returns an empty params object if no token parses.
 */
interface ScreenTokenMapping {
  /** Resolves a `key OP value` triple to URL key/value pairs. */
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
        // Treat `safety=A-` etc. as a safetyGrades enumList contribution.
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

// ── Tape filter mini-parser ─────────────────────────────────────────────────

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

// ── Public API ──────────────────────────────────────────────────────────────

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

  // "<a> vs <b>" phrasing is the compare verb without the keyword.
  const vsTokens = detectVsPhrase(input);
  if (vsTokens) return buildCompareVerb(vsTokens);
  return { kind: "none" };
}

// ── Reusable helper for compare-watchlist action ────────────────────────────

/** Build a /compare URL from a list of coin ids, capped at MAX_COMPARE_COINS. */
export function buildCompareHrefFromCoinIds(coinIds: readonly string[]): string {
  return buildLiveCompareUrl(coinIds.slice(0, MAX_COMPARE_COINS));
}
