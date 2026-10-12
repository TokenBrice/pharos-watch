/**
 * Heavy-profile review stages: an evidence audit of the drafted edition and a
 * revision brief. The deterministic validators stay the publication authority;
 * this module only builds prompts and parses the auditor's verdicts.
 */
import { z } from "zod";
import { tryParseJson } from "../../lib/json-parse";
import type { DigestValidationIssue, DigestValidationProfile } from "../daily-digest/response";

export const DIGEST_AUDIT_SYSTEM_PROMPT = `You are the fact-check desk for Pharos, a stablecoin analytics publication. You receive the exact evidence packet the writer received and the writer's draft edition. Audit the draft claim by claim against the evidence ONLY (no outside knowledge).

For every factual claim (numbers, directions, comparisons, rankings, durations, causes, implications) decide:
- supported: directly stated in or arithmetically derivable from the evidence
- unsupported: not in the evidence (including causes not in CAUSE CONTEXT)
- contradicted: conflicts with the evidence
- misleading: technically supported but framed to imply something the evidence does not show

Recurring misleading patterns to check every time:
- a token-supply decline described as a burn, redemption, or outflow when the evidence has no mint/burn or flow data for that coin
- a market-wide aggregate (Bank Run Gauge, PSI, total supply) attributed to specific coins without evidence of their contribution
- a known subtotal or partial-coverage figure described as the whole market
- an armed next-trigger threshold described as an observed value, or a displayed top-N subset described as a population
- a date or window misread (e.g. "a week ago" pointing at the wrong day of a trajectory)

Also list editorial problems a demanding editor would flag (weak or wrong lead choice given the candidates, missed bigger story, vague forward-look, filler). Be precise and terse. Do not rewrite the edition and do not flag house-style choices.

Return ONLY JSON: {"claims":[{"claim":"...","verdict":"supported|unsupported|contradicted|misleading","evidence":"quote or calculation","fix":"..."}],"editorial":[{"issue":"...","fix":"..."}]}`;

const AuditClaimSchema = z.object({
  claim: z.string(),
  verdict: z.enum(["supported", "unsupported", "contradicted", "misleading"]),
  evidence: z.string().optional().default(""),
  fix: z.string().optional().default(""),
});
const AuditEditorialSchema = z.object({ issue: z.string(), fix: z.string().optional().default("") });
const DigestAuditSchema = z.object({
  claims: z.array(AuditClaimSchema),
  editorial: z.array(AuditEditorialSchema).optional().default([]),
});
export type DigestAudit = z.output<typeof DigestAuditSchema>;
export type DigestAuditClaim = DigestAudit["claims"][number];

