import { logWorkerEventArgs } from "../../lib/structured-log";
import { DigestResponseSchema } from "../../lib/schemas";
import { validateDigestLeadRequirements, type DigestLeadRequirement } from "./lead-requirements";
import { findForbiddenTics, hasForwardLook, leadFamily, openingFingerprint, type LeadFamily } from "./voice-guards";
import { toErrorMessage } from "../../lib/error-utils";
import { getMetaString, normalizeStringArray } from "./digest-intelligence-utils";
import { findDigestSafetyClaimMarkers } from "../../lib/digest-safety-context";

const FORBIDDEN_PHRASES = [
  "Meanwhile, ",
  "Meanwhile ",
  "In other news, ",
  "It's worth noting ",
  "It remains to be seen ",
];

export interface ParsedDigestResponse {
  digestTitle: string;
  digestText: string;
  digestExtended: string;
  digestMeta: string | null;
  strippedDashCount: number;
  forbiddenPhraseHits: string[];
  usedRawTextFallback: boolean;
}

export interface DigestValidationIssue {
  code: string;
  severity: "hard" | "soft";
  message: string;
}

export interface DigestValidationProfile {
  kind: "daily" | "weekly";
  recentMeta?: Array<{
    meta: Record<string, unknown> | null;
    title: string | null;
    rawText?: string | null;
  }>;
  leadRequirements?: DigestLeadRequirement[];
  /** Per-coin depeg truth for the price/bps consistency lint. */
  depegFacts?: DigestDepegFact[];
  /** Previous edition's depeg facts, for movement-claim verification. */
  prevDepegFacts?: DigestDepegFact[];
  /** Trailing titles (up to ~30 editions) for long-window title dedupe. */
  recentTitles?: string[];
  /** Fail closed and allow the standard corrective retry when canonical safety evidence is unavailable. */
  forbidSafetyClaims?: boolean;
}

export interface DigestDepegFact {
  symbol: string;
  currentPriceUsd?: number;
  currentBps?: number;
  bps?: number;
  peakBps?: number;
}

export interface DigestModelResponseParseOptions {
  metaFactory?: (options: {
    parsedMeta: Record<string, unknown> | null;
    usedRawTextFallback: boolean;
  }) => Record<string, unknown> | null;
}

// Detection only — silently deleting phrases left capitalization and grammar
// fragments mid-sentence. Hits become a soft quality issue instead.
function detectForbiddenPhrases(value: string): string[] {
  return FORBIDDEN_PHRASES.filter((phrase) => value.includes(phrase));
}

function stripForbiddenDashes(value: string): string {
  return value.replace(/[\u2013\u2014]/g, ",");
}

function stripRepeatedTitlePrefix(title: string, text: string): string {
  if (!title) return text;
  if (!text.toLowerCase().startsWith(title.toLowerCase())) return text;
  return text.slice(title.length).replace(/^[\s\n:,\-.]+/, "").trim();
}

const ALLOWED_LEADS = new Set([
  // PSI family
  "psi-streak",
  "psi-regime",
  "psi-band-change",
  "psi-divergence",
  // Depeg family
  "depeg",
  "resolved-depeg",
  "chronic-depeg",
  // DEWS family
  "dews-band-change",
  "dews-alert-breadth",
  "dews-warning",
  // Flow family
  "ftq",
  "mint-burn",
  "gauge-flip",
  "gauge-divergence",
  "supply-reversal",
  "supply-acceleration",
  "supply-deceleration",
  "chain-migration",
  // Risk family
  "grade-transition",
  "blacklist-contrast",
  "reserve-event",
  "yield-anomaly",
  "liquidity-shift",
  // Structural / macro
  "macro-observation",
  "market-structure",
  "issuer-concentration",
  "regime-divergence",
  "other",
]);

