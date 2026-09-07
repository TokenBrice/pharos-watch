import {
  AI_SUMMARY_CLAIM_REGISTRY,
  type AiSummaryClaimToken,
  type AiSummaryClaimTokenName,
  type AiSummaryClaimValues,
} from "../types/editorial";

export interface AiSummaryClaimIssue {
  code: "duplicate-token" | "invalid-facts-as-of" | "placeholder-count" | "unregistered-placeholder" | "wrong-registration";
  token?: string;
}

export interface ResolvedAiSummaryClaims {
  text: string;
  factsAsOf: string[];
  issues: AiSummaryClaimIssue[];
}

const CLAIM_PLACEHOLDER_PATTERN = /\{\{(?:grade|score|supplyUsd)\}\}/g;
const ISO_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function formatSupplyUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "N/A";
  const scales = [
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" },
  ] as const;
  const scale = scales.find((candidate) => value >= candidate.threshold);
  if (!scale) return `$${Math.round(value).toLocaleString("en-US")}`;
  const scaled = value / scale.threshold;
  const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `$${scaled.toFixed(precision).replace(/\.0+$|(?<=\.[0-9])0+$/, "")}${scale.suffix}`;
}

function formatClaimValue(token: AiSummaryClaimTokenName, value: string | number | null | undefined): string {
  if (value == null) return "N/A";
  // These are closed enum dispatches, not comparisons of secrets.
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (token === "supplyUsd") return typeof value === "number" ? formatSupplyUsd(value) : "N/A";
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (token === "score") {
    return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "N/A";
  }
  return typeof value === "string" && /^(?:A\+|A-|A|B\+|B-|B|C\+|C-|C|D\+|D-|D|F)$/.test(value)
    ? value
    : "N/A";
}

export function validateAiSummaryClaimTokens(
  text: string,
  tokens: readonly AiSummaryClaimToken[] | undefined,
): AiSummaryClaimIssue[] {
  const issues: AiSummaryClaimIssue[] = [];
  const seen = new Set<string>();
  const declaredPlaceholders = new Set<string>();

  for (const claim of tokens ?? []) {
    const registration = AI_SUMMARY_CLAIM_REGISTRY[claim.token];
    if (
      !registration ||
      claim.placeholder !== registration.placeholder ||
      !(registration.sources as readonly string[]).includes(claim.source)
    ) {
      issues.push({ code: "wrong-registration", token: claim.token });
      continue;
    }
    if (seen.has(claim.token)) issues.push({ code: "duplicate-token", token: claim.token });
    seen.add(claim.token);
    declaredPlaceholders.add(claim.placeholder);
    const day = ISO_DAY_PATTERN.exec(claim.factsAsOf);
    const timestamp = day
      ? Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
      : Number.NaN;
    if (
      !Number.isFinite(timestamp)
      || new Date(timestamp).toISOString().slice(0, 10) !== claim.factsAsOf
    ) {
      issues.push({ code: "invalid-facts-as-of", token: claim.token });
    }
    if (text.split(claim.placeholder).length - 1 !== 1) {
      issues.push({ code: "placeholder-count", token: claim.token });
    }
  }

  for (const placeholder of text.match(CLAIM_PLACEHOLDER_PATTERN) ?? []) {
    if (!declaredPlaceholders.has(placeholder)) {
      issues.push({ code: "unregistered-placeholder", token: placeholder });
    }
  }

  return issues;
}

export function resolveAiSummaryClaims(
  text: string,
  tokens: readonly AiSummaryClaimToken[] | undefined,
  values: AiSummaryClaimValues = {},
): ResolvedAiSummaryClaims {
  const issues = validateAiSummaryClaimTokens(text, tokens);
  const invalidTokens = new Set(issues.map((issue) => issue.token).filter((token): token is string => !!token));
  let resolvedText = text;
  const factsAsOf = new Set<string>();

  for (const claim of tokens ?? []) {
    if (invalidTokens.has(claim.token)) continue;
    resolvedText = resolvedText.replace(
      claim.placeholder,
      formatClaimValue(claim.token, values[claim.source]),
    );
    factsAsOf.add(claim.factsAsOf);
  }
  // Fail closed: an unregistered or malformed token must never render the
  // internal placeholder syntax, so unresolved placeholders resolve to the
  // same N/A sentinel as a missing live value.
  resolvedText = resolvedText.replace(CLAIM_PLACEHOLDER_PATTERN, "N/A");

  return { text: resolvedText, factsAsOf: [...factsAsOf].sort(), issues };
}
