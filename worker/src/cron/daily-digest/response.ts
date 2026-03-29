import { DigestResponseSchema } from "../../lib/schemas";

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
    if (parsed.meta) {
      parsedMeta = parsed.meta as Record<string, unknown>;
    }
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
