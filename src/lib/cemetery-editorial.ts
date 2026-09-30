/**
 * Editorial layer for cemetery obituaries: the hand-curated display titles
 * and the sentence splitter behind obituary leads and previews.
 *
 * The titled set IS the editorial set. Titles stay factual: a title never
 * states a figure that contradicts its record (the UST title carries no dollar
 * figure because the record's peak is $18.8B, not the combined UST+LUNA loss).
 */

export const EDITORIAL_TITLES: Readonly<Record<string, string>> = {
  "ust-terrausd-2022-05":
    "How TerraUSD's algorithmic peg collapsed in days",
  "busd-binance-usd-2023-02":
    "How a regulator quietly ended the third-largest stablecoin",
  "iron-iron-2021-06":
    "How crypto's first bank run ate Iron Finance in eight hours",
  "esd-empty-set-dollar-2021-01":
    "How seigniorage coupons promised stability and delivered ruin",
  "bac-basis-cash-2021-01":
    "How Do Kwon's first stablecoin failed before he built the second",
  "usdn-neutrino-usd-2022-04":
    "How WAVES collateral dragged Neutrino USD into its own gravity well",
  "fei-fei-usd-2022-08":
    "How a $1.3B launch ended in a 1:1 DAI redemption vote",
  "husd-husd-2022-10":
    "How Justin Sun's Huobi acquisition unwound HUSD overnight",
  "dsd-dynamic-set-dollar-2021-01":
    "How Dynamic Set Dollar discovered faster reflexivity cuts both ways",
  "vai-vai-2021-09":
    "How Venus's $77M bad-debt crisis broke its native stablecoin",
  "tor-tor-2023-07":
    "How the Multichain exploit ended Hector Network's stablecoin",
};

export function isEditorialId(id: string): boolean {
  return Object.hasOwn(EDITORIAL_TITLES, id);
}

/** Maximum length of an editorial preview, ellipsis included. */
export const EDITORIAL_PREVIEW_MAX_CHARS = 380;

const ELLIPSIS = "\u2026";

/**
 * Terminal punctuation, then any closing quotes or brackets, then whitespace
 * or the end of the text. A decimal point ("$23.5B") never matches because
 * the lookahead requires whitespace after the run.
 */
const SENTENCE_END = /[.!?]+["'\u201D\u2019)\]]*(?=\s|$)/g;
const ENDS_WITH_TERMINAL = /[.!?]["'\u201D\u2019)\]]*$/;
const LEADING_OPENERS = /^["'\u201C\u2018([]+/;
/** Dotted initialisms such as "U.S", "e.g", "i.e", "U.K" (final dot excluded). */
const DOTTED_INITIALISM = /^(?:[A-Za-z]\.)+[A-Za-z]$/;
/** A single capital initial such as the "J" in "J. Doe". */
const SINGLE_INITIAL = /^[A-Z]$/;
const LOWERCASE_START = /^["'\u201C\u2018([]*[a-z]/;

/**
 * Abbreviations compared lowercase with the final dot excluded. "always"
 * never ends a sentence; "unless-lowercase-follows" ("etc.", "al.") ends one
 * unless the next word starts lowercase.
 */
const ABBREVIATIONS: Readonly<Record<string, "always" | "unless-lowercase-follows">> = {
  approx: "always",
  co: "always",
  corp: "always",
  dr: "always",
  inc: "always",
  jr: "always",
  ltd: "always",
  mr: "always",
  mrs: "always",
  ms: "always",
  prof: "always",
  sr: "always",
  st: "always",
  v: "always",
  vs: "always",
  jan: "always",
  feb: "always",
  mar: "always",
  apr: "always",
  jun: "always",
  jul: "always",
  aug: "always",
  sep: "always",
  sept: "always",
  oct: "always",
  nov: "always",
  dec: "always",
  etc: "unless-lowercase-follows",
  al: "unless-lowercase-follows",
};

function isAbbreviationStop(text: string, matchIndex: number, match: string, matchEnd: number): boolean {
  // Only a bare full stop can close an abbreviation; "?", "!", "..." and a
  // stop followed by a closing quote always end the sentence.
  if (match !== ".") return false;
  let tokenStart = matchIndex;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) tokenStart -= 1;
  const token = text.slice(tokenStart, matchIndex).replace(LEADING_OPENERS, "");
  if (!token) return false;
  if (DOTTED_INITIALISM.test(token) || SINGLE_INITIAL.test(token)) return true;
  const lower = token.toLowerCase();
  if (!Object.hasOwn(ABBREVIATIONS, lower)) return false;
  return ABBREVIATIONS[lower] === "always" || LOWERCASE_START.test(text.slice(matchEnd).trimStart());
}

/**
 * Splits obituary prose into sentences. Decimal-safe ("$23.5B." ends one
 * sentence, "$23.5" never splits), quote-safe (`run." IRON` splits after the
 * closing quote) and abbreviation-aware ("U.S.", "e.g.", "Inc.", "vs.").
 * Sentences that open lowercase ("sUSD", "eUSD") are real sentences, so case
 * alone never vetoes a boundary.
 */
export function splitObituarySentences(text: string): string[] {
  const source = text.trim();
  if (!source) return [];

  const sentences: string[] = [];
  let start = 0;
  for (const match of source.matchAll(SENTENCE_END)) {
    const matchIndex = match.index;
    const matchEnd = matchIndex + match[0].length;
    if (matchEnd < source.length && isAbbreviationStop(source, matchIndex, match[0], matchEnd)) continue;
    const sentence = source.slice(start, matchEnd).trim();
    if (sentence) sentences.push(sentence);
    start = matchEnd;
  }
  const tail = source.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/** The first sentence, terminated with a full stop when the source has none. */
export function getObituaryLead(obituary: string): string {
  const [lead] = splitObituarySentences(obituary);
  if (!lead) return "";
  return ENDS_WITH_TERMINAL.test(lead) ? lead : `${lead}.`;
}

function truncateOnWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = maxChars - ELLIPSIS.length;
  let cut = text.slice(0, budget);
  // Cutting inside a word: fall back to the last whitespace in the budget.
  if (!/\s/.test(text[budget])) {
    const lastSpace = cut.search(/\s\S*$/);
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd().replace(/[\s,;:\u2013\u2014-]+$/, "")}${ELLIPSIS}`;
}

/**
 * Inspector/register preview. Editorial ids get the first two sentences,
 * capped at {@link EDITORIAL_PREVIEW_MAX_CHARS} on a word boundary with an
 * ellipsis; every other record gets its lead sentence.
 */
export function getObituaryPreview(obituary: string, { editorial }: { editorial: boolean }): string {
  if (!editorial) return getObituaryLead(obituary);
  const preview = splitObituarySentences(obituary).slice(0, 2).join(" ");
  if (!preview) return getObituaryLead(obituary);
  return truncateOnWordBoundary(preview, EDITORIAL_PREVIEW_MAX_CHARS);
}