const ALLOWED_TONES = new Set([
  "bemused",
  "foreboding",
  "clinical",
  "wistful",
  "darkly-amused",
  "urgent",
  "dry",
  "analytical",
  "calm",
  "skeptical",
  "sardonic",
  "observant",
  "forensic",
  "resigned",
  "ironic",
  "other",
]);

function normalizeToken(value: unknown, allowed: Set<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (!normalized) return undefined;
  return allowed.has(normalized) ? normalized : "other";
}


function normalizeCoins(value: unknown): string[] | undefined {
  const cleaned = normalizeStringArray(value, 4)
    ?.map((coin) => coin.toUpperCase().replace(/^\$/, ""))
    .filter((coin) => /^[A-Z0-9]{2,16}$/.test(coin));
  return cleaned && cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
}

function normalizeParsedMeta(meta: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!meta) return null;
  const out: Record<string, unknown> = {};
  const leadSignalId = typeof meta.leadSignalId === "string" ? meta.leadSignalId.trim() : "";
  if (leadSignalId) out.leadSignalId = leadSignalId;
  const lead = normalizeToken(meta.lead, ALLOWED_LEADS);
  if (lead) out.lead = lead;
  const tone = normalizeToken(meta.tone, ALLOWED_TONES);
  if (tone) out.tone = tone;
  const coins = normalizeCoins(meta.coins);
  if (coins) out.coins = coins;
  const usedCandidateIds = normalizeStringArray(meta.usedCandidateIds, 6);
  if (usedCandidateIds) out.usedCandidateIds = usedCandidateIds;
  const suppressedCandidateIds = normalizeStringArray(meta.suppressedCandidateIds, 6);
  if (suppressedCandidateIds) out.suppressedCandidateIds = suppressedCandidateIds;
  return Object.keys(out).length > 0 ? out : null;
}