/** Parse the auditor's JSON; null when it is missing or malformed. */
export function parseDigestAudit(rawText: string): DigestAudit | null {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const decoded = tryParseJson(rawText.slice(start, end + 1), { onFailure: () => undefined });
  const parsed = DigestAuditSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

export interface DigestDraftCopy {
  title: string;
  text: string;
  extended: string;
  meta: Record<string, unknown> | null;
}

function serializeDigestDraft(draft: DigestDraftCopy): string {
  const meta = draft.meta;
  return JSON.stringify({
    title: draft.title,
    text: draft.text,
    extended: draft.extended,
    meta: meta && {
      leadSignalId: meta.leadSignalId,
      lead: meta.lead,
      tone: meta.tone,
      coins: meta.coins,
    },
  });
}

export function buildDigestAuditPrompt(userPrompt: string, draft: DigestDraftCopy): string {
  return `EVIDENCE PACKET (what the writer saw):\n\n${userPrompt}\n\n---\nDRAFT:\n${serializeDigestDraft(draft)}`;
}

function auditProblems(audit: DigestAudit): DigestAuditClaim[] {
  return audit.claims.filter((claim) => claim.verdict !== "supported");
}

/** True when the audit or the validators gave the writer something to fix. */
export function digestNeedsRevision(audit: DigestAudit, draftIssues: readonly DigestValidationIssue[]): boolean {
  return auditProblems(audit).length > 0 || audit.editorial.length > 0 || draftIssues.length > 0;
}

const RECENT_EDITION_LIMIT = 7;

export function buildDigestRevisionPrompt(options: {
  userPrompt: string;
  draft: DigestDraftCopy;
  audit: DigestAudit;
  draftIssues: readonly DigestValidationIssue[];
  recentMeta?: DigestValidationProfile["recentMeta"];
}): string {
  // The writer otherwise sees only prior titles/leads/tones; the repetition
  // validators read prior bodies, so the reviser gets the same bodies.
  const recent = (options.recentMeta ?? [])
    .filter((entry) => entry.extended)
    .slice(0, RECENT_EDITION_LIMIT)
    .map((entry) => `[${entry.title ?? "untitled"}]\n${entry.extended}`);
  return [
    options.userPrompt,
    "",
    ...(recent.length > 0
      ? [
          "RECENT PUBLISHED EDITIONS (full bodies, newest first) — avoid reusing their structure, openings, and phrasing:",
          ...recent,
          "",
        ]
      : []),
    "REVISION TASK:",
    "Below is a draft of this edition, a fact-check audit of it, and automated validator notes. Produce the final edition.",
    "- Fix every unsupported, contradicted, or misleading claim (correct it from the evidence or remove it).",
    "- Address editorial notes where you agree; you may change the lead if the audit shows a stronger unsuppressed candidate, but REQUIRED LEAD/MENTION rules still bind.",
    "- Resolve validator notes where possible. Repeating a coin that today's evidence or a required lead makes unavoidable is acceptable.",
    "- Keep the same JSON schema and all constraints from the system prompt. Return ONLY the JSON.",
    "",
    `DRAFT:\n${serializeDigestDraft(options.draft)}`,
    "",
    `AUDIT FINDINGS:\n${JSON.stringify({ problems: auditProblems(options.audit), editorial: options.audit.editorial })}`,
    "",
    `VALIDATOR NOTES:\n${options.draftIssues.map((issue) => `${issue.code}(${issue.severity}): ${issue.message}`).join("\n") || "none"}`,
  ].join("\n");
}

export type DigestHeavyOutcome =
  | "revised"
  | "audit-clean"
  | "draft-kept-revision-worse"
  | "draft-kept-revision-unparseable"
  | "skipped-draft-unparseable"
  | "skipped-time-budget"
  | "skipped-token-budget"
  | "audit-unparseable"
  | "audit-refused"
  | "audit-failed"
  | "revise-refused"
  | "revise-failed";

const FINDING_LIMIT = 12;
const FINDING_TEXT_LIMIT = 240;

export interface DigestHeavyAuditSummary {
  claimCount: number;
  verdicts: Record<DigestAuditClaim["verdict"], number>;
  editorialNoteCount: number;
  findings: { verdict: DigestAuditClaim["verdict"]; claim: string; fix: string }[];
  findingsTruncated: boolean;
}

export interface DigestHeavyTelemetry {
  outcome: DigestHeavyOutcome;
  audit: DigestHeavyAuditSummary | null;
  /** The pre-revision draft, kept only when the revision replaced it. */
  draft: { title: string; text: string; extended: string; qualityIssueCodes: string[] } | null;
}

export function summarizeDigestAudit(audit: DigestAudit): DigestHeavyAuditSummary {
  const verdicts = { supported: 0, unsupported: 0, contradicted: 0, misleading: 0 };
  for (const claim of audit.claims) verdicts[claim.verdict] += 1;
  const problems = auditProblems(audit);
  return {
    claimCount: audit.claims.length,
    verdicts,
    editorialNoteCount: audit.editorial.length,
    findings: problems.slice(0, FINDING_LIMIT).map((claim) => ({
      verdict: claim.verdict,
      claim: claim.claim.slice(0, FINDING_TEXT_LIMIT),
      fix: claim.fix.slice(0, FINDING_TEXT_LIMIT),
    })),
    findingsTruncated: problems.length > FINDING_LIMIT,
  };
}
