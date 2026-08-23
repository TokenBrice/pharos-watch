/**
 * Command palette verb parser.
 *
 * Recognises a small set of leading-keyword verbs that turn the palette from
 * a search field into an action surface (see Council IDEA-3). The parser is
 * conservative — only fires when the input starts with one of the verb
 * keywords followed by a space — so plain search remains the default.
 *
 * Verbs:
 *   compare TOKEN [TOKEN ...]     → /compare?coins=<ids>
 *   screen filter=value [...]     → /screener?<encoded>
 *   pin TOKEN                     → mutates watchlist (add)
 *   unpin TOKEN | all             → mutates watchlist (remove or clear)
 *   tape: filters                 → /timeline?<encoded>
 */

import { COMMAND_PALETTE_STABLECOINS } from "@/lib/command-palette-search-data";
import { MAX_COMPARE_COINS } from "@/lib/compare-config";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { encodeState, type UrlStateField } from "@/lib/url-state";
import {
  SCREENER_URL_SCHEMA,
  SCREENER_FILTER_DEFAULTS,
  type ScreenerFilters,
} from "@/lib/screener-filters";

// ── Result types ────────────────────────────────────────────────────────────

export type ParsedVerb =
  | { kind: "compare"; coinSymbols: string[]; resolvedCoinIds: string[]; unresolved: string[] }
  | { kind: "screen"; filters: Record<string, string | string[] | number>; href: string }
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
      if (op === "lte") return [["supplyMax", String(n)]];
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
      // `safety>=N` is a shorthand for pegStability min; mirror council brief.
      if (op === "gte") return [["safetyPegStabilityMin", String(n)]];
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
      // Singular alias the screener already normalises into `mechanisms`.
      return [["mechanism", value.toLowerCase()]];
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

function parseScreenTokens(rest: string): Record<string, string | string[] | number> {
  const tokens = rest.split(/\s+/).filter(Boolean);
  const filters: Record<string, string | string[]> = {};

  const setOrAppend = (key: string, value: string) => {
    const existing = filters[key];
    if (existing == null) {
      filters[key] = value;
      return;
    }
    if (Array.isArray(existing)) {
      if (!existing.includes(value)) existing.push(value);
      return;
    }
    if (existing !== value) {
      filters[key] = [existing, value];
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

  return filters;
}

/**
 * Encode the parsed screener filter map into a query string by overlaying onto
 * the canonical SCREENER_URL_SCHEMA. Unknown keys fall through as raw URL
 * params so the screener's existing alias normaliser (`mechanism=`) keeps
 * working.
 */
function buildScreenerHrefFromFilters(filters: Record<string, string | string[] | number>): string {
  // First, project numeric / list values onto the typed ScreenerFilters shape.
  const overlay: Partial<ScreenerFilters> = {};
  const raw: Record<string, string> = {};

  for (const [key, value] of Object.entries(filters)) {
    if (key in SCREENER_URL_SCHEMA) {
      const field = SCREENER_URL_SCHEMA[key as keyof ScreenerFilters] as UrlStateField<unknown>;
      if (field.kind === "boundedNumber") {
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n)) {
          (overlay as Record<string, unknown>)[key] = n;
        }
      } else if (field.kind === "enumList") {
        const next = Array.isArray(value) ? value : [String(value)];
        (overlay as Record<string, unknown>)[key] = next;
      } else if (field.kind === "string" || field.kind === "enum") {
        (overlay as Record<string, unknown>)[key] = String(value);
      } else if (field.kind === "boolean") {
        (overlay as Record<string, unknown>)[key] = String(value) === "true";
      }
    } else if (typeof value === "string") {
      // Fall-through for alias keys like `mechanism=` that the screener
      // normalises on mount.
      raw[key] = value;
    }
  }

  const merged: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, ...overlay };
  const qs = encodeState(merged, SCREENER_URL_SCHEMA);
  const params = new URLSearchParams(qs);
  for (const [k, v] of Object.entries(raw)) {
    if (!params.has(k)) params.set(k, v);
  }
  const finalQs = params.toString();
  return finalQs ? `/screener/?${finalQs}` : "/screener/";
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
  if (!lead) return { kind: "none" };

  switch (lead.keyword) {
    case "compare": {
      const tokens = lead.rest.split(/[\s,]+/).filter(Boolean);
      if (tokens.length === 0) {
        return { kind: "compare", coinSymbols: [], resolvedCoinIds: [], unresolved: [] };
      }
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
      };
    }

    case "screen": {
      const filters = parseScreenTokens(lead.rest);
      return {
        kind: "screen",
        filters,
        href: buildScreenerHrefFromFilters(filters),
      };
    }

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

// ── Reusable helper for compare-watchlist action ────────────────────────────

/** Build a /compare URL from a list of coin ids, capped at MAX_COMPARE_COINS. */
export function buildCompareHrefFromCoinIds(coinIds: readonly string[]): string {
  return buildLiveCompareUrl(coinIds.slice(0, MAX_COMPARE_COINS));
}