function extractDigestJson(rawText: string): unknown {
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  try {
    return JSON.parse(jsonText);
  } catch {
    const braceStart = jsonText.indexOf("{");
    if (braceStart === -1) {
      return null;
    }

    try {
      return JSON.parse(jsonText.slice(braceStart));
    } catch {
      const lastBrace = jsonText.lastIndexOf("}");
      if (lastBrace > braceStart) {
        try {
          return JSON.parse(jsonText.slice(braceStart, lastBrace + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}

export function parseDigestModelResponse(
  rawText: string,
  options: DigestModelResponseParseOptions = {},
): ParsedDigestResponse {
  const parsedJson = extractDigestJson(rawText);

  let digestTitle: string;
  let digestText: string;
  let digestExtended: string;
  let usedRawTextFallback = false;
  let parsedMeta: Record<string, unknown> | null = null;

  try {
    if (!parsedJson) {
      throw new Error("no valid JSON found");
    }
    const parsed = DigestResponseSchema.parse(parsedJson);
    digestTitle = parsed.title.trim();
    digestText = parsed.text.trim();
    digestExtended = parsed.extended.trim();
    if (!digestText) {
      throw new Error("empty text field");
    }
    parsedMeta = normalizeParsedMeta(parsed.meta ? parsed.meta as Record<string, unknown> : null);
  } catch (err) {
    logWorkerEventArgs("handler", "warn", `[daily-digest] Failed to parse digest model response, using raw text fallback: ${toErrorMessage(err)}`);
    digestTitle = "";
    digestText = rawText.trim();
    digestExtended = "";
    usedRawTextFallback = true;
  }

  const resolvedMeta = options.metaFactory
    ? options.metaFactory({ parsedMeta, usedRawTextFallback })
    : parsedMeta;
  const digestMeta = resolvedMeta ? JSON.stringify(resolvedMeta) : null;

  const strippedDashCount = [digestTitle, digestText, digestExtended].join("").match(/[\u2013\u2014]/g)?.length ?? 0;
  digestTitle = stripForbiddenDashes(digestTitle);
  digestText = stripForbiddenDashes(digestText);
  digestExtended = stripForbiddenDashes(digestExtended);
  digestText = stripRepeatedTitlePrefix(digestTitle, digestText);

  const forbiddenPhraseHits = [
    ...new Set([...detectForbiddenPhrases(digestText), ...detectForbiddenPhrases(digestExtended)]),
  ];

  return {
    digestTitle,
    digestText,
    digestExtended,
    digestMeta,
    strippedDashCount,
    forbiddenPhraseHits,
    usedRawTextFallback,
  };
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function splitParagraphs(value: string): string[] {
  return value.split(/\r?\n\s*\r?\n/g).map((paragraph) => paragraph.trim()).filter(Boolean);
}

function normalizeTitleFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function getMetaCoins(meta: Record<string, unknown> | null): string[] {
  const value = meta?.coins;
  if (!Array.isArray(value)) return [];
  return value.filter((coin): coin is string => typeof coin === "string").map((coin) => coin.toUpperCase());
}

export function validateDigestModelOutput(
  parsed: ParsedDigestResponse,
  profile: DigestValidationProfile,
): DigestValidationIssue[] {
  const issues: DigestValidationIssue[] = [];
  const titleWords = countWords(parsed.digestTitle);
  const paragraphs = splitParagraphs(parsed.digestExtended);
  const wordCount = countWords(parsed.digestExtended);
  const combinedLength = `${parsed.digestTitle}\n\n${parsed.digestText}`.length;
  const isDaily = profile.kind === "daily";
  const minWords = isDaily ? 150 : 250;
  const maxWords = isDaily ? 280 : 400;
  const minParagraphs = isDaily ? 3 : 4;
  const maxParagraphs = isDaily ? 4 : 6;

  if (parsed.usedRawTextFallback) {
    issues.push({ code: "raw-text-fallback", severity: "hard", message: "Model response was not valid digest JSON." });
  }
  if (parsed.forbiddenPhraseHits.length > 0) {
    issues.push({
      code: "forbidden-phrase",
      severity: "soft",
      message: `Copy contains forbidden throat-clearing phrase(s): ${parsed.forbiddenPhraseHits.map((phrase) => phrase.trim()).join(", ")}.`,
    });
  }
  if (!parsed.digestTitle.trim()) {
    issues.push({ code: "missing-title", severity: "hard", message: "Title is missing." });
  }
  if (!parsed.digestText.trim()) {
    issues.push({ code: "missing-text", severity: "hard", message: "Text hook is missing." });
  }
  if (!parsed.digestExtended.trim()) {
    issues.push({ code: "missing-extended", severity: "hard", message: "Extended digest is missing." });
  }
  if (/```/.test(`${parsed.digestTitle}\n${parsed.digestText}\n${parsed.digestExtended}`)) {
    issues.push({ code: "code-fence", severity: "hard", message: "Output contains a markdown code fence." });
  }
  if (
    profile.forbidSafetyClaims &&
    findDigestSafetyClaimMarkers({
      title: parsed.digestTitle,
      text: parsed.digestText,
      extended: parsed.digestExtended,
    }).length > 0
  ) {
    issues.push({
      code: "unbound-safety-copy",
      severity: "hard",
      message: "Copy references an unavailable canonical input; omit that topic entirely.",
    });
  }
  if (combinedLength > 270) {
    issues.push({ code: "tweet-too-long", severity: "hard", message: `Title + text is ${combinedLength} characters, above 270.` });
  }
  if (titleWords < 2 || titleWords > (isDaily ? 6 : 8)) {
    issues.push({ code: "title-word-count", severity: "soft", message: `Title has ${titleWords} words.` });
  }
  if (paragraphs.length < minParagraphs || paragraphs.length > maxParagraphs) {
    issues.push({
      code: "paragraph-count",
      severity: paragraphs.length === 0 ? "hard" : "soft",
      message: `Extended digest has ${paragraphs.length} paragraphs; expected ${minParagraphs}-${maxParagraphs}.`,
    });
  }
  if (wordCount < minWords || wordCount > maxWords) {
    issues.push({
      code: "extended-word-count",
      severity: wordCount < Math.floor(minWords * 0.65) || wordCount > Math.ceil(maxWords * 1.35) ? "hard" : "soft",
      message: `Extended digest has ${wordCount} words; expected ${minWords}-${maxWords}.`,
    });
  }

  const tics = findForbiddenTics(parsed.digestText, parsed.digestExtended);
  if (tics.length > 0) {
    issues.push({
      code: "forbidden-tic",
      severity: "soft",
      message: `Output contains house-style tic(s): ${tics.join(", ")}. Rewrite without them.`,
    });
  }

  if (!hasForwardLook(`${parsed.digestText}\n${parsed.digestExtended}`)) {
    issues.push({
      code: "missing-forward-look",
      severity: "soft",
      message: "Digest lacks a forward-look cue (watch for…, if X happens…, next trigger…).",
    });
  }

  const parsedMeta = parsed.digestMeta ? JSON.parse(parsed.digestMeta) as Record<string, unknown> : null;
  const recent = profile.recentMeta ?? [];

  issues.push(...validateDigestLeadRequirements({
    parsedMeta,
    digestTitle: parsed.digestTitle,
    digestText: parsed.digestText,
    digestExtended: parsed.digestExtended,
    leadRequirements: profile.leadRequirements,
  }));

  const currentFingerprint = openingFingerprint(parsed.digestExtended);
  if (currentFingerprint) {
    const recentFingerprints = recent
      .slice(0, 3)
      .map((entry) => {
        const source = entry.rawText ?? entry.title ?? "";
        return openingFingerprint(source);
      })
      .filter((fp): fp is string => !!fp);
    const matchCount = recentFingerprints.filter((fp) => fp === currentFingerprint).length;
    if (matchCount >= 2) {
      issues.push({
        code: "opening-pattern-repetition",
        severity: "soft",
        message: `Opening fingerprint '${currentFingerprint}' matches ${matchCount} of last 3 digests; open differently.`,
      });
    } else if (currentFingerprint === "psi-verb" && matchCount >= 1) {
      issues.push({
        code: "opening-pattern-repetition",
        severity: "soft",
        message: "PSI-verb opening repeats; the lead should surface a candidate fact first.",
      });
    }
  }
  const titleFingerprint = normalizeTitleFingerprint(parsed.digestTitle);
  const dedupeTitles = [
    ...recent.map((entry) => entry.title),
    ...(profile.recentTitles ?? []),
  ].filter((title): title is string => Boolean(title));
  if (titleFingerprint && dedupeTitles.some((title) => normalizeTitleFingerprint(title) === titleFingerprint)) {
    issues.push({ code: "repeated-title", severity: "soft", message: "Title repeats a recent digest title." });
  }

  // Title anti-monotony: the same coin in three consecutive titles, and
  // day/hour-count constructions on a repeat-coverage coin, were the visible
  // face of the July 2026 streak ("USX at Day Twenty-Six" et al).
  const currentTitleSymbols = titleSymbols(parsed.digestTitle);
  if (currentTitleSymbols.length > 0) {
    const lastTwoTitles = recent.slice(0, 2).map((entry) => entry.title ?? "");
    const streakSymbol = currentTitleSymbols.find(
      (symbol) => lastTwoTitles.length === 2 && lastTwoTitles.every((title) => titleSymbols(title).includes(symbol)),
    );
    if (streakSymbol) {
      issues.push({
        code: "title-symbol-streak",
        severity: "soft",
        message: `${streakSymbol} appears in three consecutive titles; rotate the headline subject.`,
      });
    }
    const repeatCoverageSymbol = currentTitleSymbols.find((symbol) =>
      lastTwoTitles.some((title) => titleSymbols(title).includes(symbol)),
    );
    if (repeatCoverageSymbol && DURATION_TITLE_PATTERN.test(parsed.digestTitle)) {
      issues.push({
        code: "title-day-counting",
        severity: "soft",
        message: `Title counts elapsed time on repeat coverage of ${repeatCoverageSymbol}; elapsed time alone is not news.`,
      });
    }
  }

  const lead = getMetaString(parsedMeta, "lead");
  const tone = getMetaString(parsedMeta, "tone");
  const coins = getMetaCoins(parsedMeta);
  const recentThree = recent.slice(0, 3);
  const currentFamily = leadFamily(lead ?? undefined);
  if (currentFamily && currentFamily !== "other") {
    const recentFamilies = recentThree
      .map((entry) => leadFamily(getMetaString(entry.meta, "lead") ?? undefined))
      .filter((f): f is LeadFamily => f != null && f !== "other");
    const sameFamilyCount = recentFamilies.filter((f) => f === currentFamily).length;
    if (sameFamilyCount >= 2) {
      issues.push({
        code: "repeated-lead-family",
        severity: "soft",
        message: `Lead family '${currentFamily}' repeats ${sameFamilyCount} of last 3 digests.`,
      });
    }
  }
  if (tone && recentThree.some((entry) => getMetaString(entry.meta, "tone") === tone)) {
    issues.push({ code: "repeated-tone", severity: "soft", message: `Tone repeats recent tone '${tone}'.` });
  }
  const recentFive = recent.slice(0, 5);
  if (tone) {
    const sameToneCount = recentFive.filter((entry) => getMetaString(entry.meta, "tone") === tone).length;
    if (sameToneCount >= 3) {
      issues.push({
        code: "tone-cluster",
        severity: "soft",
        message: `Tone '${tone}' appeared ${sameToneCount} times in last 5 digests; pick a different register.`,
      });
    }
  }
  if (coins.length > 0) {
    const recentCoins = new Set(recentThree.flatMap((entry) => getMetaCoins(entry.meta)));
    if (coins.some((coin) => recentCoins.has(coin))) {
      issues.push({ code: "repeated-primary-coin", severity: "soft", message: "Featured coin overlaps with recent digests." });
    }
    // meta.coins is self-reported; the variety machinery validates whatever
    // labels the model declares. Cross-check the labels against the copy so
    // declared-but-absent coins are caught.
    const copyUpper = `${parsed.digestTitle}\n${parsed.digestText}\n${parsed.digestExtended}`.toUpperCase();
    const ghostCoins = coins.filter((coin) => !copyUpper.includes(coin.toUpperCase()));
    if (ghostCoins.length > 0) {
      issues.push({
        code: "meta-coins-mismatch",
        severity: "soft",
        message: `meta.coins lists ${ghostCoins.join(", ")} but the copy never mentions ${ghostCoins.length === 1 ? "it" : "them"}.`,
      });
    }
  }

  const fullCopy = `${parsed.digestTitle}\n${parsed.digestText}\n${parsed.digestExtended}`;
  if (profile.depegFacts && profile.depegFacts.length > 0) {
    issues.push(...lintPriceBpsConsistency(fullCopy, profile.depegFacts));
  }
  if (profile.prevDepegFacts && profile.prevDepegFacts.length > 0) {
    issues.push(...lintMovementClaims(fullCopy, profile.prevDepegFacts));
  }

  return issues;
}

const LINT_PRICE_BPS_TOLERANCE = 150;

function sentenceMentionsSymbol(sentence: string, symbol: string): boolean {
  return sentence
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .includes(symbol.toUpperCase());
}

/**
 * Price/bps consistency lint. The July 2026 corpus shipped "5,783 bps below
 * peg" beside "$0.997" in one sentence — the peak and the live price from two
 * different fields, laundered into a contradiction. Any sentence that quotes a
 * coin's dollar price AND a bps figure must have the two agree.
 */
function lintPriceBpsConsistency(
  copy: string,
  facts: readonly DigestDepegFact[],
): DigestValidationIssue[] {
  const issues: DigestValidationIssue[] = [];
  const sentences = copy.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const priceMatch = sentence.match(/\$([\d.]+)/);
    const bpsMatch = sentence.match(/([0-9][\d,]*) ?(?:bps|basis points)/i);
    if (!priceMatch || !bpsMatch) continue;
    const fact = facts.find(
      (entry) =>
        entry.currentPriceUsd != null && entry.currentBps != null && sentenceMentionsSymbol(sentence, entry.symbol),
    );
    if (!fact || fact.currentPriceUsd == null || fact.currentBps == null) continue;
    const quotedPrice = Number(priceMatch[1]);
    const quotedBps = Number(bpsMatch[1].replaceAll(",", ""));
    if (!Number.isFinite(quotedPrice) || !Number.isFinite(quotedBps) || quotedPrice <= 0) continue;
    // Recover the peg reference from the fact so non-USD pegs stay lintable.
    const pegReference = fact.currentPriceUsd / (1 + fact.currentBps / 10_000);
    if (!Number.isFinite(pegReference) || pegReference <= 0) continue;
    const impliedBps = Math.abs(((quotedPrice - pegReference) / pegReference) * 10_000);
    // Prices quoted to fewer decimals than the deviation warrants are fine;
    // only a genuine cross-field contradiction should fire.
    if (Math.abs(impliedBps - quotedBps) > LINT_PRICE_BPS_TOLERANCE) {
      issues.push({
        code: "price-bps-mismatch",
        severity: "soft",
        message: `${fact.symbol}: quoted price $${quotedPrice} implies ~${Math.round(impliedBps)} bps but the copy claims ${quotedBps} bps.`,
      });
    }
  }
  return issues;
}

/**
 * Movement-claim lint: "narrowed/widened from N bps" must trace to a number
 * that actually existed in the previous edition's depeg facts (the Jul 16
 * edition invented "narrowed from 3,650 yesterday" when both days read 3,159).
 */
function lintMovementClaims(
  copy: string,
  prevFacts: readonly DigestDepegFact[],
): DigestValidationIssue[] {
  if (prevFacts.length === 0) return [];
  const issues: DigestValidationIssue[] = [];
  const knownPrevBps = prevFacts
    .flatMap((fact) => [fact.currentBps, fact.bps, fact.peakBps])
    .filter((value): value is number => typeof value === "number")
    .map((value) => Math.abs(value));
  for (const match of copy.matchAll(/\b(?:narrowed|widened|worsened|improved|tightened)\b[^.!?]{0,60}?\bfrom\s+([0-9][\d,]*)\s*(?:bps|basis points)/gi)) {
    const claimedOrigin = Number(match[1].replaceAll(",", ""));
    if (!Number.isFinite(claimedOrigin)) continue;
    const supported = knownPrevBps.some((value) => Math.abs(value - claimedOrigin) <= LINT_PRICE_BPS_TOLERANCE);
    if (!supported) {
      issues.push({
        code: "unverifiable-movement-claim",
        severity: "soft",
        message: `Copy claims movement "from ${claimedOrigin} bps" but no previous-edition depeg fact is near that value.`,
      });
    }
  }
  return issues;
}

const DURATION_TITLE_PATTERN =
  /\b(?:day|hour|week|month|morning)s?\b/i;

function titleSymbols(title: string): string[] {
  return [...title.matchAll(/\b[A-Z][A-Z0-9]{1,9}\b/g)].map((match) => match[0]);
}

export function hasBlockingDigestQualityIssues(issues: readonly DigestValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "hard");
}

export function formatDigestValidationIssues(issues: readonly DigestValidationIssue[]): string {
  return issues.map((issue) => `${issue.code}(${issue.severity}): ${issue.message}`).join("; ");
}
