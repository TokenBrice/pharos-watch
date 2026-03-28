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

export function parseDigestModelResponse(rawText: string): ParsedDigestResponse {
  const parsedJson = extractDigestJson(rawText);

  let digestTitle: string;
  let digestText: string;
  let digestExtended: string;
  let digestMeta: string | null = null;
  let usedRawTextFallback = false;

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
      digestMeta = JSON.stringify(parsed.meta);
    }
  } catch {
    digestTitle = "";
    digestText = rawText.trim();
    digestExtended = "";
    digestMeta = null;
    usedRawTextFallback = true;
  }

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
