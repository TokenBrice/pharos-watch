import { DigestResponseSchema } from "../../lib/schemas";
import { leadFamily } from "./voice-guards";

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
  strippedForbiddenCharCount: number;
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
  }>;
}

export interface DigestModelResponseParseOptions {
  metaFactory?: (options: {
    parsedMeta: Record<string, unknown> | null;
    usedRawTextFallback: boolean;
  }) => Record<string, unknown> | null;
}

function stripForbiddenPhrases(value: string): string {
  let result = value;
  for (const phrase of FORBIDDEN_PHRASES) {
    result = result.replaceAll(phrase, "");
  }
  return result;
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

function normalizeStringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)
    .slice(0, maxItems);
  return cleaned.length > 0 ? cleaned : undefined;
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
    console.warn(`[daily-digest] Failed to parse digest model response, using raw text fallback: ${err instanceof Error ? err.message : String(err)}`);
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

  const forbiddenBefore = [digestText, digestExtended].join("").length;
  digestText = stripForbiddenPhrases(digestText);
  digestExtended = stripForbiddenPhrases(digestExtended);
  const strippedForbiddenCharCount = forbiddenBefore - [digestText, digestExtended].join("").length;

  return {
    digestTitle,
    digestText,
    digestExtended,
    digestMeta,
    strippedDashCount,
    strippedForbiddenCharCount,
    usedRawTextFallback,
  };
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function countTitleWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function splitParagraphs(value: string): string[] {
  return value.split(/\r?\n\s*\r?\n/g).map((paragraph) => paragraph.trim()).filter(Boolean);
}

function normalizeTitleFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function getMetaString(meta: Record<string, unknown> | null, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  const titleWords = countTitleWords(parsed.digestTitle);
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

  const parsedMeta = parsed.digestMeta ? JSON.parse(parsed.digestMeta) as Record<string, unknown> : null;
  const recent = profile.recentMeta ?? [];
  const titleFingerprint = normalizeTitleFingerprint(parsed.digestTitle);
  if (titleFingerprint && recent.some((entry) => entry.title && normalizeTitleFingerprint(entry.title) === titleFingerprint)) {
    issues.push({ code: "repeated-title", severity: "soft", message: "Title repeats a recent digest title." });
  }

  const lead = getMetaString(parsedMeta, "lead");
  const tone = getMetaString(parsedMeta, "tone");
  const coins = getMetaCoins(parsedMeta);
  const recentThree = recent.slice(0, 3);
  const currentFamily = leadFamily(lead ?? undefined);
  if (currentFamily && currentFamily !== "other") {
    const recentFamilies = recentThree
      .map((entry) => leadFamily(getMetaString(entry.meta, "lead") ?? undefined))
      .filter((f): f is string => f != null && f !== "other");
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
  if (coins.length > 0) {
    const recentCoins = new Set(recentThree.flatMap((entry) => getMetaCoins(entry.meta)));
    if (coins.some((coin) => recentCoins.has(coin))) {
      issues.push({ code: "repeated-primary-coin", severity: "soft", message: "Featured coin overlaps with recent digests." });
    }
  }

  return issues;
}

export function hasBlockingDigestQualityIssues(issues: readonly DigestValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "hard");
}

export function formatDigestValidationIssues(issues: readonly DigestValidationIssue[]): string {
  return issues.map((issue) => `${issue.code}(${issue.severity}): ${issue.message}`).join("; ");
}
